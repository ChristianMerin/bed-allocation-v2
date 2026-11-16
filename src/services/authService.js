const crypto = require('crypto');
const { promisify } = require('util');
const mongoose = require('mongoose');
const { User, Session } = require('../models');
const AppError = require('../utils/AppError');
const env = require('../config/env');

const scrypt = promisify(crypto.scrypt);
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/* ---------------- passwords ---------------- */

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [alg, salt, hash] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const key = await scrypt(String(password), Buffer.from(salt, 'base64'), 64);
  const expected = Buffer.from(hash, 'base64');
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw new AppError('Password must be at least 8 characters', 400);
  if (password.length > 128) throw new AppError('Password is too long', 400);
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) throw new AppError('Password must contain letters and numbers', 400);
}

// Used when the username doesn't exist, so the response time doesn't reveal it
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hashPassword(crypto.randomBytes(12).toString('hex')));

/* ---------------- brute-force protection ---------------- */

const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const failures = new Map(); // key -> { count, lockedUntil }

function checkLock(key) {
  const f = failures.get(key);
  if (f?.lockedUntil && f.lockedUntil > Date.now()) {
    const mins = Math.ceil((f.lockedUntil - Date.now()) / 60000);
    throw new AppError(`Too many failed attempts. Try again in ${mins} minute(s).`, 429);
  }
}
function recordFailure(key) {
  const f = failures.get(key) || { count: 0 };
  f.count += 1;
  if (f.count >= MAX_FAILS) { f.lockedUntil = Date.now() + LOCK_MS; f.count = 0; }
  failures.set(key, f);
}

/* ---------------- sessions ---------------- */

async function login(username, password, meta = {}) {
  const uname = String(username || '').trim().toLowerCase();
  if (!uname || !password) throw new AppError('Enter your username and password', 400);
  const key = `${meta.ip || ''}|${uname}`;
  checkLock(key);

  const user = await User.findOne({ username: uname });
  const ok = await verifyPassword(password, user ? user.passwordHash : await getDummyHash());
  if (!user || !ok || !user.isActive) {
    recordFailure(key);
    throw new AppError(user && ok && !user.isActive ? 'This account is deactivated. Contact an administrator.' : 'Incorrect username or password', 401);
  }
  failures.delete(key);

  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.sessionHours * 3600 * 1000);
  await Session.create({ tokenHash: sha256(token), user: user._id, expiresAt, ip: meta.ip, userAgent: meta.userAgent });
  user.lastLoginAt = new Date();
  await user.save();
  return { token, expiresAt, user: user.toJSON() };
}

async function getSessionUser(token) {
  if (!token) return null;
  const session = await Session.findOne({ tokenHash: sha256(token), expiresAt: { $gt: new Date() } });
  if (!session) return null;
  const user = await User.findById(session.user);
  if (!user || !user.isActive) return null;
  return user;
}

async function logout(token) {
  if (token) await Session.deleteOne({ tokenHash: sha256(token) });
}

async function changeOwnPassword(user, currentPassword, newPassword, currentToken) {
  if (!(await verifyPassword(currentPassword, user.passwordHash))) throw new AppError('Current password is incorrect', 400);
  validatePassword(newPassword);
  if (currentPassword === newPassword) throw new AppError('New password must be different from the current one', 400);
  user.passwordHash = await hashPassword(newPassword);
  user.mustChangePassword = false;
  await user.save();
  // Sign out every other device
  await Session.deleteMany({ user: user._id, tokenHash: { $ne: sha256(currentToken || '') } });
}

/* ---------------- user management (admin) ---------------- */

async function assertAnotherActiveAdmin(excludeId) {
  const n = await User.countDocuments({ role: 'admin', isActive: true, _id: { $ne: excludeId } });
  if (!n) throw new AppError('There must be at least one active admin', 409);
}

async function createUser({ username, name, role, password }, actor) {
  validatePassword(password);
  if (role && !User.ROLES.includes(role)) throw new AppError(`role must be one of: ${User.ROLES.join(', ')}`, 400);
  const user = await User.create({
    username, name, role: role || 'staff',
    passwordHash: await hashPassword(password),
    mustChangePassword: true, // temporary password chosen by the admin
    createdBy: actor?.name,
  });
  return user;
}

async function updateUser(id, input, actingUser) {
  if (!mongoose.isValidObjectId(id)) throw new AppError('Invalid user id', 400);
  const user = await User.findById(id);
  if (!user) throw new AppError('User not found', 404);
  const isSelf = actingUser && user._id.equals(actingUser._id);

  if (input.name !== undefined) user.name = input.name;
  if (input.role !== undefined && input.role !== user.role) {
    if (!User.ROLES.includes(input.role)) throw new AppError(`role must be one of: ${User.ROLES.join(', ')}`, 400);
    if (isSelf) throw new AppError('You cannot change your own role', 400);
    if (user.role === 'admin') await assertAnotherActiveAdmin(user._id);
    user.role = input.role;
  }
  let revoke = false;
  if (input.isActive !== undefined && Boolean(input.isActive) !== user.isActive) {
    if (isSelf) throw new AppError('You cannot deactivate your own account', 400);
    if (!input.isActive && user.role === 'admin') await assertAnotherActiveAdmin(user._id);
    user.isActive = Boolean(input.isActive);
    revoke = !user.isActive;
  }
  if (input.password) {
    validatePassword(input.password);
    user.passwordHash = await hashPassword(input.password);
    user.mustChangePassword = !isSelf;
    revoke = true;
  }
  await user.save();
  if (revoke) await Session.deleteMany({ user: user._id });
  return user;
}

/** First run: create the admin account so someone can log in. */
async function ensureAdminUser() {
  if (await User.estimatedDocumentCount()) return;
  let password = env.adminPassword;
  const generated = !password;
  if (generated) password = `Adm-${crypto.randomBytes(6).toString('base64url')}9`;
  await User.create({
    username: env.adminUsername,
    name: 'Administrator',
    role: 'admin',
    passwordHash: await hashPassword(password),
    mustChangePassword: generated,
    createdBy: 'system',
  });
  console.log(`[auth] created admin account "${env.adminUsername}"${generated ? ` with temporary password: ${password}` : ' (password from ADMIN_PASSWORD in .env)'}`);
}

module.exports = {
  hashPassword, verifyPassword, validatePassword,
  login, logout, getSessionUser, changeOwnPassword,
  createUser, updateUser, ensureAdminUser,
};
