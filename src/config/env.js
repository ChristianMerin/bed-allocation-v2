require('dotenv').config({ quiet: true });

const env = {
  port: parseInt(process.env.PORT, 10) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGODB_URI || '',
  // This subsystem's own database (wards, beds, admissions, rates, users...)
  dbName: process.env.DB_NAME || 'medilink_lab_dev',
  apiKey: process.env.API_KEY || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  defaultReservationHours: parseInt(process.env.DEFAULT_RESERVATION_HOURS, 10) || 24,
  // Patient registry owned by the Patient Registration module, in the shared
  // integrated HMS database on the same cluster (read-only)
  patientDb: process.env.PATIENT_DB || 'medilink_lab_dev',
  patientCollection: process.env.PATIENT_COLLECTION || 'admit_patients',
  // One-time copy of our old ipd_* collections from this database into DB_NAME
  // (only while DB_NAME is still empty). Leave empty to disable.
  legacyDb: process.env.LEGACY_DB || '',
  // Login
  sessionHours: parseInt(process.env.SESSION_HOURS, 10) || 12,
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || '',
};

module.exports = env;
