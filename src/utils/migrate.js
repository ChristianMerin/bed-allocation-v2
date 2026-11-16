const mongoose = require('mongoose');
const env = require('../config/env');

// Our collections that are worth keeping (login sessions are not copied)
const COLLECTIONS = [
  'ipd_wards', 'ipd_beds', 'ipd_admissions', 'ipd_room_rates', 'ipd_price_history',
  'ipd_bed_activity', 'ipd_counters', 'ipd_users',
];

/**
 * One-time move of this subsystem's data into its own database.
 * Copies the ipd_* collections from LEGACY_DB (the shared HMS database) into
 * DB_NAME, but only while DB_NAME has no wards yet. It never modifies or
 * deletes anything in the source database.
 */
async function copyLegacyData() {
  const source = env.legacyDb;
  if (!source || source === env.dbName) return;

  const client = mongoose.connection.getClient();
  const from = client.db(source);
  const to = mongoose.connection.db;

  if (await to.collection('ipd_wards').estimatedDocumentCount()) return; // already done
  if (!(await from.collection('ipd_wards').estimatedDocumentCount())) return; // nothing to copy

  console.log(`[migrate] copying data from "${source}" into "${env.dbName}" (one time, source is not changed)`);
  for (const name of COLLECTIONS) {
    const docs = await from.collection(name).find().toArray();
    if (!docs.length) continue;
    await to.collection(name).insertMany(docs, { ordered: false });
    console.log(`[migrate]   ${name}: ${docs.length}`);
  }
  console.log('[migrate] done');
}

module.exports = { copyLegacyData };
