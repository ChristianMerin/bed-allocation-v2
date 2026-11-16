const mongoose = require('mongoose');
const { Bed, Ward, BedActivity, PriceChange } = require('../models');
const AppError = require('../utils/AppError');
const { createBeds } = require('./bedService');
const { parseRate, assertCategory, buildRateResolver, getEffectiveRate } = require('./rateService');
const { CATEGORY_RULES, BED_STATUS } = require('../config/constants');

/*
 * A "room" is the group of beds that share a ward + room number.
 * All beds in a room have the same class and (normally) the same price.
 */

const toFeatureList = (f) => (Array.isArray(f) ? f : String(f || '').split(','))
  .map((x) => String(x).trim().toLowerCase()).filter(Boolean);

async function getWard(wardId) {
  if (!mongoose.isValidObjectId(wardId)) throw new AppError('Invalid ward id', 400);
  const ward = await Ward.findById(wardId);
  if (!ward || !ward.isActive) throw new AppError('Ward not found', 404);
  return ward;
}

async function getRoomBeds(wardId, roomNumber) {
  const beds = await Bed.find({ ward: wardId, roomNumber, isActive: true }).sort({ bedNumber: 1 });
  if (!beds.length) throw new AppError(`Room ${roomNumber} not found`, 404);
  return beds;
}

