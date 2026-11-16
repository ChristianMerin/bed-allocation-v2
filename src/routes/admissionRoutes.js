const { Router } = require('express');
const mongoose = require('mongoose');
const { Admission } = require('../models');
const AppError = require('../utils/AppError');
const allocation = require('../services/allocationService');
const { computeBedCharges } = require('../utils/billing');
const { resolvePatientForAdmission } = require('../services/patientService');

const router = Router();

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

router.param('id', (req, _res, next, id) => {
  if (!mongoose.isValidObjectId(id)) return next(new AppError('Invalid admission id', 400));
  next();
});

// GET /admissions?status=admitted&search=juan&wardId=&page=1&limit=20
router.get('/', async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.wardId) filter.currentWard = req.query.wardId;
  if (req.query.search) {
    const rx = new RegExp(escapeRegex(String(req.query.search)), 'i');
    filter.$or = [{ 'patient.name': rx }, { 'patient.patientId': rx }, { admissionNumber: rx }];
  }

  const [items, total] = await Promise.all([
    Admission.find(filter)
      .populate('currentBed', 'bedNumber roomNumber category dailyRate')
      .populate('currentWard', 'code name')
      .sort({ admittedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit),
    Admission.countDocuments(filter),
  ]);
  res.json({ success: true, page, limit, total, pages: Math.ceil(total / limit), data: items });
});

// GET /admissions/patient/:patientId  -> current + past admissions of a patient (for the HMS patient chart)
router.get('/patient/:patientId', async (req, res) => {
  const history = await Admission.find({ 'patient.patientId': req.params.patientId })
    .populate('currentBed', 'bedNumber roomNumber category')
    .populate('currentWard', 'code name')
    .sort({ admittedAt: -1 });
  res.json({
    success: true,
    data: { active: history.find((a) => a.status === 'admitted') || null, history },
  });
});

router.get('/:id', async (req, res) => {
  const admission = await Admission.findById(req.params.id)
    .populate('currentBed', 'bedNumber roomNumber category dailyRate features')
    .populate('currentWard', 'code name type floor');
  if (!admission) throw new AppError('Admission not found', 404);
  res.json({ success: true, data: admission });
});

// GET /admissions/:id/charges -> running (or final) room charges for billing
router.get('/:id/charges', async (req, res) => {
  const admission = await Admission.findById(req.params.id);
  if (!admission) throw new AppError('Admission not found', 404);
  res.json({ success: true, data: computeBedCharges(admission) });
});

/**
 * POST /admissions  - admit a patient
 * {
 *   patient: { patientId, name, gender, dateOfBirth?, contactNumber? },
 *   bedId?            - pick a specific bed, OR
 *   category?         - auto-assign: private | semi-private | ward
 *   wardId?, wardType?- optional constraints for auto-assign
 *   admissionType?, admittingDoctor?: { doctorId, name }, department?, diagnosis?, notes?, expectedDischargeAt?
 * }
 */
router.post('/', async (req, res) => {
  // Only a patientId from the dashboard -> details come from the patient registry
  const patient = await resolvePatientForAdmission(req.body?.patient);
  const admission = await allocation.admitPatient({ ...req.body, patient }, req.actor);
  const populated = await admission.populate([
    { path: 'currentBed', select: 'bedNumber roomNumber category dailyRate' },
    { path: 'currentWard', select: 'code name' },
  ]);
  res.status(201).json({ success: true, data: populated });
});

// POST /admissions/:id/transfer { bedId? | category?, wardId?, reason }
router.post('/:id/transfer', async (req, res) => {
  const admission = await allocation.transferPatient(req.params.id, req.body, req.actor);
  const populated = await admission.populate([
    { path: 'currentBed', select: 'bedNumber roomNumber category dailyRate' },
    { path: 'currentWard', select: 'code name' },
  ]);
  res.json({ success: true, data: populated });
});

// POST /admissions/:id/discharge { dischargeType, summary, dischargedBy }
router.post('/:id/discharge', async (req, res) => {
  const result = await allocation.dischargePatient(req.params.id, req.body, req.actor);
  res.json({ success: true, data: result });
});

module.exports = router;
