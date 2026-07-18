'use strict';
require('dotenv').config();
require('./config'); // sets TZ
const express = require('express');
const { handleIncoming } = require('./pipeline');
const { startScheduler } = require('./scheduler/scheduler');
const { openFlags, resolveFlag } = require('./services/flags');
const { setMode } = require('./services/conversations');
const { completeAppointment } = require('./services/appointments');
const { db } = require('./db');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio posts form-encoded

app.get('/health', (_req, res) => res.json({ ok: true }));

/* ---------- Meta WhatsApp Cloud API webhook ---------- */
// Verification handshake
app.get('/webhook/meta', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.META_WA_VERIFY_TOKEN) {
    return res.send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});
// Inbound messages
app.post('/webhook/meta', (req, res) => {
  res.sendStatus(200); // ack immediately; process async
  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const contacts = value.contacts || [];
        for (const msg of value.messages || []) {
          if (msg.type !== 'text') continue; // v1: text only; media → human handoff by silence is avoided:
          const from = msg.from;
          const name = contacts.find((c) => c.wa_id === msg.from)?.profile?.name || null;
          handleIncoming(from, msg.text.body, { profileName: name }).catch((e) =>
            console.error('[webhook/meta] pipeline error:', e)
          );
        }
      }
    }
  } catch (err) {
    console.error('[webhook/meta] parse error:', err);
  }
});

/* ---------- Twilio webhook ---------- */
app.post('/webhook/twilio', (req, res) => {
  res.type('text/xml').send('<Response></Response>'); // empty TwiML; we reply via API
  const from = req.body.From; // e.g. whatsapp:+92300...
  const body = req.body.Body;
  const name = req.body.ProfileName || null;
  if (from && body) {
    handleIncoming(from, body, { profileName: name }).catch((e) =>
      console.error('[webhook/twilio] pipeline error:', e)
    );
  }
});

/* ---------- Minimal admin API (token-protected) ---------- */
function adminAuth(req, res, next) {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) return res.sendStatus(401);
  next();
}
app.get('/admin/flags', adminAuth, (_req, res) => res.json(openFlags()));
app.post('/admin/flags/:id/resolve', adminAuth, (req, res) => { resolveFlag(Number(req.params.id)); res.json({ ok: true }); });
app.post('/admin/conversations/:phone/mode', adminAuth, (req, res) => {
  const mode = req.body.mode === 'human' ? 'human' : 'bot';
  res.json(setMode(req.params.phone, mode));
});
app.post('/admin/appointments/:id/complete', adminAuth, (req, res) => {
  res.json(completeAppointment(Number(req.params.id), req.body.procedure_type || null));
});
app.get('/admin/appointments', adminAuth, (req, res) => {
  const rows = db.prepare(
    `SELECT a.*, p.name AS patient_name, p.phone AS patient_phone
     FROM appointments a JOIN patients p ON p.id = a.patient_id
     WHERE a.start_ts >= date('now','localtime','-1 day') ORDER BY a.start_ts LIMIT 200`
  ).all();
  res.json(rows);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Dental clinic agent listening on :${PORT} (provider: ${process.env.WA_PROVIDER || 'mock'})`);
  startScheduler();
});
