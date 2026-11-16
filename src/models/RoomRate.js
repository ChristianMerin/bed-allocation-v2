const { Schema, model } = require('mongoose');
const { BED_CATEGORIES } = require('../config/constants');

/**
 * Room rate card.
 *  ward = null  -> hospital-wide default price for that room class
 *  ward = <id>  -> that ward's own price (overrides the default), e.g. ICU Private
 */
const roomRateSchema = new Schema(
  {
    ward: { type: Schema.Types.ObjectId, ref: 'Ward', default: null },
    category: { type: String, enum: BED_CATEGORIES, required: true },
    dailyRate: { type: Number, required: true, min: 0 },
    updatedBy: { type: String, trim: true },
  },
  { timestamps: true, collection: 'ipd_room_rates' }
);

roomRateSchema.index({ ward: 1, category: 1 }, { unique: true });

module.exports = model('RoomRate', roomRateSchema);
