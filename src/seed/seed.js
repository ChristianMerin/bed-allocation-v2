/**
 * Seeds sample wards, rooms, beds and the room rate card.
 *   npm run seed         -> only if there are no wards yet
 *   npm run seed:reset   -> wipes ONLY this subsystem's ipd_* collections, then seeds
 */
const mongoose = require('mongoose');
const env = require('../config/env');
const { Ward, Bed, Admission, BedActivity, Counter, RoomRate, PriceChange } = require('../models');
const connectDB = require('../config/db');
const { createBeds } = require('../services/bedService');
const { ensureDefaultRates } = require('../services/rateService');

const actor = { name: 'seed-script' };

// Hospital default price per room class (per day)
const DEFAULT_RATES = { private: 4500, 'semi-private': 2500, ward: 800 };

// Wards with their own price for a room class (overrides the default)
const WARD_RATES = {
  ICU: { private: 9000 },
  ISO: { private: 5500 },
  PED: { private: 4000, 'semi-private': 2200, ward: 900 },
};

// Each specialty has its OWN ward. Inside every ward there are rooms of the
// three classes: private (1 bed), semi-private (2 beds) and open ward bays.
// Prices are NOT set here: every bed takes its price from the rate card.
const PRIVATE = { category: 'private', count: 1, features: ['oxygen', 'private-toilet', 'tv', 'aircon'] };
const SEMI = { category: 'semi-private', count: 2, features: ['oxygen', 'shared-toilet', 'aircon'] };
const bay = (count, extra = []) => ({ category: 'ward', count, features: ['oxygen', ...extra] });
const rooms = (list) => list.map(([roomNumber, spec]) => ({ roomNumber, ...spec }));

const WARDS = [
  {
    ward: { code: 'MED', name: 'Medical Ward', type: 'medical', floor: '2F', genderPolicy: 'mixed', description: 'Internal medicine' },
    rooms: rooms([['201', PRIVATE], ['202', PRIVATE], ['203', SEMI], ['204', SEMI], ['205', bay(6)], ['206', bay(6)]]),
  },
  {
    ward: { code: 'SUR', name: 'Surgical Ward', type: 'surgical', floor: '3F', genderPolicy: 'mixed', description: 'General surgery, pre/post-op' },
    rooms: rooms([['301', PRIVATE], ['302', PRIVATE], ['303', SEMI], ['304', SEMI], ['305', bay(6)], ['306', bay(6)]]),
  },
  {
    ward: { code: 'ORT', name: 'Orthopedic Ward', type: 'orthopedic', floor: '4F', genderPolicy: 'mixed', description: 'Fractures, joint replacement, spine' },
    rooms: rooms([
      ['401', { ...PRIVATE, features: [...PRIVATE.features, 'traction', 'overhead-trapeze'] }],
      ['402', { ...PRIVATE, features: [...PRIVATE.features, 'traction', 'overhead-trapeze'] }],
      ['403', { ...SEMI, features: [...SEMI.features, 'traction'] }],
      ['404', bay(6, ['traction'])], ['405', bay(6, ['traction'])],
    ]),
  },
  {
    ward: { code: 'PED', name: 'Pediatric Ward', type: 'pediatric', floor: '5F', genderPolicy: 'mixed', description: 'Children 0-17 years' },
    rooms: rooms([['501', PRIVATE], ['502', PRIVATE], ['503', SEMI], ['504', bay(8)]]),
  },
  {
    ward: { code: 'OBG', name: 'Maternity / OB-Gyne Ward', type: 'maternity', floor: '6F', genderPolicy: 'female', description: 'Obstetrics, post-partum and gynecology' },
    rooms: rooms([['601', PRIVATE], ['602', PRIVATE], ['603', SEMI], ['604', SEMI], ['605', bay(6)]]),
  },
  {
    ward: { code: 'ICU', name: 'Intensive Care Unit', type: 'icu', floor: '1F', genderPolicy: 'mixed', description: 'Critical care cubicles' },
    rooms: rooms(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].map((r) => [r, { category: 'private', count: 1, features: ['oxygen', 'cardiac-monitor', 'ventilator', 'suction', 'infusion-pump'] }])),
  },
  {
    ward: { code: 'ISO', name: 'Isolation Ward', type: 'isolation', floor: '1F', genderPolicy: 'mixed', description: 'Infectious disease, negative-pressure rooms' },
    rooms: rooms(['R1', 'R2', 'R3', 'R4'].map((r) => [r, { category: 'private', count: 1, features: ['oxygen', 'negative-pressure', 'anteroom'] }])),
  },
];

async function main() {
  await connectDB(env.mongoUri, env.dbName);
  const reset = process.argv.includes('--reset');

  if (reset) {
    await Promise.all([Ward, Bed, Admission, BedActivity, Counter, RoomRate, PriceChange].map((m) => m.deleteMany({})));
    console.log('[seed] cleared ipd_* collections');
  } else if (await Ward.estimatedDocumentCount()) {
    console.log('[seed] wards already exist - run "npm run seed:reset" to wipe and reseed');
    return;
  }

  // 1. Rate card: hospital defaults
  await ensureDefaultRates();
  for (const [category, dailyRate] of Object.entries(DEFAULT_RATES)) {
    await RoomRate.updateOne({ ward: null, category }, { $set: { dailyRate, updatedBy: actor.name } });
  }

  // 2. Wards (+ their own rates) and rooms
  for (const { ward, rooms: roomList } of WARDS) {
    const w = await Ward.create(ward);
    for (const [category, dailyRate] of Object.entries(WARD_RATES[w.code] || {})) {
      await RoomRate.create({ ward: w._id, category, dailyRate, updatedBy: actor.name });
    }
    let n = 0;
    for (const room of roomList) n += (await createBeds({ wardId: w._id, ...room }, actor)).length;
    console.log(`[seed] ${w.code} ${w.name}: ${roomList.length} room(s), ${n} bed(s)`);
  }
  console.log('[seed] done');
}

main()
  .catch((err) => { console.error('[seed] failed:', err); process.exitCode = 1; })
  .finally(() => mongoose.disconnect());
