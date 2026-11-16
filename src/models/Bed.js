const { Schema, model } = require('mongoose');
const { BED_CATEGORIES, BED_STATUS } = require('../config/constants');

const reservationSchema = new Schema(
  {
    patientId: { type: String, required: true, trim: true },
    patientName: { type: String, trim: true },
    reason: { type: String, trim: true },
    reservedBy: { type: String, trim: true },
    reservedAt: { type: Date, default: Date.now },
    reservedUntil: { type: Date, required: true },
  },
  { _id: false }
);

const bedSchema = new Schema(
  {
    bedNumber: { type: String, required: true, unique: true, uppercase: true, trim: true }, // e.g. PVT-301-A
    ward: { type: Schema.Types.ObjectId, ref: 'Ward', required: true, index: true },
    roomNumber: { type: String, required: true, trim: true },
    category: { type: String, enum: BED_CATEGORIES, required: true },
    dailyRate: { type: Number, required: true, min: 0 },
    status: { type: String, enum: Object.values(BED_STATUS), default: BED_STATUS.AVAILABLE },
    features: [{ type: String, trim: true, lowercase: true }], // oxygen, cardiac-monitor, ventilator...
    currentAdmission: { type: Schema.Types.ObjectId, ref: 'Admission', default: null },
    reservation: { type: reservationSchema, default: null },
    statusNote: { type: String, trim: true, default: '' },
    lastStatusChange: { type: Date, default: Date.now },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'ipd_beds' }
);

// Fast "find me an available private bed" queries
bedSchema.index({ category: 1, status: 1, isActive: 1 });
bedSchema.index({ ward: 1, roomNumber: 1 });
bedSchema.index({ status: 1, 'reservation.reservedUntil': 1 });

module.exports = model('Bed', bedSchema);
