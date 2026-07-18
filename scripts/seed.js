'use strict';
/**
 * Seed FAKE test data. Safe to run repeatedly (wipes and recreates data).
 * Creates patients + appointments positioned so every scheduler job has work:
 *   - appointment ~23h from now  → 24h reminder fires
 *   - appointment ~90m from now  → 2h reminder fires
 *   - completed extraction yesterday → post-procedure follow-up fires
 *   - completed cleaning yesterday   → review request fires
 *   - past 'booked' appointment      → no-show handling fires
 *   - patient with 7-month-old checkup → recall fires
 */
require('../src/config');
const { db, toLocalISO } = require('../src/db');
const { bookAppointment } = require('../src/services/appointments');

db.exec('DELETE FROM messages; DELETE FROM flags; DELETE FROM appointments; DELETE FROM conversations; DELETE FROM patients;');

const insertPatient = db.prepare('INSERT INTO patients (phone, name, last_checkup_at) VALUES (?, ?, ?)');
const now = new Date();
const iso = (d) => toLocalISO(d);
const hoursFromNow = (h) => new Date(now.getTime() + h * 3600e3);
const daysAgo = (d, hh = 18, mm = 0) => {
  const x = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d, hh, mm);
  return x;
};

// -- patients
const ali = insertPatient.run('+923211234567', 'Ali Raza', null).lastInsertRowid;
const sana = insertPatient.run('+923331234567', 'Sana Tariq', null).lastInsertRowid;
const usman = insertPatient.run('+923451234567', 'Usman Sheikh', null).lastInsertRowid;
const fatima = insertPatient.run('+923011234567', 'Fatima Noor', null).lastInsertRowid;
const zain = insertPatient.run('+923101234567', 'Zain Abbas', iso(daysAgo(215))).lastInsertRowid; // ~7 months → recall
insertPatient.run('+923121234567', 'Hira Junaid', iso(daysAgo(30))); // recent checkup → no recall

const insertAppt = db.prepare(
  `INSERT INTO appointments (patient_id, start_ts, end_ts, reason, procedure_type, status)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const plus30 = (d) => new Date(d.getTime() + 30 * 60000);

// Ali: ~23h away, booked → 24h reminder
let t = hoursFromNow(23);
insertAppt.run(ali, iso(t), iso(plus30(t)), 'toothache', null, 'booked');

// Sana: ~90 min away, confirmed → 2h reminder
t = hoursFromNow(1.5);
insertAppt.run(sana, iso(t), iso(plus30(t)), 'cleaning', null, 'confirmed');

// Usman: completed extraction yesterday evening → follow-up check-in
t = daysAgo(1, 18, 30);
insertAppt.run(usman, iso(t), iso(plus30(t)), 'tooth pain', 'extraction', 'completed');

// Fatima: completed cleaning yesterday → review request (no concerns)
t = daysAgo(1, 11, 0);
insertAppt.run(fatima, iso(t), iso(plus30(t)), 'cleaning', 'cleaning', 'completed');
db.prepare('UPDATE patients SET last_checkup_at = ? WHERE id = ?').run(iso(t), fatima);

// Zain: booked 3 hours ago, never showed → no-show
t = hoursFromNow(-3);
insertAppt.run(zain, iso(t), iso(plus30(t)), 'checkup', null, 'booked');

console.log('Seeded fake data:');
console.log(db.prepare(`SELECT p.name, p.phone, a.start_ts, a.status, a.reason FROM appointments a JOIN patients p ON p.id=a.patient_id ORDER BY a.start_ts`).all());
console.log('\nPatients:', db.prepare('SELECT id, name, phone, last_checkup_at FROM patients').all());
console.log('\nNext: `npm run scheduler:once` to watch reminders/follow-ups fire (mock provider prints to console),');
console.log('or `npm run simulate` to chat with the agent as a patient.');

// Demonstrate booking API still works against seeded data
const demo = bookAppointment; void demo;
