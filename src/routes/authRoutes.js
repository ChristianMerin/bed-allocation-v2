const { Router } = require('express');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const auth = require('../services/authService');
const { COOKIE, getToken, authenticate } = require('../middleware/auth');

const router = Router();

const cookieOptions = () => ({
  httpOnly: true,                        // JavaScript can't read it (protects against XSS theft)
  sameSite: 'lax',
  secure: env.nodeEnv === 'production',  // HTTPS only when deployed
  path: '/',
  maxAge: env.sessionHours * 3600 * 1000,
});

// POST /auth/login { username, password }
// Sets the session cookie (dashboard) and also returns the token for API clients.
router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const result = await auth.login(username, password, { ip: req.ip, userAgent: req.get('user-agent') });
  res.cookie(COOKIE, result.token, cookieOptions());
  res.json({ success: true, data: { user: result.user, token: result.token, expiresAt: result.expiresAt } });
});

router.post('/logout', async (req, res) => {
  await auth.logout(getToken(req));
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ success: true });
});

// GET /auth/me -> the logged-in user
router.get('/me', authenticate, (req, res) => {
  res.json({ success: true, data: req.user ? req.user.toJSON() : { service: true, ...req.actor } });
});

// POST /auth/change-password { currentPassword, newPassword }
router.post('/change-password', authenticate, async (req, res) => {
  if (!req.user) throw new AppError('Only logged-in users can change a password', 400);
  const { currentPassword, newPassword } = req.body || {};
  await auth.changeOwnPassword(req.user, currentPassword, newPassword, getToken(req));
  res.json({ success: true, data: req.user.toJSON() });
});

module.exports = router;
