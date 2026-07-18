'use strict';
const { getConfig } = require('../config');
const { sendMessage } = require('../whatsapp/provider');

/**
 * Send an internal alert to clinic staff on their own WhatsApp numbers.
 * emergency:true also messages every emergency contact number.
 * Fire-and-forget: alert failures are logged, never thrown into the patient flow.
 */
function alertStaff(text, { emergency = false } = {}) {
  const cfg = getConfig();
  const targets = new Set(cfg.staff_whatsapp_numbers || []);
  if (emergency) for (const n of cfg.emergency_contact_numbers || []) targets.add(n);
  for (const to of targets) {
    Promise.resolve(sendMessage(to, text)).catch((err) =>
      console.error(`[alerts] failed to alert ${to}:`, err.message)
    );
  }
}

module.exports = { alertStaff };
