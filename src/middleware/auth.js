const crypto = require('crypto');
const env = require('../config/env');
const AppError = require('../utils/AppError');
const { getSessionUser } = require('../services/authService');

const COOKIE = 'ipd_session';

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** Session token from the login cookie (dashboard) or "Authorization: Bearer <token>" (API clients). */
function getToken(req) {
  const auth = req.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return readCookie(req, COOKIE);
}

/**
 * Who is calling?
 *  1. A logged-in user (cookie or Bearer token)                -> req.user
 *  2. The main HMS server with the shared API key (x-api-key)  -> req.service
 *     (only if API_KEY is set in .env); it names the person in x-user-* headers
 */
async function authenticate(req, _res, next) {
  try {
    const user = await getSessionUser(getToken(req));
    if (user) {
      req.user = user;
      req.actor = { id: user.username, name: user.name, role: user.role };
      return next();
    }
    const key = req.get('x-api-key');
    if (env.apiKey && key && safeEqual(key, env.apiKey)) {
      req.service = true;
      req.actor = { id: req.get('x-user-id') || undefined, name: req.get('x-user-name') || 'HMS system', role: req.get('x-user-role') || 'service' };
      return next();
    }
    next(new AppError('Please log in to continue', 401));
  } catch (err) {
    next(err);
  }
}

/** Allows only the given roles. The main HMS (API key) is trusted like an admin. */
function requireRole(...roles) {
  return (req, _res, next) => {
    if (req.service || (req.user && roles.includes(req.user.role))) return next();
    next(new AppError('You do not have permission to do this. Ask an administrator.', 403));
  };
}

/**
 * Admin-only for changes (POST/PUT/PATCH/DELETE), everyone logged in can read.
 * `allow` lists paths staff may still change (e.g. bed status updates).
 */
function adminForWrites(allow = []) {
  const adminOnly = requireRole('admin');
  return (req, res, next) => {
    if (req.method === 'GET' || allow.some((rx) => rx.test(req.path))) return next();
    adminOnly(req, res, next);
  };
}

module.exports = { COOKIE, getToken, authenticate, requireRole, adminForWrites };
