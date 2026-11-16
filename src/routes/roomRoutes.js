const { Router } = require('express');
const rooms = require('../services/roomService');

const router = Router();

// GET /rooms?wardId=&category=   -> rooms with bed counts, price and status
router.get('/', async (req, res) => {
  const data = await rooms.listRooms({ wardId: req.query.wardId, category: req.query.category });
  res.json({ success: true, count: data.length, data });
});

router.get('/:wardId/:roomNumber', async (req, res) => {
  res.json({ success: true, data: await rooms.getRoom(req.params.wardId, req.params.roomNumber) });
});

// POST /rooms { wardId, roomNumber, category, beds, dailyRate?, features? }
// dailyRate omitted -> price comes from the rate card
router.post('/', async (req, res) => {
  res.status(201).json({ success: true, data: await rooms.createRoom(req.body, req.actor) });
});

// POST /rooms/:wardId/:roomNumber/beds { count }
router.post('/:wardId/:roomNumber/beds', async (req, res) => {
  res.status(201).json({ success: true, data: await rooms.addBedsToRoom(req.params.wardId, req.params.roomNumber, req.body, req.actor) });
});

// PATCH /rooms/:wardId/:roomNumber { dailyRate?, useRateCard?, features?, category?, note? }
router.patch('/:wardId/:roomNumber', async (req, res) => {
  res.json({ success: true, data: await rooms.updateRoom(req.params.wardId, req.params.roomNumber, req.body, req.actor) });
});

router.delete('/:wardId/:roomNumber', async (req, res) => {
  res.json({ success: true, data: await rooms.removeRoom(req.params.wardId, req.params.roomNumber, req.actor) });
});

module.exports = router;
