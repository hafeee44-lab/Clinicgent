'use strict';
const { getConfig } = require('../config');
const appts = require('../services/appointments');
const { updatePatientName } = require('../services/patients');
const { setMode } = require('../services/conversations');
const { createFlag } = require('../services/flags');
const { alertStaff } = require('../services/alerts');

/**
 * Tool definitions passed to the Claude API. Explicit, narrow tools — the model
 * never improvises actions outside these.
 */
const toolDefinitions = [
  {
    name: 'check_availability',
    description:
      'Check open appointment slots. Use before offering any time to a patient. Returns up to 12 open slots. ' +
      'If the patient asked for a specific day/time that has nothing free, call again with a wider range and offer the nearest alternatives instead of just saying no.',
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: "Earliest date to search, 'YYYY-MM-DD'. Omit for today." },
        days: { type: 'integer', description: 'How many days ahead to search (default 7).' },
        time_of_day: { type: 'string', enum: ['morning', 'afternoon', 'evening'], description: 'Filter if the patient stated a preference.' },
      },
    },
  },
  {
    name: 'book_appointment',
    description:
      'Book a slot for the CURRENT patient (identified by their WhatsApp number automatically). ' +
      'Only call after the patient has clearly agreed to a specific slot you offered from check_availability. ' +
      'Requires the patient name — ask for it first if unknown.',
    input_schema: {
      type: 'object',
      properties: {
        patient_name: { type: 'string', description: "Patient's full name." },
        slot_start: { type: 'string', description: "Chosen slot start, 'YYYY-MM-DDTHH:MM' exactly as returned by check_availability." },
        reason: { type: 'string', description: "Reason for visit in the patient's own words, e.g. 'toothache', 'cleaning'." },
      },
      required: ['patient_name', 'slot_start', 'reason'],
    },
  },
  {
    name: 'find_my_appointments',
    description: 'List the current patient\'s upcoming (active) appointments. Use when they mention rescheduling, cancelling, confirming, or ask when their appointment is.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'reschedule_appointment',
    description: 'Move an existing appointment to a new slot the patient agreed to. Get the appointment_id from find_my_appointments and the new slot from check_availability.',
    input_schema: {
      type: 'object',
      properties: {
        appointment_id: { type: 'integer' },
        new_slot_start: { type: 'string', description: "'YYYY-MM-DDTHH:MM'" },
      },
      required: ['appointment_id', 'new_slot_start'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel an existing appointment after the patient confirms they want to cancel (not reschedule). Frees the slot.',
    input_schema: {
      type: 'object',
      properties: { appointment_id: { type: 'integer' } },
      required: ['appointment_id'],
    },
  },
  {
    name: 'confirm_appointment',
    description: "Mark an appointment as confirmed when the patient confirms attendance (e.g. replies '1', 'confirm', 'yes I'll come' to a reminder).",
    input_schema: {
      type: 'object',
      properties: { appointment_id: { type: 'integer' } },
      required: ['appointment_id'],
    },
  },
  {
    name: 'get_faq_answer',
    description:
      'Fetch the clinic\'s approved answer for a frequently asked question. ALWAYS use this for hours, location, parking, payment, walk-ins, insurance, children, x-rays, first visits, and any pricing question. Never invent this information.',
    input_schema: {
      type: 'object',
      properties: {
        topic: {
          type: 'string',
          description: "One of the FAQ topics, or 'pricing' for the price list.",
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'flag_emergency',
    description:
      'IMMEDIATELY call this if the patient describes a possible dental emergency: heavy/uncontrolled bleeding, facial swelling, knocked-out or broken tooth from trauma, severe uncontrolled pain, difficulty breathing/swallowing, or fever with swelling. This alerts the on-call dentist right away. When in doubt, flag it.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: "One-line summary of what the patient reported, quoting their words." },
      },
      required: ['summary'],
    },
  },
  {
    name: 'request_human_handoff',
    description:
      'Hand the conversation to front-desk staff and stop auto-responding. Use when: the patient asks for a human, is upset, has a billing dispute, asks something outside your tools, or you cannot resolve their request after a reasonable attempt.',
    input_schema: {
      type: 'object',
      properties: { reason: { type: 'string', description: 'Short internal note for staff on why.' } },
      required: ['reason'],
    },
  },
  {
    name: 'log_followup_response',
    description:
      "Log the patient's reply to a post-procedure check-in. status 'concern' (still bleeding, worsening swelling, severe pain, fever, anything worrying) alerts staff immediately; 'ok' just records it. If unsure, use 'concern'.",
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'concern'] },
        notes: { type: 'string', description: "Summary of what the patient said." },
      },
      required: ['status', 'notes'],
    },
  },
];

/**
 * Execute a tool call. ctx = { patient, conversation }
 * Always returns a JSON-serializable result for the model.
 */
