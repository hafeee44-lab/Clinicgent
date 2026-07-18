'use strict';
const { db, nowISO } = require('../db');
const { normalizePhone } = require('./patients');

function getOrCreateConversation(phone, patientId = null) {
  const norm = normalizePhone(phone);
  let conv = db.prepare('SELECT * FROM conversations WHERE phone = ?').get(norm);
  if (!conv) {
    const info = db.prepare('INSERT INTO conversations (phone, patient_id) VALUES (?, ?)').run(norm, patientId);
    conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(info.lastInsertRowid);
  } else if (patientId && !conv.patient_id) {
    db.prepare('UPDATE conversations SET patient_id = ? WHERE id = ?').run(patientId, conv.id);
    conv.patient_id = patientId;
  }
  return conv;
}

function saveMessage(conversationId, direction, body, meta = null) {
  db.prepare('INSERT INTO messages (conversation_id, direction, body, meta) VALUES (?, ?, ?, ?)')
    .run(conversationId, direction, body, meta ? JSON.stringify(meta) : null);
  db.prepare('UPDATE conversations SET last_message_at = ? WHERE id = ?').run(nowISO(), conversationId);
}

function getRecentMessages(conversationId, limit = 20) {
  return db.prepare(
    'SELECT direction, body, created_at FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?'
  ).all(conversationId, limit).reverse();
}

function setMode(phone, mode) {
  const norm = normalizePhone(phone);
  const conv = getOrCreateConversation(norm);
  db.prepare('UPDATE conversations SET mode = ? WHERE id = ?').run(mode, conv.id);
  return { ...conv, mode };
}

function hasIncomingSince(conversationId, sinceISO) {
  const row = db.prepare(
    `SELECT id FROM messages WHERE conversation_id = ? AND direction = 'in' AND created_at > ? LIMIT 1`
  ).get(conversationId, sinceISO);
  return !!row;
}

module.exports = { getOrCreateConversation, saveMessage, getRecentMessages, setMode, hasIncomingSince };
