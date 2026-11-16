const { Router } = require('express');
const { authenticate, requireRole, adminForWrites } = require('../middleware/auth');
const { getSummary } = require('../services/dashboardService');
const constants = require('../config/constants');

/**
 * The whole subsystem as ONE router.
 * The main HMS can either call this service over HTTP, or mount it directly:
 *   app.use('/api/ipd', require('bed-allocation/src/routes'));
 *
 * Access:
 *   /auth/*        public login / logout
 *   everything     requires a logged-in user (or the HMS API key)
 *   admin only     wards, rooms, room rates, creating/removing beds, users
 *   staff          bed board, admissions (admit/transfer/discharge), bed status, reservations
 */
const router = Router();

router.use('/auth', require('./authRoutes'));

router.use(authenticate);

router.get('/meta', (_req, res) => {
  res.json({
    success: true,
    data: {
      bedCategories: constants.CATEGORY_RULES,
      bedStatuses: Object.values(constants.BED_STATUS),
      wardTypes: constants.WARD_TYPES,
      genderPolicies: constants.GENDER_POLICIES,
      admissionTypes: constants.ADMISSION_TYPES,
      dischargeTypes: constants.DISCHARGE_TYPES,
    },
  });
});

router.get('/dashboard/summary', async (_req, res) => {
  res.json({ success: true, data: await getSummary() });
});

router.use('/wards', adminForWrites(), require('./wardRoutes'));
// Staff may update bed status and reservations; creating/editing/removing beds is admin only
router.use('/beds', adminForWrites([/\/(status|reserve|release)$/]), require('./bedRoutes'));
router.use('/rooms', adminForWrites(), require('./roomRoutes'));
router.use('/rates', adminForWrites(), require('./rateRoutes'));
router.use('/admissions', require('./admissionRoutes'));
router.use('/patients', require('./patientRoutes'));
router.use('/users', requireRole('admin'), require('./userRoutes'));

module.exports = router;
