const mongoose = require('mongoose');

/**
 * Connects to MongoDB Atlas.
 * Atlas clusters are replica sets, which is required for the multi-document
 * transactions used during admission / transfer / discharge.
 */
async function connectDB(uri, dbName) {
  if (!uri) {
    throw new Error('MONGODB_URI is not set. Copy .env.example to .env and add your Atlas connection string.');
  }
  mongoose.set('strictQuery', true);
  await mongoose.connect(uri, { dbName, serverSelectionTimeoutMS: 15000 });
  console.log(`[db] connected to ${mongoose.connection.host} / ${mongoose.connection.name}`);

  // Make sure collections + indexes exist before the first transaction runs
  // (collections cannot always be created implicitly inside a transaction).
  await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  return mongoose.connection;
}

module.exports = connectDB;
