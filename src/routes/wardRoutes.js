const { Router } = require('express');
const mongoose = require('mongoose');
const { Ward, Bed } = require('../models');
const AppError = require('../utils/AppError');

const router = Router();
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));
const WARD_FIELDS = ['code', 'name', 'type', 'building', 'floor', 'genderPolicy', 'headNurse', 'phoneExt', 'description'];

router.param('id', (req, _res, next, id) => {
  if (!mongoose.isValidObjectId(id)) return next(new AppError('Invalid ward id', 400));
  next();
});

// GET /wards?includeInactive=true  -> wards with live bed counts
router.get('/', async (req, res) => {
  const filter = req.query.includeInactive === 'true' ? {} : { isActive: true };
  const wards = await Ward.find(filter).sort({ code: 1 }).lean();
  const counts = await Bed.aggregate([
    { $match: { isActive: true } },
    { $group: { _id: { ward: '$ward', status: '$status' }, n: { $sum: 1 } } },
  ]);
  const byWard = {};
  for (const c of counts) {
    const k = String(c._id.ward);
    byWard[k] ??= { total: 0 };
    byWard[k].total += c.n;
    byWard[k][c._id.status] = c.n;
  }
  res.json({ success: true, data: wards.map((w) => ({ ...w, beds: byWard[String(w._id)] || { total: 0 } })) });
});

router.get('/:id', async (req, res) => {
  const ward = await Ward.findById(req.params.id);
  if (!ward) throw new AppError('Ward not found', 404);
  res.json({ success: true, data: ward });
});

router.post('/', async (req, res) => {
  const ward = await Ward.create(pick(req.body, WARD_FIELDS));
  res.status(201).json({ success: true, data: ward });
});

router.patch('/:id', async (req, res) => {
  const update = pick(req.body, WARD_FIELDS.filter((f) => f !== 'code').concat('isActive'));
  if (update.genderPolicy && update.genderPolicy !== 'mixed') {
    // Don't allow a policy that conflicts with patients already in the ward
    const occupied = await Bed.find({ ward: req.params.id, status: 'occupied' }).populate('currentAdmission', 'patient.gender');
    if (occupied.some((b) => b.currentAdmission?.patient?.gender !== update.genderPolicy)) {
      throw new AppError('Ward currently has patients that do not match this gender policy', 409);
    }
  }
  if (update.isActive === false && await Bed.exists({ ward: req.params.id, status: 'occupied' })) {
    throw new AppError('Cannot deactivate a ward with occupied beds', 409);
  }
  const ward = await Ward.findByIdAndUpdate(req.params.id, update, { returnDocument: 'after', runValidators: true });
  if (!ward) throw new AppError('Ward not found', 404);
  res.json({ success: true, data: ward });
});

// Soft delete
router.delete('/:id', async (req, res) => {
  if (await Bed.exists({ ward: req.params.id, status: 'occupied' })) {
    throw new AppError('Cannot deactivate a ward with occupied beds', 409);
  }
  const ward = await Ward.findByIdAndUpdate(req.params.id, { isActive: false }, { returnDocument: 'after' });
  if (!ward) throw new AppError('Ward not found', 404);
  await Bed.updateMany({ ward: ward._id }, { isActive: false });
  res.json({ success: true, data: ward });
});

module.exports = router;
