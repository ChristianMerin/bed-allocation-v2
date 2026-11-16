const { Router } = require('express');
const mongoose = require('mongoose');
const { Bed, Ward, BedActivity } = require('../models');
const AppError = require('../utils/AppError');
const bedService = require('../services/bedService');
const { findPatient } = require('../services/patientService');
const { BED_CATEGORIES } = require('../config/constants');

const router = Router();

const ADMISSION_FIELDS = 'admissionNumber patient admittedAt admittingDoctor diagnosis expectedDischargeAt';

router.param('id', (req, _res, next, id) => {
  if (!mongoose.isValidObjectId(id)) return next(new AppError('Invalid bed id', 400));
  next();
});

// GET /beds?wardId=&category=&status=&roomNumber=
router.get('/', async (req, res) => {
  const filter = { isActive: req.query.includeInactive === 'true' ? { $in: [true, false] } : true };
  if (req.query.wardId) filter.ward = req.query.wardId;
  if (req.query.category) filter.category = req.query.category;
  if (req.query.status) filter.status = { $in: String(req.query.status).split(',') };
  if (req.query.roomNumber) filter.roomNumber = req.query.roomNumber;

  const beds = await Bed.find(filter)
    .populate('ward', 'code name type floor genderPolicy')
    .populate('currentAdmission', ADMISSION_FIELDS)
    .sort({ bedNumber: 1 });
  res.json({ success: true, count: beds.length, data: beds });
});

// GET /beds/available?category=private&gender=female&wardId=&patientId=
// Main use: the admitting desk asking "what can I give this patient?"
//  - gender:    hides wards with another gender policy, and shared rooms that
//               already hold a patient of another gender (pediatric wards excepted)
//  - patientId: also returns a bed reserved for this patient
router.get('/available', async (req, res) => {
  const { category, gender, wardId, wardType, patientId } = req.query;
  if (category && !BED_CATEGORIES.includes(category)) throw new AppError(`category must be one of: ${BED_CATEGORIES.join(', ')}`, 400);
  if (wardId && !mongoose.isValidObjectId(wardId)) throw new AppError('Invalid wardId', 400);

  const wardFilter = { isActive: true };
  if (gender) wardFilter.genderPolicy = { $in: ['mixed', gender] };
  if (wardId) wardFilter._id = wardId;
  if (wardType) wardFilter.type = wardType;
  const wardIds = (await Ward.find(wardFilter).select('_id')).map((w) => w._id);

  const filter = {
    ward: { $in: wardIds },
    isActive: true,
    $or: [{ status: 'available' }, ...(patientId ? [{ status: 'reserved', 'reservation.patientId': String(patientId) }] : [])],
  };
  if (category) filter.category = category;
  let beds = await Bed.find(filter).populate('ward', 'code name type floor genderPolicy').sort({ roomNumber: 1, bedNumber: 1 });

  if (gender) {
    // Genders already present in each shared room
    const occupied = await Bed.find({ ward: { $in: wardIds }, category: { $ne: 'private' }, currentAdmission: { $ne: null } })
      .select('ward roomNumber currentAdmission').populate('currentAdmission', 'patient.gender');
    const roomGenders = new Map();
    for (const b of occupied) {
      const key = `${b.ward}:${b.roomNumber}`;
      if (!roomGenders.has(key)) roomGenders.set(key, new Set());
      if (b.currentAdmission?.patient?.gender) roomGenders.get(key).add(b.currentAdmission.patient.gender);
    }
    beds = beds.filter((b) => {
      if (b.category === 'private' || b.ward?.type === 'pediatric') return true;
      const g = roomGenders.get(`${b.ward._id}:${b.roomNumber}`);
      return !g || [...g].every((x) => x === gender);
    });
  }
  // A bed reserved for this patient first
  beds.sort((a, b) => (b.status === 'reserved') - (a.status === 'reserved'));

  const summary = Object.fromEntries(BED_CATEGORIES.map((c) => [c, beds.filter((b) => b.category === c).length]));
  res.json({ success: true, count: beds.length, summary, data: beds });
});

router.get('/:id', async (req, res) => {
  const bed = await Bed.findById(req.params.id).populate('ward').populate('currentAdmission', ADMISSION_FIELDS);
  if (!bed) throw new AppError('Bed not found', 404);
  res.json({ success: true, data: bed });
});

router.get('/:id/activity', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const items = await BedActivity.find({ bed: req.params.id }).sort({ createdAt: -1 }).limit(limit);
  res.json({ success: true, data: items });
});

// POST /beds  { wardId, roomNumber, category, count?, dailyRate?, features?, bedNumber? }
router.post('/', async (req, res) => {
  const beds = await bedService.createBeds(req.body, req.actor);
  res.status(201).json({ success: true, count: beds.length, data: beds });
});

router.patch('/:id', async (req, res) => {
  res.json({ success: true, data: await bedService.updateBed(req.params.id, req.body, req.actor) });
});

router.delete('/:id', async (req, res) => {
  res.json({ success: true, data: await bedService.deactivateBed(req.params.id, req.actor) });
});

// PATCH /beds/:id/status { status: available|cleaning|maintenance, note }
router.patch('/:id/status', async (req, res) => {
  res.json({ success: true, data: await bedService.changeStatus(req.params.id, req.body, req.actor) });
});

// POST /beds/:id/reserve { patientId, patientName, reason, reservedUntil }
router.post('/:id/reserve', async (req, res) => {
  const body = { ...req.body };
  // Patient picked from the registry: take the name from there
  if (body.patientId && !body.patientName) {
    const p = await findPatient(body.patientId);
    if (!p) throw new AppError(`Patient ${body.patientId} was not found in the patient registry`, 404);
    body.patientName = p.name;
  }
  res.json({ success: true, data: await bedService.reserveBed(req.params.id, body, req.actor) });
});

router.post('/:id/release', async (req, res) => {
  res.json({ success: true, data: await bedService.releaseReservation(req.params.id, req.actor) });
});

module.exports = router;
