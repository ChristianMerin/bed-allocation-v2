const { Schema, model } = require('mongoose');
const { WARD_TYPES, GENDER_POLICIES } = require('../config/constants');

const wardSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, trim: true, maxlength: 10 },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: WARD_TYPES, default: 'general' },
    building: { type: String, trim: true },
    floor: { type: String, trim: true },
    // Restricts which patients may be placed in this ward
    genderPolicy: { type: String, enum: GENDER_POLICIES, default: 'mixed' },
    headNurse: {
      staffId: { type: String, trim: true }, // employee ID from the main HMS
      name: { type: String, trim: true },
    },
    phoneExt: { type: String, trim: true },
    description: { type: String, trim: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, collection: 'ipd_wards' }
);

module.exports = model('Ward', wardSchema);
