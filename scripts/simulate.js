'use strict';
/**
 * CLI chat simulator — talk to the agent as if you were a patient on WhatsApp,
 * without any WhatsApp setup. Requires ANTHROPIC_API_KEY. Uses the mock provider.
 *
 *   npm run simulate                      # default test patient number
 *   npm run simulate -- +923219998877     # specific number
 *
 * Staff commands also work if you simulate from a staff number in clinic.json.
 */
process.env.WA_PROVIDER = 'mock';
require('../src/config');
const readline = require('readline');
const { handleIncoming } = require('../src/pipeline');

const phone = process.argv[2] || '+923219990001';
console.log(`Simulating WhatsApp chat as ${phone}. Type a message, Ctrl+C to exit.\n`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'patient> ' });
rl.prompt();
rl.on('line', async (line) => {
  const text = line.trim();
  if (text) {
    try {
      await handleIncoming(phone, text);
    } catch (err) {
      console.error('Error:', err.message);
    }
  }
  rl.prompt();
});
