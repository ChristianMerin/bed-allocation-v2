const env = require('./config/env');
require('./models');
const connectDB = require('./config/db');
const app = require('./app');
const { releaseExpiredReservations } = require('./services/bedService');
const { ensureDefaultRates } = require('./services/rateService');
const { ensureAdminUser } = require('./services/authService');
const { copyLegacyData } = require('./utils/migrate');

async function start() {
  await connectDB(env.mongoUri, env.dbName);
  await copyLegacyData();
  await ensureDefaultRates();
  await ensureAdminUser();
  if (!env.apiKey) console.log('[auth] API_KEY not set - the API accepts logged-in users only (cookie or Bearer token)');

  const server = app.listen(env.port, '0.0.0.0', () => {
    console.log(`[http] Bed Allocation service on http://localhost:${env.port}`);
    console.log(`[http] Dashboard: http://localhost:${env.port}/   API: http://localhost:${env.port}/api/v1`);
  });

  // Release expired bed reservations every minute
  const timer = setInterval(async () => {
    try {
      const n = await releaseExpiredReservations();
      if (n) console.log(`[job] released ${n} expired reservation(s)`);
    } catch (err) {
      console.error('[job] reservation sweep failed:', err.message);
    }
  }, 60 * 1000);

  const shutdown = async (signal) => {
    console.log(`[app] ${signal} received, shutting down`);
    clearInterval(timer);
    server.close();
    await require('mongoose').disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start().catch((err) => {
  console.error('[fatal]', err.message);
  process.exit(1);
});
