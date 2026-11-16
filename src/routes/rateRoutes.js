const { Router } = require('express');
const rates = require('../services/rateService');

const router = Router();

// GET /rates -> rate card: hospital defaults + every ward x room class
router.get('/', async (_req, res) => {
  res.json({ success: true, data: await rates.getRateCard() });
});

router.get('/history', async (req, res) => {
  res.json({ success: true, data: await rates.getPriceHistory(parseInt(req.query.limit, 10) || 50) });
});

// PUT /rates { wardId?, category, dailyRate, applyToExisting?, note? }
// wardId empty = hospital default; wardId set = that ward's own rate
router.put('/', async (req, res) => {
  const result = await rates.setRate(req.body, req.actor);
  res.json({ success: true, bedsUpdated: result.bedsUpdated, data: result.card });
});

// DELETE /rates/:id?applyToExisting=true -> ward goes back to the hospital default
router.delete('/:id', async (req, res) => {
  const result = await rates.removeWardRate(req.params.id, { applyToExisting: req.query.applyToExisting === 'true' }, req.actor);
  res.json({ success: true, bedsUpdated: result.bedsUpdated, data: result.card });
});

module.exports = router;
