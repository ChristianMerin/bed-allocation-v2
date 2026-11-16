const { Router } = require('express');
const { User } = require('../models');
const auth = require('../services/authService');

// Admin only (enforced where this router is mounted)
const router = Router();

router.get('/', async (_req, res) => {
  const users = await User.find().sort({ isActive: -1, role: 1, name: 1 });
  res.json({ success: true, data: users });
});

// POST /users { name, username, role, password }  (password = temporary, must be changed at first login)
router.post('/', async (req, res) => {
  const user = await auth.createUser(req.body || {}, req.actor);
  res.status(201).json({ success: true, data: user });
});

// PATCH /users/:id { name?, role?, isActive?, password? }
router.patch('/:id', async (req, res) => {
  const user = await auth.updateUser(req.params.id, req.body || {}, req.user);
  res.json({ success: true, data: user });
});

module.exports = router;
