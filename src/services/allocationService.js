const mongoose = require('mongoose');
const { Bed, Ward, Admission, Counter } = require('../models');
const AppError = require('../utils/AppError');
const runInTransaction = require('../utils/transaction');
const { computeBedCharges } = require('../utils/billing');
const { logActivity } = require('./activityService');
const { BED_STATUS, BED_CATEGORIES, PATIENT_GENDERS } = require('../config/constants');

/* ------------------------------------------------------------------ */
/* Placement rules                                                     */
/* ------------------------------------------------------------------ */

function wardAcceptsGender(ward, gender) {
  return ward.genderPolicy === 'mixed' || ward.genderPolicy === gender;
}

/**
 * Each specialty ward (Medical, Orthopedic, ...) holds private, semi-private and
 * open "ward" rooms. Shared rooms (semi-private and open bays) never mix genders,
 * so a room takes the gender of whoever is already in it.
 * Exception: pediatric wards, where children may share regardless of gender.
 */
async function roomAcceptsGender(bed, ward, gender, session) {
  if (bed.category === 'private') return true;
  if (ward?.type === 'pediatric') return true;
  const roommates = await Bed.find({
    ward: bed.ward._id || bed.ward,
    roomNumber: bed.roomNumber,
    _id: { $ne: bed._id },
    currentAdmission: { $ne: null },
  }).select('currentAdmission').session(session);
  if (!roommates.length) return true;

  const others = await Admission.find({ _id: { $in: roommates.map((b) => b.currentAdmission) } })
    .select('patient.gender').session(session);
  return others.every((a) => a.patient.gender === gender);
}

/**
 * Atomically flips a bed to "occupied". The status condition in the filter is
 * what guarantees two requests can never allocate the same bed.
 * Returns the bed as it was BEFORE the update (or null if it was not free).
 */
function claimBed(bedId, admissionId, patientId, session) {
  return Bed.findOneAndUpdate(
    {
      _id: bedId,
      isActive: true,
      $or: [
        { status: BED_STATUS.AVAILABLE },
        { status: BED_STATUS.RESERVED, 'reservation.patientId': patientId },
      ],
    },
    {
      $set: {
        status: BED_STATUS.OCCUPIED,
        currentAdmission: admissionId,
        reservation: null,
        statusNote: '',
        lastStatusChange: new Date(),
      },
    },
    { returnDocument: 'before', session }
  );
}

/**
 * Picks a bed for the patient and claims it.
 *  - bedId given      -> validate and claim exactly that bed
 *  - otherwise        -> auto-assign the first suitable bed of `category`
 *                        (optionally limited to a ward or ward type).
 *    A bed reserved for this patient is always preferred.
 */
