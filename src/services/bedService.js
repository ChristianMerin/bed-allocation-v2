const mongoose = require('mongoose');
const { Bed, Ward, BedActivity } = require('../models');
const AppError = require('../utils/AppError');
const { logActivity } = require('./activityService');
const { parseRate, getEffectiveRate } = require('./rateService');
const env = require('../config/env');
const {
  BED_STATUS, BED_CATEGORIES, CATEGORY_RULES, MANUAL_STATUS_TRANSITIONS,
} = require('../config/constants');

function assertId(id, label = 'id') {
  if (!mongoose.isValidObjectId(id)) throw new AppError(`Invalid ${label}`, 400);
}

const bedLetter = (i) => (i < 26 ? String.fromCharCode(65 + i) : `B${i + 1}`);

/**
 * Creates one or more beds in a room, enforcing the category rules:
 *  - every bed in a room has the same category
 *  - private = 1 bed/room, semi-private = 2 beds/room, ward = up to 12
 * Bed numbers are generated as <WARDCODE>-<ROOM>-<LETTER>, e.g. SPW-402-B.
 */
async function createBeds(input, actor) {
  const { wardId, roomNumber, category, features = [] } = input;
  const count = parseInt(input.count, 10) || 1;
  assertId(wardId, 'wardId');
  if (!roomNumber) throw new AppError('roomNumber is required', 400);
  if (!BED_CATEGORIES.includes(category)) throw new AppError(`category must be one of: ${BED_CATEGORIES.join(', ')}`, 400);
  if (count < 1 || count > 50) throw new AppError('count must be between 1 and 50', 400);

  const ward = await Ward.findById(wardId);
  if (!ward || !ward.isActive) throw new AppError('Ward not found', 404);

  const roomBeds = await Bed.find({ ward: ward._id, roomNumber: String(roomNumber).trim(), isActive: true });
  if (roomBeds.length && roomBeds[0].category !== category) {
    throw new AppError(`Room ${roomNumber} already has ${roomBeds[0].category} beds. All beds in a room must share one category.`, 422);
  }
  const max = CATEGORY_RULES[category].maxBedsPerRoom;
  if (roomBeds.length + count > max) {
    throw new AppError(`A ${category} room holds at most ${max} bed(s); room ${roomNumber} already has ${roomBeds.length}.`, 422);
  }

  // Price: explicit value, otherwise the rate card (ward rate -> hospital default)
  const dailyRate = input.dailyRate !== undefined && input.dailyRate !== null && input.dailyRate !== ''
    ? parseRate(input.dailyRate)
    : await getEffectiveRate(ward._id, category);
  const featureList = Array.isArray(features) ? features : String(features).split(',').map((f) => f.trim()).filter(Boolean);

  // Find free letters (skip numbers already used, e.g. after a deactivated bed)
  const used = new Set((await Bed.find({ ward: ward._id, roomNumber: String(roomNumber).trim() }).select('bedNumber')).map((b) => b.bedNumber));
  const docs = [];
  for (let i = 0; docs.length < count; i++) {
    const bedNumber = (count === 1 && input.bedNumber && i === 0) ? String(input.bedNumber).toUpperCase() : `${ward.code}-${roomNumber}-${bedLetter(i)}`;
    if (used.has(bedNumber)) continue;
    used.add(bedNumber);
    docs.push({ bedNumber, ward: ward._id, roomNumber: String(roomNumber).trim(), category, dailyRate, features: featureList });
  }

  const beds = await Bed.insertMany(docs);
  await BedActivity.insertMany(beds.map((b) => ({
    bed: b._id, bedNumber: b.bedNumber, ward: ward._id, action: 'created', toStatus: b.status, actor,
  })));
  return beds;
}

async function updateBed(bedId, input, actor) {
  assertId(bedId);
  const bed = await Bed.findById(bedId);
  if (!bed) throw new AppError('Bed not found', 404);

  // Only "safe" fields; category/room changes would break room rules & history.
  if (input.dailyRate !== undefined) bed.dailyRate = parseRate(input.dailyRate);
  if (input.features !== undefined) {
    bed.features = Array.isArray(input.features) ? input.features : String(input.features).split(',').map((f) => f.trim()).filter(Boolean);
  }
  if (input.statusNote !== undefined) bed.statusNote = input.statusNote;
  await bed.save();
  await logActivity({ bed, action: 'updated', actor, note: 'Bed details updated' });
  return bed;
}

/** Soft-delete: the bed is hidden but its history is kept. */
async function deactivateBed(bedId, actor) {
  assertId(bedId);
  const bed = await Bed.findOneAndUpdate(
    { _id: bedId, status: { $ne: BED_STATUS.OCCUPIED } },
    { $set: { isActive: false } },
    { returnDocument: 'after' }
  );
  if (!bed) {
    const exists = await Bed.exists({ _id: bedId });
    throw new AppError(exists ? 'Cannot deactivate an occupied bed' : 'Bed not found', exists ? 409 : 404);
  }
  await logActivity({ bed, action: 'deactivated', actor });
  return bed;
}

