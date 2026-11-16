/** Shared domain constants for the Bed Allocation subsystem. */

const BED_CATEGORIES = ['private', 'semi-private', 'ward'];

// How many beds a single room of each category may hold.
const CATEGORY_RULES = {
  private: { label: 'Private', maxBedsPerRoom: 1, defaultRate: 4500 },
  'semi-private': { label: 'Semi-Private', maxBedsPerRoom: 2, defaultRate: 2500 },
  ward: { label: 'Ward', maxBedsPerRoom: 12, defaultRate: 800 },
};

const BED_STATUS = {
  AVAILABLE: 'available',
  OCCUPIED: 'occupied',
  RESERVED: 'reserved',
  CLEANING: 'cleaning',
  MAINTENANCE: 'maintenance',
};

// Manual status changes allowed through PATCH /beds/:id/status.
// "occupied" is only set/cleared by admission, transfer and discharge.
// "reserved" is only set/cleared by the reserve/release endpoints.
const MANUAL_STATUS_TRANSITIONS = {
  available: ['cleaning', 'maintenance'],
  cleaning: ['available', 'maintenance'],
  maintenance: ['available', 'cleaning'],
  reserved: [],
  occupied: [],
};

const WARD_TYPES = ['general', 'medical', 'surgical', 'pediatric', 'maternity', 'orthopedic', 'icu', 'isolation', 'other'];
const GENDER_POLICIES = ['mixed', 'male', 'female'];
const PATIENT_GENDERS = ['male', 'female', 'other'];

const ADMISSION_STATUS = { ADMITTED: 'admitted', DISCHARGED: 'discharged' };
const ADMISSION_TYPES = ['emergency', 'elective', 'referral', 'observation'];
const DISCHARGE_TYPES = ['recovered', 'improved', 'referred', 'against-medical-advice', 'absconded', 'deceased', 'other'];

// Billing: a short stay before a transfer (under this many hours) is not charged,
// so a patient moved after 1 hour isn't billed a full day in two beds.
const TRANSFER_GRACE_HOURS = 4;

module.exports = {
  BED_CATEGORIES,
  CATEGORY_RULES,
  BED_STATUS,
  MANUAL_STATUS_TRANSITIONS,
  WARD_TYPES,
  GENDER_POLICIES,
  PATIENT_GENDERS,
  ADMISSION_STATUS,
  ADMISSION_TYPES,
  DISCHARGE_TYPES,
  TRANSFER_GRACE_HOURS,
};