function executeTool(name, input, ctx) {
  const cfg = getConfig();
  const { patient, conversation } = ctx;

  switch (name) {
    case 'check_availability': {
      const fromISO = input.from_date ? `${input.from_date}T00:00` : null;
      const slots = appts.getOpenSlots({
        fromISO, days: input.days || 7, timeOfDay: input.time_of_day || null, limit: 12,
      });
      if (slots.length === 0) {
        const wider = appts.getOpenSlots({ days: cfg.booking_horizon_days, limit: 6 });
        return { slots: [], nearest_alternatives: wider, note: 'Nothing free in requested window; offer nearest_alternatives.' };
      }
      return { slots };
    }

    case 'book_appointment': {
      if (input.patient_name) updatePatientName(patient.id, input.patient_name);
      const r = appts.bookAppointment({ patientId: patient.id, startISO: input.slot_start, reason: input.reason });
      if (!r.ok) {
        if (r.error === 'slot_taken') {
          return { ok: false, error: 'That slot was just taken. Re-check availability and offer new options.' };
        }
        if (r.error === 'too_many_upcoming') {
          return { ok: false, error: 'Patient already has 2 upcoming appointments. Offer to reschedule an existing one instead of double-booking.' };
        }
        return { ok: false, error: r.error };
      }
      return {
        ok: true,
        appointment_id: r.appointment.id,
        start: r.appointment.start_ts,
        label: appts.humanLabel(new Date(r.appointment.start_ts)),
        clinic_address: cfg.address,
      };
    }

    case 'find_my_appointments': {
      const list = appts.getUpcomingForPatient(patient.id).map((a) => ({
        appointment_id: a.id,
        start: a.start_ts,
        label: appts.humanLabel(new Date(a.start_ts)),
        reason: a.reason,
        status: a.status,
      }));
      return { appointments: list };
    }

    case 'reschedule_appointment': {
      const r = appts.rescheduleAppointment(input.appointment_id, input.new_slot_start);
      if (!r.ok) return { ok: false, error: r.error === 'slot_taken' ? 'New slot just got taken; offer other options.' : 'Appointment not found or not active.' };
      return { ok: true, new_start: r.appointment.start_ts, label: appts.humanLabel(new Date(r.appointment.start_ts)) };
    }

    case 'cancel_appointment': {
      const r = appts.cancelAppointment(input.appointment_id);
      return r.ok ? { ok: true } : { ok: false, error: 'Appointment not found or not active.' };
    }

    case 'confirm_appointment': {
      const r = appts.confirmAppointment(input.appointment_id);
      return r.ok ? { ok: true } : { ok: false, error: 'Appointment not found or not active.' };
    }

    case 'get_faq_answer': {
      const topic = String(input.topic || '').toLowerCase().replace(/[\s-]+/g, '_');
      if (topic.includes('pric') || topic.includes('cost') || topic.includes('fee') || topic.includes('rate')) {
        const { _note, ...prices } = cfg.pricing;
        return {
          pricing: prices,
          instruction: "Present relevant prices as 'starting from' ranges and always add that exact cost is confirmed at consultation. Never promise a fixed price or clinical outcome.",
        };
      }
      const answer = cfg.faq[topic] || cfg.faq[Object.keys(cfg.faq).find((k) => topic.includes(k) || k.includes(topic)) || ''];
      if (!answer) {
        return { found: false, available_topics: Object.keys(cfg.faq), note: 'No approved answer for this topic. If none fits, offer human handoff rather than guessing.' };
      }
      return { found: true, answer };
    }

    case 'flag_emergency': {
      createFlag({
        type: 'emergency', patientId: patient.id, conversationId: conversation.id, details: input.summary,
      });
      alertStaff(
        `🚨 EMERGENCY flag\nPatient: ${patient.name || 'Unknown'} (${patient.phone})\nReported: ${input.summary}\nPlease contact the patient immediately.`,
        { emergency: true }
      );
      return {
        ok: true,
        instruction: `Tell the patient the team has been alerted and will contact them right away, and that for severe situations they should call ${cfg.phone} or go to the nearest hospital emergency department. Do NOT give any medical advice, diagnosis, or home remedies.`,
      };
    }

    case 'request_human_handoff': {
      setMode(conversation.phone, 'human');
      createFlag({
        type: 'handoff', patientId: patient.id, conversationId: conversation.id, details: input.reason,
      });
      alertStaff(
        `👤 Handoff requested\nPatient: ${patient.name || 'Unknown'} (${patient.phone})\nReason: ${input.reason}\nReply to the patient directly; the bot has stopped responding on this thread. Send "#release ${patient.phone}" to me when done.`
      );
      return { ok: true, instruction: 'Tell the patient you are connecting them with the front desk and someone will reply shortly. This is your LAST message on this thread.' };
    }

    case 'log_followup_response': {
      const isConcern = input.status === 'concern';
      if (isConcern) {
        createFlag({
          type: 'followup_concern', patientId: patient.id, conversationId: conversation.id, details: input.notes,
        });
        alertStaff(
          `⚠️ Post-procedure concern\nPatient: ${patient.name || 'Unknown'} (${patient.phone})\nReported: ${input.notes}\nPlease review and contact the patient.`,
          { emergency: true }
        );
        return { ok: true, instruction: `Acknowledge with care, say the dentist's team has been notified and will contact them shortly, and that they can call ${cfg.phone} any time. Do NOT give medical advice or remedies.` };
      }
      return { ok: true, instruction: 'Thank them warmly and remind them they can message any time if anything changes.' };
    }

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

module.exports = { toolDefinitions, executeTool };
