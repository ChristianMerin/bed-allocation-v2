const { Bed, Admission } = require('../models');
const { BED_CATEGORIES, BED_STATUS } = require('../config/constants');
const { DAY_MS } = require('../utils/billing');

const emptyCounts = () => ({
  total: 0, available: 0, occupied: 0, reserved: 0, cleaning: 0, maintenance: 0, occupancyRate: 0,
});

function finalize(c) {
  // Beds under maintenance are out of service and don't count toward capacity
  const inService = c.total - c.maintenance;
  c.occupancyRate = inService > 0 ? +((c.occupied / inService) * 100).toFixed(1) : 0;
  return c;
}

async function getSummary() {
  const [byCatStatus, byWardStatus] = await Promise.all([
    Bed.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: { category: '$category', status: '$status' }, count: { $sum: 1 } } },
    ]),
    Bed.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: { ward: '$ward', status: '$status' }, count: { $sum: 1 } } },
      { $lookup: { from: 'ipd_wards', localField: '_id.ward', foreignField: '_id', as: 'ward' } },
      { $unwind: '$ward' },
    ]),
  ]);

  const totals = emptyCounts();
  const byCategory = Object.fromEntries(BED_CATEGORIES.map((c) => [c, emptyCounts()]));
  for (const row of byCatStatus) {
    const { category, status } = row._id;
    totals.total += row.count; totals[status] += row.count;
    byCategory[category].total += row.count; byCategory[category][status] += row.count;
  }
  finalize(totals);
  Object.values(byCategory).forEach(finalize);

  const wardMap = new Map();
  for (const row of byWardStatus) {
    const key = String(row.ward._id);
    if (!wardMap.has(key)) {
      wardMap.set(key, { wardId: row.ward._id, code: row.ward.code, name: row.ward.name, type: row.ward.type, ...emptyCounts() });
    }
    const w = wardMap.get(key);
    w.total += row.count; w[row._id.status] += row.count;
  }
  const byWard = [...wardMap.values()].map(finalize).sort((a, b) => a.code.localeCompare(b.code));

  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(Date.now() - 30 * DAY_MS);
  const [currentInpatients, admittedToday, dischargedToday, losAgg] = await Promise.all([
    Admission.countDocuments({ status: 'admitted' }),
    Admission.countDocuments({ admittedAt: { $gte: startOfDay } }),
    Admission.countDocuments({ dischargedAt: { $gte: startOfDay } }),
    Admission.aggregate([
      { $match: { status: 'discharged', dischargedAt: { $gte: thirtyDaysAgo } } },
      { $group: { _id: null, avgMs: { $avg: { $subtract: ['$dischargedAt', '$admittedAt'] } } } },
    ]),
  ]);

  return {
    beds: totals,
    byCategory,
    byWard,
    admissions: {
      currentInpatients,
      admittedToday,
      dischargedToday,
      averageLengthOfStayDays30d: losAgg[0] ? +(losAgg[0].avgMs / DAY_MS).toFixed(2) : null,
    },
    generatedAt: new Date(),
  };
}

module.exports = { getSummary, BED_STATUS };
