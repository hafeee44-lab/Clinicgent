'use strict';
/**
 * Inbound message pipeline — shared by the WhatsApp webhook and the CLI simulator.
 *
 * Flow: normalize → staff command? → save message → human-mode gate →
 *       deterministic emergency pre-filter → agent loop → send reply.
 */
const { getConfig, renderTemplate } = require('./config');
const { normalizePhone, getOrCreatePatient } = require('./services/patients');
const { getOrCreateConversation, saveMessage, setMode } = require('./services/conversations');
const { createFlag } = require('./services/flags');
const { detectEmergency } = require('./agent/emergency');
const { runAgent } = require('./agent/agent');
const { sendMessage } = require('./whatsapp/provider');
const { alertStaff } = require('./services/alerts');
const { completeAppointment } = require('./services/appointments');

/**
 * Staff members can control the bot from their own WhatsApp:
 *   #takeover +923001112222        → bot goes silent on that patient thread
 *   #release +923001112222        → bot resumes on that thread
 *   #done <appointmentId> [procedure]  → mark visit completed (drives follow-ups/recall/reviews)
 */
function handleStaffCommand(fromPhone, text) {
  const cfg = getConfig();
  const staff = (cfg.staff_whatsapp_numbers || []).map(normalizePhone);
  if (!staff.includes(normalizePhone(fromPhone))) return false;
  const m = text.trim().match(/^#(takeover|release|done)\s+(\S+)(?:\s+(.+))?$/i);
  if (!m) return false;
  const [, cmd, arg, extra] = m;
  try {
    if (cmd.toLowerCase() === 'takeover') {
      setMode(arg, 'human');
      sendMessage(fromPhone, `OK — bot paused for ${normalizePhone(arg)}. You're live on that thread. Send "#release ${normalizePhone(arg)}" when done.`);
    } else if (cmd.toLowerCase() === 'release') {
      setMode(arg, 'bot');
      sendMessage(fromPhone, `OK — bot resumed for ${normalizePhone(arg)}.`);
    } else {
      const r = completeAppointment(Number(arg), extra || null);
      sendMessage(fromPhone, r.ok ? `OK — appointment ${arg} marked completed${extra ? ` (${extra})` : ''}.` : `Could not find appointment ${arg}.`);
    }
  } catch (err) {
    console.error('[pipeline] staff command failed:', err);
  }
  return true;
}

async function handleIncoming(fromPhone, text, { profileName = null } = {}) {
  if (!text || !text.trim()) return null;
  const phone = normalizePhone(fromPhone);

  // 1. Staff commands never enter the patient pipeline
  if (handleStaffCommand(phone, text)) return null;

  // 2. Persist
  const patient = getOrCreatePatient(phone, profileName);
  const conversation = getOrCreateConversation(phone, patient.id);
  saveMessage(conversation.id, 'in', text.trim());

  // 3. Human-takeover gate: staff owns this thread — bot stays silent
  if (conversation.mode === 'human') return null;

  // 4. Deterministic emergency pre-filter (belt-and-braces alongside the model's flag_emergency tool)
  let extraContext = '';
  const emergency = detectEmergency(text);
  if (emergency) {
    createFlag({
      type: 'emergency', patientId: patient.id, conversationId: conversation.id,
      details: `Keyword filter matched "${emergency.matched}" in: ${text.trim()}`,
    });
    alertStaff(
      `🚨 EMERGENCY (keyword filter)\nPatient: ${patient.name || 'Unknown'} (${phone})\nMessage: ${text.trim()}\nPlease contact the patient immediately.`,
      { emergency: true }
    );
    extraContext =
      'The emergency pre-filter already alerted staff about this message. Respond per the emergency rules: acknowledge with care, say the team has been alerted and will contact them right away, give the clinic phone number, and advise the nearest hospital emergency department if severe. NO medical advice. You do not need to call flag_emergency again.';
  }

  // 5. Agent
  let reply;
  try {
    reply = await runAgent({ patient, conversation, extraContext });
  } catch (err) {
    console.error('[pipeline] agent error:', err);
    reply = emergency
      ? renderTemplate('emergency_ack')
      : 'Sorry, we are having a technical issue on our side. Our front desk will get back to you shortly, or you can call us directly.';
    if (!emergency) {
      createFlag({ type: 'handoff', patientId: patient.id, conversationId: conversation.id, details: `Agent error: ${err.message}` });
      alertStaff(`⚠️ Bot error on thread ${phone} — please follow up manually.\nPatient message: ${text.trim()}`);
    }
  }

  // 6. Reply
  if (reply) {
    saveMessage(conversation.id, 'out', reply);
    await sendMessage(phone, reply);
  }
  return reply;
}

module.exports = { handleIncoming };
