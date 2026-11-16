const mongoose = require('mongoose');

/**
 * Runs `fn(session)` inside a MongoDB transaction.
 * withTransaction automatically retries on transient errors such as a write
 * conflict when two nurses try to grab the same bed at the same moment.
 */
async function runInTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = runInTransaction;
