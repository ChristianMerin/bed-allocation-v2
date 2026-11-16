const { Schema, model } = require('mongoose');
const {
  BED_CATEGORIES, PATIENT_GENDERS, ADMISSION_STATUS, ADMISSION_TYPES, DISCHARGE_TYPES,
} = require('../config/constants');

// One entry per bed the patient occupied. Values are snapshotted so history and
// billing stay correct even if the bed/ward is renamed or re-priced later.
const bedStaySchema = new Schema(
  {
    bed: { type: Schema.Types.ObjectId, ref: 'Bed', required: true },
    bedNumber: String,
    ward: { type: Schema.Types.ObjectId, ref: 'Ward', required: true },
    wardName: String,
    roomNumber: String,
    category: { type: String, enum: BED_CATEGORIES },
    dailyRate: Number,
    from: { type: Date, required: true },
    to: { type: Date, default: null },
    reason: String,
    movedBy: String,
  },
  { _id: false }
);

const admissionSchema = new Schema(
  {
    admissionNumber: { type: String, required: true, unique: true }, // ADM-2026-000001
    // Patient master data lives in the main HMS. We keep the ID + a snapshot.
    patient: {
      patientId: { type: String, required: true, trim: true, index: true },
      name: { type: String, required: true, trim: true },
      gender: { type: String, enum: PATIENT_GENDERS, required: true },
      dateOfBirth: Date,
      contactNumber: { type: String, trim: true },
    },
    admissionType: { type: String, enum: ADMISSION_TYPES, default: 'elective' },
    admittingDoctor: {
      doctorId: { type: String, trim: true },
      name: { type: String, trim: true },
    },
    department: { type: String, trim: true },
    diagnosis: { type: String, trim: true },
    notes: { type: String, trim: true },
    status: { type: String, enum: Object.values(ADMISSION_STATUS), default: ADMISSION_STATUS.ADMITTED },
    currentBed: { type: Schema.Types.ObjectId, ref: 'Bed', default: null },
    currentWard: { type: Schema.Types.ObjectId, ref: 'Ward', default: null },
    bedHistory: { type: [bedStaySchema], default: [] },
    admittedAt: { type: Date, default: Date.now },
    expectedDischargeAt: Date,
    dischargedAt: Date,
    discharge: {
      type: { type: String, enum: DISCHARGE_TYPES },
      summary: { type: String, trim: true },
      dischargedBy: { type: String, trim: true },
    },
    createdBy: { type: String, trim: true },
  },
  { timestamps: true, collection: 'ipd_admissions' }
);

// A patient can only have ONE active admission at a time (enforced by the DB).
admissionSchema.index(
  { 'patient.patientId': 1 },
  { unique: true, partialFilterExpression: { status: 'admitted' }, name: 'one_active_admission_per_patient' }
);
admissionSchema.index({ status: 1, admittedAt: -1 });
admissionSchema.index({ dischargedAt: -1 });

module.exports = model('Admission', admissionSchema);
