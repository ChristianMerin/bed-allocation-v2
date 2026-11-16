const mongoose = require('mongoose');
const env = require('../config/env');
const { Admission } = require('../models');
const AppError = require('../utils/AppError');

/*
 * Patient lookup in the HMS patient registry.
 * The registry belongs to the Patient Registration module (collection
 * "admit_patients" by default, see PATIENT_COLLECTION in .env). We only READ it,
 * and only basic identity fields - never medical, insurance or address data.
 */

const ID_FIELDS = ['patientId', 'patientCode'];
const NAME_FIELDS = ['firstName', 'middleName', 'lastName', 'name', 'fullName'];
const PROJECTION = {
  patientId: 1, patientCode: 1, firstName: 1, middleName: 1, lastName: 1, name: 1, fullName: 1,
  birthDate: 1, dateOfBirth: 1, sex: 1, gender: 1, contactNo: 1, contactNumber: 1, status: 1,
};

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Same Atlas connection, but the integrated HMS database (not our own one)
const registry = () => mongoose.connection.getClient().db(env.patientDb).collection(env.patientCollection);

function normalizeGender(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('f')) return 'female';
  if (s.startsWith('m')) return 'male';
  return 'other';
}

function ageFrom(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  if (now.getMonth() < d.getMonth() || (now.getMonth() === d.getMonth() && now.getDate() < d.getDate())) age--;
  return age >= 0 ? age : null;
}

// Registry document -> the shape this subsystem uses
function toPatient(doc) {
  const dob = doc.birthDate || doc.dateOfBirth || null;
  const name = (doc.fullName || doc.name || [doc.firstName, doc.middleName, doc.lastName].filter(Boolean).join(' '))
    .replace(/\s+/g, ' ').trim();
  return {
    patientId: String(doc.patientId || doc.patientCode || doc._id),
    name,
    gender: normalizeGender(doc.sex ?? doc.gender),
    dateOfBirth: dob ? new Date(dob) : null,
    age: ageFrom(dob),
    contactNumber: doc.contactNo || doc.contactNumber || null,
    registryStatus: doc.status || null,
  };
}

// Marks patients who already have an active admission (and where they are)
async function withAdmissionStatus(patients) {
  if (!patients.length) return patients;
  const active = await Admission.find({ 'patient.patientId': { $in: patients.map((p) => p.patientId) }, status: 'admitted' })
    .select('admissionNumber patient.patientId currentBed currentWard')
    .populate('currentBed', 'bedNumber')
    .populate('currentWard', 'name');
  const byId = new Map(active.map((a) => [a.patient.patientId, a]));
  return patients.map((p) => {
    const a = byId.get(p.patientId);
    return { ...p, activeAdmission: a ? { admissionId: a._id, admissionNumber: a.admissionNumber, bedNumber: a.currentBed?.bedNumber, wardName: a.currentWard?.name } : null };
  });
}

/** Search by patient ID or name. Every word must match (e.g. "maria san"). */
async function searchPatients(query, limit = 10) {
  const text = String(query || '').trim();
  if (text.length < 2) return [];
  const words = text.split(/\s+/).slice(0, 4);
  const filter = {
    $and: words.map((w) => {
      const rx = new RegExp(escapeRegex(w), 'i');
      return { $or: [...ID_FIELDS, ...NAME_FIELDS].map((f) => ({ [f]: rx })) };
    }),
  };
  const docs = await registry().find(filter, { projection: PROJECTION }).sort({ lastName: 1, firstName: 1 }).limit(Math.min(limit, 25)).toArray();
  return withAdmissionStatus(docs.map(toPatient));
}

async function findPatient(patientId) {
  const id = String(patientId || '').trim();
  if (!id) return null;
  const or = ID_FIELDS.map((f) => ({ [f]: id }));
  if (mongoose.isValidObjectId(id) && /^[a-f0-9]{24}$/i.test(id)) or.push({ _id: new mongoose.Types.ObjectId(id) });
  const doc = await registry().findOne({ $or: or }, { projection: PROJECTION });
  return doc ? (await withAdmissionStatus([toPatient(doc)]))[0] : null;
}

/**
 * For POST /admissions: if only a patientId is sent (the dashboard), the
 * details are taken from the registry so they can't be mistyped.
 * The main HMS may still send full details itself (name + gender).
 */
async function resolvePatientForAdmission(input = {}) {
  if (input.name && input.gender) return input;
  if (!input.patientId) throw new AppError('Select a patient first', 400);
  const p = await findPatient(input.patientId);
  if (!p) throw new AppError(`Patient ${input.patientId} was not found in the patient registry. Register the patient first.`, 404);
  if (!p.name) throw new AppError('The patient record has no name. Update it in Patient Registration first.', 422);
  if (!p.gender) throw new AppError('The patient record has no sex. Update it in Patient Registration first.', 422);
  return {
    patientId: p.patientId,
    name: p.name,
    gender: p.gender,
    dateOfBirth: p.dateOfBirth || undefined,
    contactNumber: p.contactNumber || undefined,
  };
}

module.exports = { searchPatients, findPatient, resolvePatientForAdmission, normalizeGender };
