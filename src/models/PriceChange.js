const { Schema, model } = require('mongoose');

/** Audit log of every price change (rate card or individual room). */
const priceChangeSchema = new Schema(
  {
    scope: { type: String, enum: ['default-rate', 'ward-rate', 'ward-rate-removed', 'room'], required: true },
    ward: { type: Schema.Types.ObjectId, ref: 'Ward' },
    wardName: String,
    roomNumber: String,
    category: String,
    oldRate: Number,
    newRate: Number,
    bedsUpdated: { type: Number, default: 0 },
    note: String,
    actor: { id: String, name: String },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'ipd_price_history' }
);

priceChangeSchema.index({ createdAt: -1 });

module.exports = model('PriceChange', priceChangeSchema);
