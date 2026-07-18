'use strict';
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite'); // built into Node >=22.13 — no native build step
require('dotenv').config();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'clinic.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* WAL unsupported on some filesystems; default journal is fine */ }
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS patients (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone            TEXT NOT NULL UNIQUE,        -- E.164, e.g. +923001234567
  name             TEXT,
  language         TEXT DEFAULT 'en',           -- 'en' | 'ur' | 'mixed' (best-effort)
  last_checkup_at  TEXT,                        -- ISO local datetime of last completed cleaning/checkup
  recall_sent_at   TEXT,                        -- last time a 6-month recall message was sent
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id            INTEGER NOT NULL REFERENCES patients(id),
  start_ts              TEXT NOT NULL,           -- ISO local 'YYYY-MM-DDTHH:MM'
  end_ts                TEXT NOT NULL,
  reason                TEXT,                    -- what the patient said ("toothache")
  procedure_type        TEXT,                    -- set by staff after the visit ("extraction", "cleaning"...)
  status                TEXT NOT NULL DEFAULT 'booked',
                        -- booked | confirmed | cancelled | completed | no_show
  reminder_24h_sent_at  TEXT,
  reminder_2h_sent_at   TEXT,
  reminder_flagged_at   TEXT,                    -- flagged for front desk: no reply to 24h reminder
  followup_sent_at      TEXT,                    -- post-procedure check-in sent
  noshow_msg_sent_at    TEXT,
  review_req_sent_at    TEXT,
  created_at            TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_appt_start ON appointments (start_ts);
CREATE INDEX IF NOT EXISTS idx_appt_patient ON appointments (patient_id);

CREATE TABLE IF NOT EXISTS conversations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone            TEXT NOT NULL UNIQUE,
  patient_id       INTEGER REFERENCES patients(id),
  mode             TEXT NOT NULL DEFAULT 'bot',  -- 'bot' | 'human' (staff has taken over)
  last_message_at  TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS messages (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id  INTEGER NOT NULL REFERENCES conversations(id),
  direction        TEXT NOT NULL,                -- 'in' | 'out'
  body             TEXT NOT NULL,
  meta             TEXT,                         -- JSON: provider ids, template name, etc.
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages (conversation_id, id);

CREATE TABLE IF NOT EXISTS flags (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  type             TEXT NOT NULL,                -- emergency | followup_concern | no_reminder_response | handoff | no_show
  patient_id       INTEGER REFERENCES patients(id),
  appointment_id   INTEGER REFERENCES appointments(id),
  conversation_id  INTEGER REFERENCES conversations(id),
  details          TEXT,
  status           TEXT NOT NULL DEFAULT 'open', -- open | resolved
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_flags_status ON flags (status, created_at);
`);

/** 'YYYY-MM-DDTHH:MM' local ISO for a Date */
function toLocalISO(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function nowISO() { return toLocalISO(new Date()); }
function parseISO(s) { return new Date(s); }

module.exports = { db, toLocalISO, nowISO, parseISO, DB_PATH };
