'use strict';
/**
 * Deterministic test suite — exercises the database, booking engine, tools,
 * emergency filter, handoff gating and scheduler WITHOUT calling the Claude API
 * or WhatsApp. Run: npm test
 */
process.env.DB_PATH = require('path').join(require('os').tmpdir(), 'dental-agent-test.db');
process.env.WA_PROVIDER = 'mock';
const fs = require('fs');
try { fs.rmSync(process.env.DB_PATH); } catch {}
try { fs.rmSync(process.env.DB_PATH + '-wal'); } catch {}
try { fs.rmSync(process.env.DB_PATH + '-shm'); } catch {}

const assert = require('assert');
require('../src/config');
const { db, toLocalISO } = require('../src/db');
const { normalizePhone, getOrCreatePatient } = require('../src/services/patients');
const appts = require('../src/services/appointments');
const { getOrCreateConversation, saveMessage, setMode } = require('../src/services/conversations');
const { detectEmergency } = require('../src/agent/emergency');
const { executeTool, toolDefinitions } = require('../src/agent/tools');
const { createFlag, patientHasOpenConcern } = require('../src/services/flags');
const sched = require('../src/scheduler/scheduler');
const { mockOutbox } = require('../src/whatsapp/provider');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

(async () => {
  console.log('\n— phone normalization');
  test('local 0300 → +92300', () => assert.equal(normalizePhone('0321 1234567'), '+923211234567'));
  test('whatsapp: prefix stripped', () => assert.equal(normalizePhone('whatsapp:+923211234567'), '+923211234567'));
  test('bare 92 country code gets +', () => assert.equal(normalizePhone('923211234567'), '+923211234567'));

  console.log('\n— availability & booking');
  const patient = getOrCreatePatient('+923219990001', 'Test Patient');
  const conv = getOrCreateConversation(patient.phone, patient.id);
  const ctx = { patient, conversation: conv };

  const slots = appts.getOpenSlots({ days: 7, limit: 12 });
  test('open slots generated', () => assert.ok(slots.length > 0, 'no slots'));
  test('slots respect clinic hours & are in the future', () => {
    for (const s of slots) {
      const d = new Date(s.start);
      assert.ok(d > new Date(), `slot in past: ${s.start}`);
      assert.notEqual(d.getDay(), 0, 'slot on Sunday (closed)');
    }
  });

  const chosen = slots[0].start;
  const booking = appts.bookAppointment({ patientId: patient.id, startISO: chosen, reason: 'toothache' });
  test('booking succeeds', () => assert.ok(booking.ok));
  test('double-booking same slot rejected', () => {
    const p2 = getOrCreatePatient('+923219990002', 'Second Patient');
    const r = appts.bookAppointment({ patientId: p2.id, startISO: chosen, reason: 'cleaning' });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'slot_taken');
  });
  test('booked slot no longer offered', () => {
    const again = appts.getOpenSlots({ days: 7, limit: 40 });
    assert.ok(!again.find((s) => s.start === chosen));
  });
  test('reschedule frees old slot', () => {
    const newSlot = appts.getOpenSlots({ days: 7, limit: 5 })[1].start;
    const r = appts.rescheduleAppointment(booking.appointment.id, newSlot);
    assert.ok(r.ok);
    assert.ok(appts.slotIsFree(chosen), 'old slot should be free');
  });
  test('cancel frees slot', () => {
    const a = appts.getUpcomingForPatient(patient.id)[0];
    const r = appts.cancelAppointment(a.id);
    assert.ok(r.ok);
    assert.ok(appts.slotIsFree(a.start_ts));
  });
  test('max 2 upcoming appointments enforced', () => {
    const s = appts.getOpenSlots({ days: 10, limit: 10 });
    assert.ok(appts.bookAppointment({ patientId: patient.id, startISO: s[0].start, reason: 'a' }).ok);
    assert.ok(appts.bookAppointment({ patientId: patient.id, startISO: s[1].start, reason: 'b' }).ok);
    const r = appts.bookAppointment({ patientId: patient.id, startISO: s[2].start, reason: 'c' });
    assert.equal(r.error, 'too_many_upcoming');
  });

  console.log('\n— emergency detector (EN / Roman Urdu / Urdu)');
  const positives = [
    'my mouth is bleeding and it won\'t stop',
    'heavy bleeding after extraction',
    'mera face swell ho gaya hai',
    'gaal par soojan barh rahi hai',
    'my son fell and his tooth got knocked out',
    'dant toot gaya accident me',
    'unbearable pain since last night',
    'dard bardasht nahi ho raha',
    'شدید درد ہو رہا ہے',
    'I can\'t breathe properly and my jaw is swollen',
  ];
  for (const msg of positives) {
    test(`flags: "${msg.slice(0, 40)}"`, () => assert.ok(detectEmergency(msg), 'not detected'));
  }
  const negatives = [
    'how much is teeth whitening?',
    'I want to book a cleaning tomorrow',
    'kal appointment mil sakti hai?',
    'do you have parking?',
    'slight sensitivity after filling, is that normal to book a visit?',
  ];
  for (const msg of negatives) {
    test(`ignores: "${msg.slice(0, 40)}"`, () => assert.ok(!detectEmergency(msg), 'false positive'));
  }

  console.log('\n— tools');
  test('all tools have schemas', () => {
    for (const t of toolDefinitions) {
      assert.ok(t.name && t.description && t.input_schema, `bad tool ${t.name}`);
    }
  });
  test('get_faq_answer returns approved content', () => {
    const r = executeTool('get_faq_answer', { topic: 'parking' }, ctx);
    assert.ok(r.found && /parking/i.test(r.answer));
  });
  test('get_faq_answer pricing returns ranges + guardrail instruction', () => {
    const r = executeTool('get_faq_answer', { topic: 'pricing' }, ctx);
    assert.ok(r.pricing && r.instruction.includes('starting from'));
  });
  test('unknown FAQ topic → no invented answer', () => {
    const r = executeTool('get_faq_answer', { topic: 'do you do hair transplants' }, ctx);
    assert.equal(r.found, false);
    assert.ok(r.available_topics.length > 0);
  });
  await testAsync('flag_emergency creates flag + alerts staff numbers', async () => {
    const before = mockOutbox.length;
    const r = executeTool('flag_emergency', { summary: 'test emergency' }, ctx);
    assert.ok(r.ok);
    assert.ok(patientHasOpenConcern(patient.id));
    await new Promise((res) => setTimeout(res, 50)); // alerts are fire-and-forget
    assert.ok(mockOutbox.length > before, 'no alert sent');
  });
  test('request_human_handoff switches conversation to human mode', () => {
    const r = executeTool('request_human_handoff', { reason: 'billing dispute' }, ctx);
    assert.ok(r.ok);
    const row = db.prepare('SELECT mode FROM conversations WHERE id = ?').get(conv.id);
    assert.equal(row.mode, 'human');
    setMode(patient.phone, 'bot'); // reset
  });

  console.log('\n— scheduler (idempotency & flows)');
  // fresh appointment 23h out for reminder test
  const p3 = getOrCreatePatient('+923219990003', 'Reminder Patient');
  const in23h = toLocalISO(new Date(Date.now() + 23 * 3600e3));
  const end23h = toLocalISO(new Date(Date.now() + 23.5 * 3600e3));
  const apptId = db.prepare(
    `INSERT INTO appointments (patient_id, start_ts, end_ts, reason, status) VALUES (?, ?, ?, 'checkup', 'booked')`
  ).run(p3.id, in23h, end23h).lastInsertRowid;

  await testAsync('24h reminder sent exactly once', async () => {
    const before = mockOutbox.filter((m) => m.to === p3.phone).length;
    await sched.sendReminders();
    await sched.sendReminders(); // second pass must not duplicate
    const after = mockOutbox.filter((m) => m.to === p3.phone).length;
    assert.equal(after - before, 1);
    const a = db.prepare('SELECT reminder_24h_sent_at FROM appointments WHERE id = ?').get(apptId);
    assert.ok(a.reminder_24h_sent_at);
  });

  await testAsync('past booked appointment becomes no_show + follow-up message', async () => {
    const p4 = getOrCreatePatient('+923219990004', 'Noshow Patient');
    const past = toLocalISO(new Date(Date.now() - 3 * 3600e3));
    const pastEnd = toLocalISO(new Date(Date.now() - 2.5 * 3600e3));
    const id = db.prepare(
      `INSERT INTO appointments (patient_id, start_ts, end_ts, reason, status) VALUES (?, ?, ?, 'checkup', 'booked')`
    ).run(p4.id, past, pastEnd).lastInsertRowid;
    await sched.handleNoShows();
    const a = db.prepare('SELECT status FROM appointments WHERE id = ?').get(id);
    assert.equal(a.status, 'no_show');
    assert.ok(mockOutbox.find((m) => m.to === p4.phone && /missed you/i.test(m.text)));
  });

  await testAsync('post-procedure follow-up for yesterday\'s extraction', async () => {
    const p5 = getOrCreatePatient('+923219990005', 'Extraction Patient');
    const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(18, 0, 0, 0);
    db.prepare(
      `INSERT INTO appointments (patient_id, start_ts, end_ts, reason, procedure_type, status)
       VALUES (?, ?, ?, 'tooth pain', 'extraction', 'completed')`
    ).run(p5.id, toLocalISO(y), toLocalISO(new Date(y.getTime() + 1800e3)));
    await sched.sendFollowups();
    assert.ok(mockOutbox.find((m) => m.to === p5.phone && /checking in/i.test(m.text)));
  });

  await testAsync('review request skipped when patient has open concern', async () => {
    const p6 = getOrCreatePatient('+923219990006', 'Concern Patient');
    const y = new Date(); y.setDate(y.getDate() - 1); y.setHours(11, 0, 0, 0);
    db.prepare(
      `INSERT INTO appointments (patient_id, start_ts, end_ts, reason, procedure_type, status)
       VALUES (?, ?, ?, 'cleaning', 'cleaning', 'completed')`
    ).run(p6.id, toLocalISO(y), toLocalISO(new Date(y.getTime() + 1800e3)));
    createFlag({ type: 'followup_concern', patientId: p6.id, details: 'still bleeding' });
    await sched.sendReviewRequests();
    assert.ok(!mockOutbox.find((m) => m.to === p6.phone && /review/i.test(m.text)), 'review sent despite concern');
  });

  await testAsync('recall sent for 7-month-old checkup, not for recent one', async () => {
    const p7 = getOrCreatePatient('+923219990007', 'Recall Patient');
    const old = new Date(); old.setMonth(old.getMonth() - 7);
    db.prepare('UPDATE patients SET last_checkup_at = ? WHERE id = ?').run(toLocalISO(old), p7.id);
    const p8 = getOrCreatePatient('+923219990008', 'Recent Patient');
    const recent = new Date(); recent.setMonth(recent.getMonth() - 2);
    db.prepare('UPDATE patients SET last_checkup_at = ? WHERE id = ?').run(toLocalISO(recent), p8.id);
    await sched.sendRecalls();
    assert.ok(mockOutbox.find((m) => m.to === p7.phone && /6 months/i.test(m.text)), 'no recall for old checkup');
    assert.ok(!mockOutbox.find((m) => m.to === p8.phone), 'recall wrongly sent for recent checkup');
  });

  console.log('\n— OpenAI-compatible LLM adapter (Gemini/Groq), mocked fetch');
  await testAsync('adapter executes tool calls then returns final text', async () => {
    process.env.LLM_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'fake-key-for-test';
    const { runOpenAICompatLoop } = require('../src/llm/openaiCompat');
    const realFetch = global.fetch;
    let callCount = 0;
    let capturedToolResult = null;
    global.fetch = async (url, opts) => {
      callCount++;
      const body = JSON.parse(opts.body);
      assert.ok(String(url).includes('generativelanguage.googleapis.com'), 'wrong base URL for gemini');
      assert.ok(body.tools.find((t) => t.function.name === 'get_faq_answer'), 'tools not converted to OpenAI format');
      if (callCount === 1) {
        // model asks for a tool
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_faq_answer', arguments: '{"topic":"parking"}' } }] } }],
          }),
        };
      }
      // second round: verify the tool result was fed back, then answer
      capturedToolResult = body.messages.find((m) => m.role === 'tool');
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Free parking is available in front of the clinic.' } }] }) };
    };
    try {
      const text = await runOpenAICompatLoop({
        system: 'test system prompt',
        history: [{ role: 'user', content: 'do you have parking?' }],
        ctx,
      });
      assert.equal(callCount, 2);
      assert.ok(capturedToolResult && /parking/i.test(capturedToolResult.content), 'tool result not passed back');
      assert.ok(/parking/i.test(text));
    } finally {
      global.fetch = realFetch;
      process.env.LLM_PROVIDER = 'anthropic';
    }
  });

  console.log('\n— human handoff gate (pipeline level)');
  await testAsync('bot stays silent when conversation is in human mode', async () => {
    // pipeline requires no API key for this path: human mode returns before the agent runs
    const { handleIncoming } = require('../src/pipeline');
    setMode(patient.phone, 'human');
    const reply = await handleIncoming(patient.phone, 'hello?');
    assert.equal(reply, null);
    setMode(patient.phone, 'bot');
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
