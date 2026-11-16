const { Schema, model } = require('mongoose');

/**
 * Login sessions. Only a SHA-256 hash of the token is stored, so a database
 * leak does not reveal usable tokens. MongoDB deletes expired sessions itself
 * (TTL index on expiresAt).
 */
const sessionSchema = new Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    expiresAt: { type: Date, required: true },
    ip: String,
    userAgent: String,
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'ipd_sessions' }
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model('Session', sessionSchema);
