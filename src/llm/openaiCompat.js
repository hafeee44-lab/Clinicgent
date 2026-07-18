'use strict';
/**
 * OpenAI-compatible chat-completions adapter — lets the agent brain run on
 * Gemini (free tier), Groq, or any OpenAI-compatible endpoint instead of the
 * Anthropic API. Uses plain fetch; no SDK needed.
 *
 * .env:
 *   LLM_PROVIDER=gemini | groq | openai_compat
 *   LLM_API_KEY=...            (or GEMINI_API_KEY / GROQ_API_KEY)
 *   LLM_MODEL=gemini-3.5-flash (optional; sensible per-provider default)
 *   LLM_BASE_URL=...           (only for openai_compat)
 */
const { toolDefinitions, executeTool } = require('../agent/tools');

const BASE_URLS = {
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai',
  groq: 'https://api.groq.com/openai/v1',
};
const DEFAULT_MODELS = {
  gemini: 'gemini-3.5-flash',
  groq: 'llama-3.3-70b-versatile',
};

function getSettings() {
  const provider = (process.env.LLM_PROVIDER || 'openai_compat').toLowerCase();
  const baseUrl = (process.env.LLM_BASE_URL || BASE_URLS[provider] || '').replace(/\/+$/, '');
  const apiKey = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY;
  const model = process.env.LLM_MODEL || DEFAULT_MODELS[provider];
  if (!baseUrl) throw new Error('LLM_BASE_URL is required for LLM_PROVIDER=openai_compat');
  if (!apiKey) throw new Error('Set LLM_API_KEY (or GEMINI_API_KEY / GROQ_API_KEY) in .env');
  if (!model) throw new Error('Set LLM_MODEL in .env');
  return { baseUrl, apiKey, model };
}

// Anthropic-style tool defs → OpenAI function-calling format
function openAITools() {
  return toolDefinitions.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

async function chatCompletion({ baseUrl, apiKey, model, messages }) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, tools: openAITools(), max_tokens: 1024 }),
  });
  if (!res.ok) throw new Error(`LLM request failed ${res.status}: ${await res.text()}`);
  return res.json();
}

/**
 * Same contract as the Anthropic loop in agent.js:
 * takes system prompt + alternating history, returns final text (or null).
 */
async function runOpenAICompatLoop({ system, history, ctx, maxTurns = 8 }) {
  const settings = getSettings();
  const messages = [{ role: 'system', content: system }, ...history];

  for (let turn = 0; turn < maxTurns; turn++) {
    const data = await chatCompletion({ ...settings, messages });
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg) throw new Error('LLM returned no message');

    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        let result;
        try {
          const input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
          result = executeTool(call.function.name, input, ctx);
        } catch (err) {
          console.error(`[llm] tool ${call.function && call.function.name} failed:`, err);
          result = { error: 'Internal error executing this action. Apologize and offer human handoff.' };
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
      }
      continue;
    }

    const text = (msg.content || '').trim();
    return text || null;
  }

  return 'I’m sorry, I’m having trouble completing that right now. Let me connect you with our front desk — someone will reply to you here shortly.';
}

module.exports = { runOpenAICompatLoop };