async function selectAndClaimBed(opts, session) {
  const { bedId, category, wardId, wardType, gender, patientId, admissionId, excludeBedId } = opts;

  if (bedId) {
    if (!mongoose.isValidObjectId(bedId)) throw new AppError('Invalid bedId', 400);
    const bed = await Bed.findById(bedId).populate('ward').session(session);
    if (!bed || !bed.isActive) throw new AppError('Bed not found', 404);
    if (excludeBedId && bed._id.equals(excludeBedId)) throw new AppError('Patient is already in this bed', 400);
    if (!bed.ward?.isActive) throw new AppError(`Ward of bed ${bed.bedNumber} is inactive`, 422);

    const reservedForPatient = bed.status === BED_STATUS.RESERVED && bed.reservation?.patientId === patientId;
    if (bed.status === BED_STATUS.RESERVED && !reservedForPatient) {
      throw new AppError(`Bed ${bed.bedNumber} is reserved for another patient`, 409);
    }
    if (bed.status !== BED_STATUS.AVAILABLE && !reservedForPatient) {
      throw new AppError(`Bed ${bed.bedNumber} is not available (status: ${bed.status})`, 409);
    }
    if (!wardAcceptsGender(bed.ward, gender)) {
      throw new AppError(`${bed.ward.name} only accepts ${bed.ward.genderPolicy} patients`, 422);
    }
    if (!(await roomAcceptsGender(bed, bed.ward, gender, session))) {
      throw new AppError(`Room ${bed.roomNumber} is shared with a patient of a different gender`, 422);
    }
    const before = await claimBed(bed._id, admissionId, patientId, session);
    if (!before) throw new AppError(`Bed ${bed.bedNumber} was just taken by another request`, 409);
    return { bed: before, ward: bed.ward, previousStatus: before.status };
  }

  if (!category) throw new AppError('Provide either "bedId" or "category" (private, semi-private, ward)', 400);
  if (!BED_CATEGORIES.includes(category)) throw new AppError(`category must be one of: ${BED_CATEGORIES.join(', ')}`, 400);

  const wardFilter = { isActive: true, genderPolicy: { $in: ['mixed', gender] } };
  if (wardId) {
    if (!mongoose.isValidObjectId(wardId)) throw new AppError('Invalid wardId', 400);
    wardFilter._id = wardId;
  }
  if (wardType) wardFilter.type = wardType;
  const wards = await Ward.find(wardFilter).session(session);
  const wardMap = new Map(wards.map((w) => [String(w._id), w]));

  const bedFilter = {
    ward: { $in: wards.map((w) => w._id) },
    category,
    isActive: true,
    $or: [
      { status: BED_STATUS.AVAILABLE },
      { status: BED_STATUS.RESERVED, 'reservation.patientId': patientId },
    ],
  };
  if (excludeBedId) bedFilter._id = { $ne: excludeBedId };

  const candidates = await Bed.find(bedFilter).sort({ roomNumber: 1, bedNumber: 1 }).session(session);
  candidates.sort((a, b) => (b.status === BED_STATUS.RESERVED) - (a.status === BED_STATUS.RESERVED));

  for (const candidate of candidates) {
    if (!(await roomAcceptsGender(candidate, wardMap.get(String(candidate.ward)), gender, session))) continue;
    const before = await claimBed(candidate._id, admissionId, patientId, session);
    if (before) return { bed: before, ward: wardMap.get(String(candidate.ward)), previousStatus: before.status };
  }
  throw new AppError(`No available ${category} bed matches this patient${wardId || wardType ? ' in the selected ward' : ''}`, 409);
}

function makeStay(bed, ward, from, reason, actor) {
  return {
    bed: bed._id,
    bedNumber: bed.bedNumber,
    ward: ward._id,
    wardName: ward.name,
    roomNumber: bed.roomNumber,
    category: bed.category,
    dailyRate: bed.dailyRate,
    from,
    to: null,
    reason,
    movedBy: actor?.name,
  };
}

/** Frees a bed after a patient leaves it. It goes to housekeeping first. */
function vacateBed(bedId, session) {
  return Bed.findOneAndUpdate(
    { _id: bedId },
    {
      $set: {
        status: BED_STATUS.CLEANING,
        currentAdmission: null,
        statusNote: 'Awaiting housekeeping',
        lastStatusChange: new Date(),
      },
    },
    { returnDocument: 'after', session }
  );
}

/* ------------------------------------------------------------------ */
/* Use cases                                                           */
/* ------------------------------------------------------------------ */

async function admitPatient(input, actor) {
  const patient = input.patient || {};
  if (!patient.patientId || !patient.name || !patient.gender) {
    throw new AppError('patient.patientId, patient.name and patient.gender are required', 400);
  }
  if (!PATIENT_GENDERS.includes(patient.gender)) {
    throw new AppError(`patient.gender must be one of: ${PATIENT_GENDERS.join(', ')}`, 400);
  }

  return runInTransaction(async (session) => {
    const active = await Admission.findOne({ 'patient.patientId': patient.patientId, status: 'admitted' }).session(session);
    if (active) throw new AppError(`Patient is already admitted (${active.admissionNumber})`, 409);

    const admissionId = new mongoose.Types.ObjectId();
    const { bed, ward, previousStatus } = await selectAndClaimBed({
      bedId: input.bedId,
      category: input.category,
      wardId: input.wardId,
      wardType: input.wardType,
      gender: patient.gender,
      patientId: patient.patientId,
      admissionId,
    }, session);

    const now = new Date();
    const year = now.getFullYear();
    const seq = await Counter.next(`admission-${year}`, session);

    const [admission] = await Admission.create([{
      _id: admissionId,
      admissionNumber: `ADM-${year}-${String(seq).padStart(6, '0')}`,
      patient: {
        patientId: patient.patientId,
        name: patient.name,
        gender: patient.gender,
        dateOfBirth: patient.dateOfBirth || undefined,
        contactNumber: patient.contactNumber,
      },
      admissionType: input.admissionType,
      admittingDoctor: input.admittingDoctor,
      department: input.department,
      diagnosis: input.diagnosis,
      notes: input.notes,
      expectedDischargeAt: input.expectedDischargeAt || undefined,
      currentBed: bed._id,
      currentWard: ward._id,
      bedHistory: [makeStay(bed, ward, now, 'Admission', actor)],
      admittedAt: now,
      createdBy: actor?.name,
    }], { session });

    await logActivity({ bed, action: 'admit', fromStatus: previousStatus, toStatus: BED_STATUS.OCCUPIED, admission, actor }, session);
    return admission;
  });
}

