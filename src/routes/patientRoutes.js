const { Router } = require('express');
const AppError = require('../utils/AppError');
const patients = require('../services/patientService');

// Read-only lookup in the HMS patient registry
const router = Router();

// GET /patients/search?q=maria&limit=10
router.get('/search', async (req, res) => {
  const data = await patients.searchPatients(req.query.q, parseInt(req.query.limit, 10) || 10);
  res.json({ success: true, count: data.length, data });
});

// GET /patients/:patientId
router.get('/:patientId', async (req, res) => {
  const p = await patients.findPatient(req.params.patientId);
  if (!p) throw new AppError('Patient not found in the registry', 404);
  res.json({ success: true, data: p });
});

module.exports = router;
