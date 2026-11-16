const { TRANSFER_GRACE_HOURS } = require('../config/constants');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Computes room/bed charges for an admission from its bed history.
 * Rule: every started 24h period in a bed is billed at that bed's daily rate
 * (minimum 1 day), except very short stays before a transfer (grace period).
 * The rate is the one captured at the time the patient entered the bed,
 * so later price changes don't affect existing patients.
 *
 * Only room charges are computed here; the main HMS billing module should
 * pull this and combine it with pharmacy, lab, professional fees, etc.
 */
function computeBedCharges(admission, asOf = new Date()) {
  const history = admission.bedHistory || [];
  const lines = history.map((stay, i) => {
    const end = stay.to || admission.dischargedAt || asOf;
    const ms = Math.max(0, new Date(end) - new Date(stay.from));
    const isLast = i === history.length - 1;
    let days = Math.max(1, Math.ceil(ms / DAY_MS));
    if (!isLast && ms < TRANSFER_GRACE_HOURS * HOUR_MS) days = 0;
    return {
      bedNumber: stay.bedNumber,
      wardName: stay.wardName,
      roomNumber: stay.roomNumber,
      category: stay.category,
      from: stay.from,
      to: stay.to || null,
      dailyRate: stay.dailyRate,
      days,
      amount: days * stay.dailyRate,
    };
  });

  const end = admission.dischargedAt || asOf;
  return {
    admissionId: admission._id,
    admissionNumber: admission.admissionNumber,
    patient: admission.patient,
    status: admission.status,
    isFinal: admission.status === 'discharged',
    lengthOfStayDays: +(Math.max(0, new Date(end) - new Date(admission.admittedAt)) / DAY_MS).toFixed(2),
    lines,
    totalDays: lines.reduce((s, l) => s + l.days, 0),
    total: lines.reduce((s, l) => s + l.amount, 0),
    asOf: end,
  };
}

module.exports = { computeBedCharges, DAY_MS };
