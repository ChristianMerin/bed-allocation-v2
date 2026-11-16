const { Schema, model } = require('mongoose');

const ROLES = ['admin', 'staff'];

const userSchema = new Schema(
  {
    username: {
      type: String, required: true, unique: true, lowercase: true, trim: true,
      match: [/^[a-z0-9._-]{3,30}$/, 'Username must be 3-30 characters: letters, numbers, ".", "_" or "-"'],
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    role: { type: String, enum: ROLES, default: 'staff' },
    passwordHash: { type: String, required: true },
    mustChangePassword: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    lastLoginAt: Date,
    createdBy: String,
  },
  {
    timestamps: true,
    collection: 'ipd_users',
    toJSON: { transform(_doc, ret) { delete ret.passwordHash; delete ret.__v; return ret; } },
  }
);

const User = model('User', userSchema);
User.ROLES = ROLES;
module.exports = User;
