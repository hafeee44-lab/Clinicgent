'use strict';
/**
 * Cron jobs for everything time-driven:
 *   every 5 min : 24h reminders, 2h reminders, unanswered-reminder flags, no-show detection
 *   daily 10:00 : post-procedure check-ins, review requests
 *   daily 11:00 : 6-month recall messages
 *
 * All jobs are idempotent — each send stamps a *_sent_at column, so restarts
 * and overlapping runs never double-message anyone.
 */
const cron = require('node-cron');
const { db, toLocalISO, nowISO } = require('../db');
const { getConfig, renderTemplate } = require('../config');
const { sendMessage } = require('../whatsapp/provider');
const { saveMessage, getOrCreateConversation, hasIncomingSince } = require('./../services/conversations');
const { createFlag, patientHasOpenConcern } = require('../services/flags');
const { alertStaff } = require('../services/alerts');
const { humanLabel } = require('../services/appointments');

function firstName(name) { return (name || '').split(' ')[0] || 'there'; }
function timeLabel(iso) { return humanLabel(new Date(iso)); }

async function deliver(patient, templateName, vars) {
  // `patient` may be a patients row (id = patient id) or an appointments-join row (patient_id column)
  const patientId = patient.patient_id || patient.id;
  const text = renderTemplate(templateName, { name: firstName(patient.name), ...vars });
  const conv = getOrCreateConversation(patient.phone, patientId);
  saveMessage(conv.id, 'out', text, { template: templateName });
  await sendMessage(patient.phone, text);
}

/* ---------- reminders ---------- */
async function sendReminders() {
  const now = new Date();
  const in24h = toLocalISO(new Date(now.getTime() + 24 * 3600e3));
  const in2h = toLocalISO(new Date(now.getTime() + 2 * 3600e3));
  const nowStr = toLocalISO(now);

  // 24h: start within (now, now+24h], not yet sent
  const rows24 = db.prepare(
    `SELECT a.*, p.name, p.phone FROM appointments a JOIN patients p ON p.id = a.patient_id
     WHERE a.status IN ('booked','confirmed') AND a.reminder_24h_sent_at IS NULL
       AND a.start_ts > ? AND a.start_ts <= ?`
  ).all(nowStr, in24h);
  for (const a of rows24) {
    await deliver(a, 'reminder_24h', { time: timeLabel(a.start_ts) });
    db.prepare('UPDATE appointments SET reminder_24h_sent_at = ? WHERE id = ?').run(nowISO(), a.id);
  }

  // 2h
  const rows2 = db.prepare(
    `SELECT a.*, p.name, p.phone FROM appointments a JOIN patients p ON p.id = a.patient_id
     WHERE a.status IN ('booked','confirmed') AND a.reminder_2h_sent_at IS NULL
       AND a.start_ts > ? AND a.start_ts <= ?`
  ).all(nowStr, in2h);
  for (const a of rows2) {
    await deliver(a, 'reminder_2h', { time: timeLabel(a.start_ts) });
    db.prepare('UPDATE appointments SET reminder_2h_sent_at = ? WHERE id = ?').run(nowISO(), a.id);
  }
}

/* ---------- unanswered 24h reminder → front-desk flag ---------- */
function flagUnansweredReminders() {
  const cutoff = toLocalISO(new Date(Date.now() - 3 * 3600e3)); // sent >3h ago
  const rows = db.prepare(
    `SELECT a.*, p.name, p.phone FROM appointments a JOIN patients p ON p.id = a.patient_id
     WHERE a.status = 'booked' AND a.reminder_24h_sent_at IS NOT NULL
       AND a.reminder_24h_sent_at <= ? AND a.reminder_flagged_at IS NULL AND a.start_ts > ?`
  ).all(cutoff, nowISO());
  for (const a of rows) {
    const conv = getOrCreateConversation(a.phone, a.patient_id);
    if (hasIncomingSince(conv.id, a.reminder_24h_sent_at)) continue; // they replied; agent handles it
    createFlag({
      type: 'no_reminder_response', patientId: a.patient_id, appointmentId: a.id,
      details: `No reply to 24h reminder for ${timeLabel(a.start_ts)} (${a.reason || 'no reason'}). Consider calling.`,
    });
    alertStaff(`📋 No reply to reminder\n${a.name || 'Unknown'} (${a.phone}) — appointment ${timeLabel(a.start_ts)}. Please follow up by call.`);
    db.prepare('UPDATE appointments SET reminder_flagged_at = ? WHERE id = ?').run(nowISO(), a.id);
  }
}

/* ---------- no-shows ---------- */
async function handleNoShows() {
  const cfg = getConfig();
  const grace = cfg.no_show_grace_minutes || 15;
  const cutoff = toLocalISO(new Date(Date.now() - grace * 60000));
  const rows = db.prepare(
    `SELECT a.*, p.name, p.phone FROM appointments a JOIN patients p ON p.id = a.patient_id
     WHERE a.status IN ('booked','confirmed') AND a.end_ts <= ? AND a.noshow_msg_sent_at IS NULL`
  ).all(cutoff);
  for (const a of rows) {
    db.prepare(`UPDATE appointments SET status = 'no_show', noshow_msg_sent_at = ?, updated_at = ? WHERE id = ?`)
      .run(nowISO(), nowISO(), a.id);
    createFlag({ type: 'no_show', patientId: a.patient_id, appointmentId: a.id, details: `No-show for ${timeLabel(a.start_ts)}` });
    await deliver(a, 'no_show_followup', {});
  }
}

