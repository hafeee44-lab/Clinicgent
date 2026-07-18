'use strict';
const { db } = require('../db');

/** Normalize a phone number to E.164-ish (+92...). Handles 0300..., 92300..., whatsapp:+92... */
function normalizePhone(raw) {
  let p = String(raw || '').trim().replace(/^whatsapp:/i, '').replace(/[\s\-()]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (p.startsWith('0') && p.length === 11) p = '+92' + p.slice(1); // Pakistani local format 03XX...
  if (!p.startsWith('+') && /^\d+$/.test(p)) p = '+' + p;
  return p;
}

function getOrCreatePatient(phone, name = null) {
  const norm = normalizePhone(phone);
  let patient = db.prepare('SELECT * FROM patients WHERE phone = ?').get(norm);
  if (!patient) {
    const info = db.prepare('INSERT INTO patients (phone, name) VALUES (?, ?)').run(norm, name);
    patient = db.prepare('SELECT * FROM patients WHERE id = ?').get(info.lastInsertRowid);
  } else if (name && !patient.name) {
    db.prepare('UPDATE patients SET name = ? WHERE id = ?').run(name, patient.id);
    patient.name = name;
  }
  return patient;
}

function updatePatientName(patientId, name) {
  db.prepare('UPDATE patients SET name = ? WHERE id = ?').run(name, patientId);
}

function getPatientByPhone(phone) {
  return db.prepare('SELECT * FROM patients WHERE phone = ?').get(normalizePhone(phone));
}

module.exports = { normalizePhone, getOrCreatePatient, getPatientByPhone, updatePatientName };