async function transferPatient(admissionId, input, actor) {
  if (!mongoose.isValidObjectId(admissionId)) throw new AppError('Invalid admission id', 400);

  return runInTransaction(async (session) => {
    const admission = await Admission.findById(admissionId).session(session);
    if (!admission) throw new AppError('Admission not found', 404);
    if (admission.status !== 'admitted') throw new AppError('Only admitted patients can be transferred', 409);

    const oldBedId = admission.currentBed;
    const { bed, ward, previousStatus } = await selectAndClaimBed({
      bedId: input.bedId,
      category: input.category,
      wardId: input.wardId,
      wardType: input.wardType,
      gender: admission.patient.gender,
      patientId: admission.patient.patientId,
      admissionId: admission._id,
      excludeBedId: oldBedId,
    }, session);

    const now = new Date();
    const reason = input.reason || 'Transfer';
    const currentStay = admission.bedHistory[admission.bedHistory.length - 1];
    if (currentStay) currentStay.to = now;
    admission.bedHistory.push(makeStay(bed, ward, now, reason, actor));
    admission.currentBed = bed._id;
    admission.currentWard = ward._id;
    await admission.save({ session });

    const oldBed = await vacateBed(oldBedId, session);
    if (oldBed) {
      await logActivity({ bed: oldBed, action: 'transfer-out', fromStatus: BED_STATUS.OCCUPIED, toStatus: BED_STATUS.CLEANING, admission, actor, note: reason }, session);
    }
    await logActivity({ bed, action: 'transfer-in', fromStatus: previousStatus, toStatus: BED_STATUS.OCCUPIED, admission, actor, note: reason }, session);
    return admission;
  });
}

async function dischargePatient(admissionId, input, actor) {
  if (!mongoose.isValidObjectId(admissionId)) throw new AppError('Invalid admission id', 400);

  return runInTransaction(async (session) => {
    const admission = await Admission.findById(admissionId).session(session);
    if (!admission) throw new AppError('Admission not found', 404);
    if (admission.status !== 'admitted') throw new AppError('Patient is already discharged', 409);

    const now = new Date();
    const bedId = admission.currentBed;
    const currentStay = admission.bedHistory[admission.bedHistory.length - 1];
    if (currentStay) currentStay.to = now;
    admission.status = 'discharged';
    admission.dischargedAt = now;
    admission.discharge = {
      type: input.dischargeType || 'recovered',
      summary: input.summary,
      dischargedBy: input.dischargedBy || actor?.name,
    };
    admission.currentBed = null;
    admission.currentWard = null;
    await admission.save({ session });

    if (bedId) {
      const bed = await vacateBed(bedId, session);
      if (bed) {
        await logActivity({ bed, action: 'discharge', fromStatus: BED_STATUS.OCCUPIED, toStatus: BED_STATUS.CLEANING, admission, actor, note: admission.discharge.type }, session);
      }
    }
    return { admission, charges: computeBedCharges(admission) };
  });
}

module.exports = {
  admitPatient,
  transferPatient,
  dischargePatient,
  wardAcceptsGender,
};
