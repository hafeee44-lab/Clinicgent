'use strict';
const { db, toLocalISO, nowISO } = require('../db');
const { getConfig } = require('../config');

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const ACTIVE = "('booked','confirmed')";

/**
 * Generate open slots between fromDate and horizon, honoring clinic hours and existing bookings.
 * Returns [{ start: 'YYYY-MM-DDTHH:MM', end: ..., label: 'Mon 20 Jul, 5:30 PM' }]
 */
function getOpenSlots({ fromISO = null, days = null, timeOfDay = null, limit = 40 } = {}) {
  const cfg = getConfig();
  const slotMin = cfg.slot_minutes || 30;
  const horizon = days || cfg.booking_horizon_days || 21;
  const now = new Date();
  const start = fromISO ? new Date(fromISO) : now;

  const booked = new Set(
    db.prepare(`SELECT start_ts FROM appointments WHERE status IN ${ACTIVE} AND start_ts >= ?`)
      .all(toLocalISO(start))
      .map((r) => r.start_ts)
  );

  const slots = [];
  for (let d = 0; d < horizon && slots.length < limit; d++) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + d);
    const windows = cfg.hours[DAY_NAMES[day.getDay()]] || [];
    for (const [open, close] of windows) {
      const [oh, om] = open.split(':').map(Number);
      const [ch, cm] = close.split(':').map(Number);
      let t = new Date(day.getFullYear(), day.getMonth(), day.getDate(), oh, om);
      const end = new Date(day.getFullYear(), day.getMonth(), day.getDate(), ch, cm);
      while (t.getTime() + slotMin * 60000 <= end.getTime()) {
        if (t > now && matchesTimeOfDay(t, timeOfDay)) {
          const iso = toLocalISO(t);
          if (!booked.has(iso)) {
            slots.push({ start: iso, end: toLocalISO(new Date(t.getTime() + slotMin * 60000)), label: humanLabel(t) });
            if (slots.length >= limit) break;
          }
        }
        t = new Date(t.getTime() + slotMin * 60000);
      }
      if (slots.length >= limit) break;
    }
  }
  return slots;
}

function matchesTimeOfDay(date, tod) {
  if (!tod) return true;
  const h = date.getHours();
  if (tod === 'morning') return h < 12;
  if (tod === 'afternoon') return h >= 12 && h < 17;
  if (tod === 'evening') return h >= 17;
  return true;
}

function humanLabel(d) {
  return d.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

function slotIsFree(startISO) {
  const row = db.prepare(`SELECT id FROM appointments WHERE start_ts = ? AND status IN ${ACTIVE}`).get(startISO);
  return !row;
}

function bookAppointment({ patientId, startISO, reason }) {
  const cfg = getConfig();
  if (!slotIsFree(startISO)) return { ok: false, error: 'slot_taken' };
  // Prevent duplicate active bookings for same patient at same time or >2 upcoming
  const upcoming = db.prepare(
    `SELECT COUNT(*) c FROM appointments WHERE patient_id = ? AND status IN ${ACTIVE} AND start_ts >= ?`
  ).get(patientId, nowISO()).c;
  if (upcoming >= 2) return { ok: false, error: 'too_many_upcoming' };
  const endISO = toLocalISO(new Date(new Date(startISO).getTime() + (cfg.slot_minutes || 30) * 60000));
  const info = db.prepare(
    `INSERT INTO appointments (patient_id, start_ts, end_ts, reason) VALUES (?, ?, ?, ?)`
  ).run(patientId, startISO, endISO, reason || null);
  return { ok: true, appointment: getAppointment(info.lastInsertRowid) };
}

function getAppointment(id) {
  return db.prepare('SELECT * FROM appointments WHERE id = ?').get(id);
}

function getUpcomingForPatient(patientId) {
  return db.prepare(
    `SELECT * FROM appointments WHERE patient_id = ? AND status IN ${ACTIVE} AND start_ts >= ? ORDER BY start_ts`
  ).all(patientId, nowISO());
}

function cancelAppointment(id) {
  const appt = getAppointment(id);
  if (!appt || !['booked', 'confirmed'].includes(appt.status)) return { ok: false, error: 'not_found_or_not_active' };
  db.prepare(`UPDATE appointments SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(nowISO(), id);
  return { ok: true };
}

function rescheduleAppointment(id, newStartISO) {
  const appt = getAppointment(id);
  if (!appt || !['booked', 'confirmed'].includes(appt.status)) return { ok: false, error: 'not_found_or_not_active' };
  if (!slotIsFree(newStartISO)) return { ok: false, error: 'slot_taken' };
  const cfg = getConfig();
  const endISO = toLocalISO(new Date(new Date(newStartISO).getTime() + (cfg.slot_minutes || 30) * 60000));
  db.prepare(
    `UPDATE appointments SET start_ts = ?, end_ts = ?, status = 'booked',
     reminder_24h_sent_at = NULL, reminder_2h_sent_at = NULL, reminder_flagged_at = NULL, updated_at = ?
     WHERE id = ?`
  ).run(newStartISO, endISO, nowISO(), id);
  return { ok: true, appointment: getAppointment(id) };
}

function confirmAppointment(id) {
  const appt = getAppointment(id);
  if (!appt || !['booked', 'confirmed'].includes(appt.status)) return { ok: false, error: 'not_found_or_not_active' };
  db.prepare(`UPDATE appointments SET status = 'confirmed', updated_at = ? WHERE id = ?`).run(nowISO(), id);
  return { ok: true };
}

/** Staff marks the visit done. procedureType drives post-procedure follow-up; checkup/cleaning updates recall clock. */
function completeAppointment(id, procedureType = null) {
  const appt = getAppointment(id);
  if (!appt) return { ok: false, error: 'not_found' };
  db.prepare(`UPDATE appointments SET status = 'completed', procedure_type = COALESCE(?, procedure_type), updated_at = ? WHERE id = ?`)
    .run(procedureType, nowISO(), id);
  const pt = (procedureType || appt.procedure_type || appt.reason || '').toLowerCase();
  if (/clean|scal|polish|check\s*up|checkup|exam/.test(pt)) {
    db.prepare('UPDATE patients SET last_checkup_at = ? WHERE id = ?').run(appt.start_ts, appt.patient_id);
  }
  return { ok: true };
}

module.exports = {
  getOpenSlots, bookAppointment, cancelAppointment, rescheduleAppointment,
  confirmAppointment, completeAppointment, getUpcomingForPatient, getAppointment,
  slotIsFree, humanLabel,
};
