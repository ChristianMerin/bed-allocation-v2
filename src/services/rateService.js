const mongoose = require('mongoose');
const { RoomRate, PriceChange, Bed, Ward } = require('../models');
const AppError = require('../utils/AppError');
const { BED_CATEGORIES, CATEGORY_RULES } = require('../config/constants');

/*
 * Pricing model
 *   1. Hospital default rate per room class   (RoomRate with ward = null)
 *   2. Optional ward rate per room class       (RoomRate with ward = id), e.g. ICU Private
 *   3. Optional custom price on a single room  (stored on that room's beds)
 * New beds get the effective rate (2 -> 1). Each bed keeps its own dailyRate,
 * and an admission snapshots it, so price changes never alter a running bill.
 */

function parseRate(value) {
  const n = Number(value);
  if (value === '' || value === null || value === undefined || !Number.isFinite(n) || n < 0) {
    throw new AppError('dailyRate must be a number greater than or equal to 0', 400);
  }
  if (n > 10000000) throw new AppError('dailyRate is too large', 400);
  return Math.round(n * 100) / 100;
}

function assertCategory(category) {
  if (!BED_CATEGORIES.includes(category)) throw new AppError(`category must be one of: ${BED_CATEGORIES.join(', ')}`, 400);
}

/** Creates the hospital default rates the first time the service runs. */
async function ensureDefaultRates() {
  await Promise.all(BED_CATEGORIES.map((category) => RoomRate.updateOne(
    { ward: null, category },
    { $setOnInsert: { dailyRate: CATEGORY_RULES[category].defaultRate, updatedBy: 'system' } },
    { upsert: true }
  )));
}

/** Loads the whole rate card once and returns a lookup (wardId, category) -> rate info. */
async function buildRateResolver() {
  const rates = await RoomRate.find().lean();
  const defaults = {};
  const byWard = new Map();
  for (const r of rates) {
    if (!r.ward) defaults[r.category] = r;
    else byWard.set(`${r.ward}:${r.category}`, r);
  }
  const resolve = (wardId, category) => {
    const own = wardId ? byWard.get(`${wardId}:${category}`) : null;
    if (own) return { dailyRate: own.dailyRate, source: 'ward', rate: own };
    const def = defaults[category];
    return { dailyRate: def ? def.dailyRate : CATEGORY_RULES[category].defaultRate, source: 'default', rate: def || null };
  };
  return { resolve, defaults };
}

async function getEffectiveRate(wardId, category) {
  const { resolve } = await buildRateResolver();
  return resolve(wardId, category).dailyRate;
}

/** Rate card matrix for the UI: every ward x every room class. */
async function getRateCard() {
  const [{ resolve, defaults }, wards, bedStats] = await Promise.all([
    buildRateResolver(),
    Ward.find({ isActive: true }).sort({ code: 1 }).lean(),
    Bed.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: { ward: '$ward', category: '$category', rate: '$dailyRate' }, n: { $sum: 1 } } },
    ]),
  ]);

  const defaultsOut = Object.fromEntries(BED_CATEGORIES.map((c) => {
    const d = defaults[c];
    return [c, { rateId: d?._id || null, dailyRate: d ? d.dailyRate : CATEGORY_RULES[c].defaultRate, updatedAt: d?.updatedAt, updatedBy: d?.updatedBy }];
  }));

  const wardsOut = wards.map((w) => ({
    wardId: w._id,
    code: w.code,
    name: w.name,
    type: w.type,
    rates: Object.fromEntries(BED_CATEGORIES.map((c) => {
      const eff = resolve(w._id, c);
      const stats = bedStats.filter((s) => String(s._id.ward) === String(w._id) && s._id.category === c);
      return [c, {
        dailyRate: eff.dailyRate,
        source: eff.source,
        overrideId: eff.source === 'ward' ? eff.rate._id : null,
        beds: stats.reduce((sum, s) => sum + s.n, 0),
        customBeds: stats.filter((s) => s._id.rate !== eff.dailyRate).reduce((sum, s) => sum + s.n, 0),
      }];
    })),
  }));

  return { defaults: defaultsOut, wards: wardsOut };
}

/**
 * Sets the hospital default (wardId empty) or a ward's rate for a room class.
 * applyToExisting = true also re-prices the existing beds in that scope.
 */
async function setRate({ wardId, category, dailyRate, applyToExisting, note }, actor) {
  assertCategory(category);
  const rate = parseRate(dailyRate);

  let ward = null;
  if (wardId) {
    if (!mongoose.isValidObjectId(wardId)) throw new AppError('Invalid wardId', 400);
    ward = await Ward.findById(wardId);
    if (!ward) throw new AppError('Ward not found', 404);
  }

  const oldRate = await getEffectiveRate(ward?._id || null, category);
  await RoomRate.findOneAndUpdate(
    { ward: ward ? ward._id : null, category },
    { $set: { dailyRate: rate, updatedBy: actor?.name } },
    { upsert: true, returnDocument: 'after', runValidators: true }
  );

  let bedsUpdated = 0;
  if (applyToExisting) {
    let wardIds;
    if (ward) {
      wardIds = [ward._id];
    } else {
      // Hospital default only applies to wards without their own rate for this class
      const overridden = await RoomRate.distinct('ward', { ward: { $ne: null }, category });
      wardIds = await Ward.distinct('_id', { _id: { $nin: overridden } });
    }
    const res = await Bed.updateMany({ ward: { $in: wardIds }, category, isActive: true }, { $set: { dailyRate: rate } });
    bedsUpdated = res.modifiedCount;
  }

  await PriceChange.create({
    scope: ward ? 'ward-rate' : 'default-rate',
    ward: ward?._id,
    wardName: ward ? ward.name : 'Hospital default',
    category,
    oldRate,
    newRate: rate,
    bedsUpdated,
    note,
    actor,
  });
  return { bedsUpdated, card: await getRateCard() };
}

/** Removes a ward's own rate so the ward falls back to the hospital default. */
async function removeWardRate(rateId, { applyToExisting } = {}, actor) {
  if (!mongoose.isValidObjectId(rateId)) throw new AppError('Invalid rate id', 400);
  const r = await RoomRate.findById(rateId);
  if (!r) throw new AppError('Rate not found', 404);
  if (!r.ward) throw new AppError('The hospital default rate cannot be removed, only changed', 400);

  const ward = await Ward.findById(r.ward);
  await r.deleteOne();
  const fallback = await getEffectiveRate(null, r.category);

  let bedsUpdated = 0;
  if (applyToExisting) {
    const res = await Bed.updateMany({ ward: r.ward, category: r.category, isActive: true }, { $set: { dailyRate: fallback } });
    bedsUpdated = res.modifiedCount;
  }
  await PriceChange.create({
    scope: 'ward-rate-removed', ward: r.ward, wardName: ward?.name, category: r.category,
    oldRate: r.dailyRate, newRate: fallback, bedsUpdated, note: 'Ward rate removed, using hospital default', actor,
  });
  return { bedsUpdated, card: await getRateCard() };
}

async function getPriceHistory(limit = 50) {
  return PriceChange.find().sort({ createdAt: -1 }).limit(Math.min(limit, 200));
}

module.exports = {
  parseRate,
  assertCategory,
  ensureDefaultRates,
  buildRateResolver,
  getEffectiveRate,
  getRateCard,
  setRate,
  removeWardRate,
  getPriceHistory,
};
