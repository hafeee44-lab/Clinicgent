'use strict';
/**
 * WhatsApp provider abstraction. All outbound messages go through sendMessage(to, text).
 * Providers: "meta" (WhatsApp Business Cloud API), "twilio", "mock" (console/testing).
 * Both real providers are implemented with plain fetch — no extra SDK dependencies.
 */
require('dotenv').config();

const PROVIDER = (process.env.WA_PROVIDER || 'mock').toLowerCase();
const DRY_RUN = process.env.DRY_RUN === '1';

// mock provider keeps an in-memory log so tests/simulator can inspect outbound messages
const mockOutbox = [];

async function sendMeta(to, text) {
  const url = `https://graph.facebook.com/v20.0/${process.env.META_WA_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.META_WA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: to.replace(/^\+/, ''),
      type: 'text',
      text: { body: text },
    }),
  });
  if (!res.ok) throw new Error(`Meta send failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sendTwilio(to, text) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const body = new URLSearchParams({
    From: process.env.TWILIO_WA_FROM,
    To: `whatsapp:${to}`,
    Body: text,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) throw new Error(`Twilio send failed ${res.status}: ${await res.text()}`);
  return res.json();
}

async function sendMessage(to, text) {
  if (!text) return;
  if (DRY_RUN || PROVIDER === 'mock') {
    mockOutbox.push({ to, text, at: new Date().toISOString() });
    console.log(`\n[WA → ${to}]\n${text}\n`);
    return { mock: true };
  }
  if (PROVIDER === 'meta') return sendMeta(to, text);
  if (PROVIDER === 'twilio') return sendTwilio(to, text);
  throw new Error(`Unknown WA_PROVIDER: ${PROVIDER}`);
}

module.exports = { sendMessage, mockOutbox, PROVIDER };
