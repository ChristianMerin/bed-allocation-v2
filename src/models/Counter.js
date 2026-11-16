const { Schema, model } = require('mongoose');

/** Atomic sequence generator used for human-readable admission numbers. */
const counterSchema = new Schema(
  { _id: { type: String, required: true }, seq: { type: Number, default: 0 } },
  { collection: 'ipd_counters', versionKey: false }
);

counterSchema.statics.next = async function next(name, session) {
  const doc = await this.findOneAndUpdate(
    { _id: name },
    { $inc: { seq: 1 } },
    { returnDocument: 'after', upsert: true, session }
  );
  return doc.seq;
};

module.exports = model('Counter', counterSchema);