async function listRooms({ wardId, category } = {}) {
  const match = { isActive: true };
  if (wardId) {
    if (!mongoose.isValidObjectId(wardId)) throw new AppError('Invalid ward id', 400);
    match.ward = new mongoose.Types.ObjectId(String(wardId));
  }
  if (category) { assertCategory(category); match.category = category; }

  const [rows, { resolve }] = await Promise.all([
    Bed.aggregate([
      { $match: match },
      { $sort: { bedNumber: 1 } },
      {
        $group: {
          _id: { ward: '$ward', roomNumber: '$roomNumber' },
          category: { $first: '$category' },
          features: { $first: '$features' },
          minRate: { $min: '$dailyRate' },
          maxRate: { $max: '$dailyRate' },
          beds: { $push: { _id: '$_id', bedNumber: '$bedNumber', status: '$status', dailyRate: '$dailyRate' } },
        },
      },
      { $lookup: { from: 'ipd_wards', localField: '_id.ward', foreignField: '_id', as: 'ward' } },
      { $unwind: '$ward' },
      { $match: { 'ward.isActive': true } },
    ]),
    buildRateResolver(),
  ]);

  const count = (beds, s) => beds.filter((b) => b.status === s).length;
  return rows.map((r) => {
    const cardRate = resolve(r.ward._id, r.category).dailyRate;
    const uniform = r.minRate === r.maxRate;
    return {
      wardId: r.ward._id,
      wardCode: r.ward.code,
      wardName: r.ward.name,
      roomNumber: r._id.roomNumber,
      category: r.category,
      capacity: CATEGORY_RULES[r.category].maxBedsPerRoom,
      bedCount: r.beds.length,
      occupied: count(r.beds, BED_STATUS.OCCUPIED),
      reserved: count(r.beds, BED_STATUS.RESERVED),
      available: count(r.beds, BED_STATUS.AVAILABLE),
      dailyRate: uniform ? r.minRate : null,
      minRate: r.minRate,
      maxRate: r.maxRate,
      cardRate,
      customPrice: !(uniform && r.minRate === cardRate),
      features: r.features || [],
      beds: r.beds,
    };
  }).sort((a, b) => a.wardCode.localeCompare(b.wardCode) || a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
}

async function getRoom(wardId, roomNumber) {
  const rooms = await listRooms({ wardId });
  const room = rooms.find((r) => r.roomNumber === roomNumber);
  if (!room) throw new AppError(`Room ${roomNumber} not found`, 404);
  return room;
}

/** POST /rooms { wardId, roomNumber, category, beds, dailyRate?, features? } */
async function createRoom(input, actor) {
  const ward = await getWard(input.wardId);
  const roomNumber = String(input.roomNumber || '').trim().toUpperCase();
  if (!roomNumber) throw new AppError('roomNumber is required', 400);
  if (!/^[A-Z0-9-]{1,10}$/.test(roomNumber)) throw new AppError('roomNumber may only contain letters, numbers and "-" (max 10)', 400);
  assertCategory(input.category);
  if (await Bed.exists({ ward: ward._id, roomNumber, isActive: true })) {
    throw new AppError(`Room ${roomNumber} already exists in ${ward.name}. Use "Add bed" instead.`, 409);
  }
  const count = parseInt(input.beds ?? input.count, 10) || 1;
  await createBeds({
    wardId: ward._id,
    roomNumber,
    category: input.category,
    count,
    dailyRate: input.dailyRate === '' || input.dailyRate === undefined || input.dailyRate === null ? undefined : parseRate(input.dailyRate),
    features: toFeatureList(input.features),
  }, actor);
  return getRoom(ward._id, roomNumber);
}

/** Adds beds to an existing room, copying its class, price and features. */
async function addBedsToRoom(wardId, roomNumber, input, actor) {
  const ward = await getWard(wardId);
  const beds = await getRoomBeds(ward._id, roomNumber);
  await createBeds({
    wardId: ward._id,
    roomNumber,
    category: beds[0].category,
    count: parseInt(input.count, 10) || 1,
    dailyRate: beds[0].dailyRate,
    features: beds[0].features,
  }, actor);
  return getRoom(ward._id, roomNumber);
}

/** PATCH /rooms/:wardId/:roomNumber { dailyRate?, features?, category?, useRateCard? } */
async function updateRoom(wardId, roomNumber, input, actor) {
  const ward = await getWard(wardId);
  const beds = await getRoomBeds(ward._id, roomNumber);
  const current = beds[0];
  const set = {};
  const notes = [];

  if (input.category && input.category !== current.category) {
    assertCategory(input.category);
    if (beds.some((b) => [BED_STATUS.OCCUPIED, BED_STATUS.RESERVED].includes(b.status))) {
      throw new AppError('Room class can only be changed when no bed in the room is occupied or reserved', 409);
    }
    const max = CATEGORY_RULES[input.category].maxBedsPerRoom;
    if (beds.length > max) {
      throw new AppError(`A ${input.category} room holds at most ${max} bed(s); this room has ${beds.length}. Remove beds first.`, 422);
    }
    set.category = input.category;
    notes.push(`class ${current.category} -> ${input.category}`);
  }

  const category = set.category || current.category;
  if (input.useRateCard) {
    set.dailyRate = await getEffectiveRate(ward._id, category);
  } else if (input.dailyRate !== undefined && input.dailyRate !== '') {
    set.dailyRate = parseRate(input.dailyRate);
  } else if (set.category) {
    set.dailyRate = await getEffectiveRate(ward._id, category); // new class -> its card price
  }

  if (input.features !== undefined) set.features = toFeatureList(input.features);
  if (!Object.keys(set).length) throw new AppError('Nothing to update', 400);

  const oldRates = [...new Set(beds.map((b) => b.dailyRate))];
  const priceChanged = set.dailyRate !== undefined && (oldRates.length > 1 || oldRates[0] !== set.dailyRate);
  if (priceChanged) notes.push(`price ${oldRates.join('/')} -> ${set.dailyRate}`);
  if (set.features) notes.push('features updated');

  const res = await Bed.updateMany({ ward: ward._id, roomNumber, isActive: true }, { $set: set });

  if (priceChanged) {
    await PriceChange.create({
      scope: 'room', ward: ward._id, wardName: ward.name, roomNumber, category,
      oldRate: oldRates[0], newRate: set.dailyRate, bedsUpdated: res.modifiedCount, note: input.note, actor,
    });
  }
  await BedActivity.insertMany(beds.map((b) => ({
    bed: b._id, bedNumber: b.bedNumber, ward: ward._id, action: 'updated', actor, note: `Room ${roomNumber}: ${notes.join(', ')}`,
  })));
  return getRoom(ward._id, roomNumber);
}

/** Removes (deactivates) a whole room. History is kept. */
async function removeRoom(wardId, roomNumber, actor) {
  const ward = await getWard(wardId);
  const beds = await getRoomBeds(ward._id, roomNumber);
  if (beds.some((b) => [BED_STATUS.OCCUPIED, BED_STATUS.RESERVED].includes(b.status))) {
    throw new AppError('Cannot remove a room that has an occupied or reserved bed', 409);
  }
  await Bed.updateMany({ _id: { $in: beds.map((b) => b._id) } }, { $set: { isActive: false } });
  await BedActivity.insertMany(beds.map((b) => ({
    bed: b._id, bedNumber: b.bedNumber, ward: ward._id, action: 'deactivated', actor, note: `Room ${roomNumber} removed`,
  })));
  return { wardId: ward._id, roomNumber, bedsRemoved: beds.length };
}

module.exports = { listRooms, getRoom, createRoom, addBedsToRoom, updateRoom, removeRoom };
