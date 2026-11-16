const { Schema, model } = require('mongoose');

/** Audit trail: every change that happens to a bed. */
const bedActivitySchema = new Schema(
  {
    bed: { type: Schema.Types.ObjectId, ref: 'Bed', required: true, index: true },
    bedNumber: String,
    ward: { type: Schema.Types.ObjectId, ref: 'Ward' },
    action: {
      type: String,
      required: true,
      enum: [
        'created', 'updated', 'deactivated', 'status-change',
        'admit', 'transfer-in', 'transfer-out', 'discharge',
        'reserve', 'release', 'reservation-expired',
      ],
    },
    fromStatus: String,
    toStatus: String,
    admission: { type: Schema.Types.ObjectId, ref: 'Admission' },
    admissionNumber: String,
    patientId: String,
    actor: { id: String, name: String },
    note: String,
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'ipd_bed_activity' }
);

bedActivitySchema.index({ createdAt: -1 });

module.exports = model('BedActivity', bedActivitySchema);
