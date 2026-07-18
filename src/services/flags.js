'use strict';
const { db } = require('../db');

function createFlag({ type, patientId = null, appointmentId = null, conversationId = null, details = '' }) {
  const info = db.prepare(
    'INSERT INTO flags (type, patient_id, appointment_id, conversation_id, details) VALUES (?, ?, ?, ?, ?)'
  ).run(type, patientId, appointmentId, conversationId, details);
  return db.prepare('SELECT * FROM flags WHERE id = ?').get(info.lastInsertRowid);
}

function openFlags(limit = 100) {
  return db.prepare(
    `SELECT f.*, p.name AS patient_name, p.phone AS patient_phone
     FROM flags f LEFT JOIN patients p ON p.id = f.patient_id
     WHERE f.status = 'open' ORDER BY f.created_at DESC LIMIT ?`
  ).all(limit);
}

function patientHasOpenConcern(patientId) {
  const row = db.prepare(
    `SELECT id FROM flags WHERE patient_id = ? AND status = 'open' AND type IN ('emergency','followup_concern') LIMIT 1`
  ).get(patientId);
  return !!row;
}

function resolveFlag(id) {
  db.prepare(`UPDATE flags SET status = 'resolved' WHERE id = ?`).run(id);
}

module.exports = { createFlag, openFlags, patientHasOpenConcern, resolveFlag };
