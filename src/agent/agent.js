'use strict';
const { toolDefinitions, executeTool } = require('./tools');
const { buildSystemPrompt } = require('./prompts');
const { getRecentMessages } = require('../services/conversations');

const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
const MAX_TURNS = 8;

/* ---------- Anthropic (Claude) loop ---------- */
let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropicClient = new Anthropic(); // uses ANTHROPIC_API_KEY
  }
  return anthropicClient;
}

async function runAnthropicLoop({ system, history, ctx }) {
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-5';
  const messages = [...history];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await getAnthropicClient().messages.create({
      model,
      max_tokens: 1024,
      system,
      tools: toolDefinitions,
      messages,
    });

    if (response.stop_reason === 'tool_use') {
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        let result;
        try {
          result = executeTool(block.name, block.input || {}, ctx);
        } catch (err) {
          console.error(`[agent] tool ${block.name} failed:`, err);
          result = { error: 'Internal error executing this action. Apologize and offer human handoff.' };
        }
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    return text || null;
  }

  return 'I’m sorry, I’m having trouble completing that right now. Let me connect you with our front desk — someone will reply to you here shortly.';
}

/* ---------- shared entry point ---------- */
/**
 * Run the agent loop for one inbound patient message.
 * The inbound message must already be saved; history is read from the DB.
 * Returns the final assistant text to send back (or null if the model chose silence).
 */
async function runAgent({ patient, conversation, extraContext = '' }) {
  const raw = getRecentMessages(conversation.id, 20);
  const history = [];
  for (const m of raw) {
    const role = m.direction === 'in' ? 'user' : 'assistant';
    // merge consecutive same-role messages (APIs require alternation)
    if (history.length && history[history.length - 1].role === role) {
      history[history.length - 1].content += '\n' + m.body;
    } else {
      history.push({ role, content: m.body });
    }
  }
  if (!history.length || history[history.length - 1].role !== 'user') return null;

  const system = buildSystemPrompt(patient, extraContext);
  const ctx = { patient, conversation };

  if (LLM_PROVIDER === 'anthropic') {
    return runAnthropicLoop({ system, history, ctx });
  }
  const { runOpenAICompatLoop } = require('../llm/openaiCompat');
  return runOpenAICompatLoop({ system, history, ctx, maxTurns: MAX_TURNS });
}

module.exports = { runAgent };