/** Housekeeping / maintenance status changes. */
async function changeStatus(bedId, { status, note }, actor) {
  assertId(bedId);
  if (status === BED_STATUS.OCCUPIED) throw new AppError('Use the admission endpoints to occupy a bed', 400);
  if (status === BED_STATUS.RESERVED) throw new AppError('Use POST /beds/:id/reserve to reserve a bed', 400);
  if (!Object.values(BED_STATUS).includes(status)) throw new AppError('Invalid status', 400);

  const bed = await Bed.findById(bedId);
  if (!bed || !bed.isActive) throw new AppError('Bed not found', 404);
  const allowed = MANUAL_STATUS_TRANSITIONS[bed.status] || [];
  if (!allowed.includes(status)) {
    throw new AppError(`Cannot change bed from "${bed.status}" to "${status}"${allowed.length ? `. Allowed: ${allowed.join(', ')}` : ''}`, 409);
  }

  // Filter on the old status so a concurrent admission can't be overwritten
  const updated = await Bed.findOneAndUpdate(
    { _id: bedId, status: bed.status },
    { $set: { status, statusNote: note || '', lastStatusChange: new Date() } },
    { returnDocument: 'after' }
  );
  if (!updated) throw new AppError('Bed status changed in the meantime, please refresh', 409);
  await logActivity({ bed: updated, action: 'status-change', fromStatus: bed.status, toStatus: status, actor, note });
  return updated;
}

/** Holds an available bed for an incoming patient (elective admission, ER, OR recovery). */
async function reserveBed(bedId, input, actor) {
  assertId(bedId);
  if (!input.patientId) throw new AppError('patientId is required', 400);
  const reservedUntil = input.reservedUntil
    ? new Date(input.reservedUntil)
    : new Date(Date.now() + env.defaultReservationHours * 3600 * 1000);
  if (Number.isNaN(reservedUntil.getTime()) || reservedUntil <= new Date()) {
    throw new AppError('reservedUntil must be a future date', 400);
  }

  const bed = await Bed.findOneAndUpdate(
    { _id: bedId, status: BED_STATUS.AVAILABLE, isActive: true },
    {
      $set: {
        status: BED_STATUS.RESERVED,
        reservation: {
          patientId: input.patientId,
          patientName: input.patientName,
          reason: input.reason,
          reservedBy: actor?.name,
          reservedAt: new Date(),
          reservedUntil,
        },
        statusNote: input.reason || '',
        lastStatusChange: new Date(),
      },
    },
    { returnDocument: 'after', runValidators: true }
  );
  if (!bed) throw new AppError('Bed is not available for reservation', 409);
  await logActivity({ bed, action: 'reserve', fromStatus: BED_STATUS.AVAILABLE, toStatus: BED_STATUS.RESERVED, actor, note: `For ${input.patientId}` });
  return bed;
}

async function releaseReservation(bedId, actor) {
  assertId(bedId);
  const bed = await Bed.findOneAndUpdate(
    { _id: bedId, status: BED_STATUS.RESERVED },
    { $set: { status: BED_STATUS.AVAILABLE, reservation: null, statusNote: '', lastStatusChange: new Date() } },
    { returnDocument: 'after' }
  );
  if (!bed) throw new AppError('Bed is not reserved', 409);
  await logActivity({ bed, action: 'release', fromStatus: BED_STATUS.RESERVED, toStatus: BED_STATUS.AVAILABLE, actor });
  return bed;
}

/** Background job: frees reservations whose time has passed. */
async function releaseExpiredReservations() {
  const expired = await Bed.find({ status: BED_STATUS.RESERVED, 'reservation.reservedUntil': { $lt: new Date() } });
  let released = 0;
  for (const b of expired) {
    const bed = await Bed.findOneAndUpdate(
      { _id: b._id, status: BED_STATUS.RESERVED, 'reservation.reservedUntil': { $lt: new Date() } },
      { $set: { status: BED_STATUS.AVAILABLE, reservation: null, statusNote: '', lastStatusChange: new Date() } },
      { returnDocument: 'after' }
    );
    if (bed) {
      released++;
      await logActivity({ bed, action: 'reservation-expired', fromStatus: BED_STATUS.RESERVED, toStatus: BED_STATUS.AVAILABLE, actor: { name: 'system' }, note: `Reservation for ${b.reservation?.patientId} expired` });
    }
  }
  return released;
}

module.exports = {
  createBeds,
  updateBed,
  deactivateBed,
  changeStatus,
  reserveBed,
  releaseReservation,
  releaseExpiredReservations,
};
