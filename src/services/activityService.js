const { BedActivity } = require('../models');

/** Writes an audit entry for a bed. Pass `session` when inside a transaction. */
async function logActivity({ bed, action, fromStatus, toStatus, admission, actor, note }, session) {
  const entry = {
    bed: bed._id,
    bedNumber: bed.bedNumber,
    ward: bed.ward?._id || bed.ward,
    action,
    fromStatus,
    toStatus,
    admission: admission?._id,
    admissionNumber: admission?.admissionNumber,
    patientId: admission?.patient?.patientId,
    actor: actor ? { id: actor.id, name: actor.name } : undefined,
    note,
  };
  await BedActivity.create([entry], session ? { session } : {});
}

module.exports = { logActivity };