/* ---------- post-procedure follow-ups (day after) ---------- */
async function sendFollowups() {
  const cfg = getConfig();
  const list = (cfg.followup_procedures || []).map((s) => s.toLowerCase());
  const today = nowISO().slice(0, 10);
  const rows = db.prepare(
    `SELECT a.*, p.name, p.phone FROM appointments a JOIN patients p ON p.id = a.patient_id
     WHERE a.status = 'completed' AND a.followup_sent_at IS NULL
       AND date(a.start_ts) < ? AND date(a.start_ts) >= date(?, '-2 day')`
  ).all(today, today);
  for (const a of rows) {
    const proc = (a.procedure_type || a.reason || '').toLowerCase();
    const match = list.find((k) => proc.includes(k));
    if (!match) {
      db.prepare('UPDATE appointments SET followup_sent_at = ? WHERE id = ?').run(nowISO(), a.id); // stamp so we don't rescan forever
      continue;
    }
    const careKey = Object.keys(cfg.care_instructions).find((k) => k !== 'default' && proc.includes(k));
    await deliver(a, 'post_procedure_checkin', {
      procedure: a.procedure_type || match,
      care_instructions: cfg.care_instructions[careKey] || cfg.care_instructions.default,
    });
    db.prepare('UPDATE appointments SET followup_sent_at = ? WHERE id = ?').run(nowISO(), a.id);
  }
}

/* ---------- review requests (completed yesterday, no concerns) ---------- */
async function sendReviewRequests() {
  const today = nowISO().slice(0, 10);
  const rows = db.prepare(
    `SELECT a.*, p.name, p.phone FROM appointments a JOIN patients p ON p.id = a.patient_id
     WHERE a.status = 'completed' AND a.review_req_sent_at IS NULL
       AND date(a.start_ts) < ? AND date(a.start_ts) >= date(?, '-2 day')`
  ).all(today, today);
  for (const a of rows) {
    // If a post-procedure check-in went out today, wait until tomorrow before asking
    // for a review — gives the patient time to report a problem first.
    if (a.followup_sent_at && a.followup_sent_at.slice(0, 10) === today) continue;
    db.prepare('UPDATE appointments SET review_req_sent_at = ? WHERE id = ?').run(nowISO(), a.id);
    if (patientHasOpenConcern(a.patient_id)) continue; // spec: skip if visit had a flagged concern
    await deliver(a, 'review_request', {});
  }
}

/* ---------- 6-month recall ---------- */
async function sendRecalls() {
  const cfg = getConfig();
  const months = cfg.recall_months || 6;
  const rows = db.prepare(
    `SELECT * FROM patients
     WHERE last_checkup_at IS NOT NULL
       AND date(last_checkup_at) <= date('now','localtime', ?)
       AND (recall_sent_at IS NULL OR date(recall_sent_at) <= date('now','localtime','-60 day'))`
  ).all(`-${months} month`);
  for (const p of rows) {
    // skip if they already have an upcoming appointment
    const upcoming = db.prepare(
      `SELECT id FROM appointments WHERE patient_id = ? AND status IN ('booked','confirmed') AND start_ts > ? LIMIT 1`
    ).get(p.id, nowISO());
    if (upcoming) continue;
    await deliver(p, 'recall', {});
    db.prepare('UPDATE patients SET recall_sent_at = ? WHERE id = ?').run(nowISO(), p.id);
  }
}

async function runAllOnce() {
  await sendReminders();
  flagUnansweredReminders();
  await handleNoShows();
  await sendFollowups();
  await sendReviewRequests();
  await sendRecalls();
}

function startScheduler() {
  cron.schedule('*/5 * * * *', () => {
    sendReminders().catch((e) => console.error('[scheduler] reminders:', e));
    try { flagUnansweredReminders(); } catch (e) { console.error('[scheduler] unanswered:', e); }
    handleNoShows().catch((e) => console.error('[scheduler] no-shows:', e));
  });
  cron.schedule('0 10 * * *', () => {
    sendFollowups().catch((e) => console.error('[scheduler] followups:', e));
    sendReviewRequests().catch((e) => console.error('[scheduler] reviews:', e));
  });
  cron.schedule('0 11 * * *', () => {
    sendRecalls().catch((e) => console.error('[scheduler] recalls:', e));
  });
  console.log('Scheduler started (reminders every 5 min; follow-ups 10:00; recalls 11:00).');
}

module.exports = {
  startScheduler, runAllOnce,
  sendReminders, flagUnansweredReminders, handleNoShows, sendFollowups, sendReviewRequests, sendRecalls,
};
