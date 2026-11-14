// Evaluates the classification prompt on labelled sample tickets (samples/tickets.json).
//
//   With a real model (any OpenAI-compatible API):
//     LLM_API_KEY=... LLM_BASE_URL=https://api.deepseek.com LLM_MODEL=deepseek-chat npm run evaluate
//
//   Without an API key it runs a simple keyword baseline instead, so you can compare
//   how much better the LLM is than a rule-based approach.
const fs = require('fs');
const path = require('path');
const { normalizeTicket, buildChatRequest, extractContent, parseClassification } = require('../src/triage');

const root = path.join(__dirname, '..');
const samples = JSON.parse(fs.readFileSync(path.join(root, 'samples/tickets.json'), 'utf8'));
const systemPrompt = fs.readFileSync(path.join(root, 'prompts/classify-ticket.system.md'), 'utf8').trim();

const apiKey = process.env.LLM_API_KEY;
const config = {
  baseUrl: (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
  model: process.env.LLM_MODEL || 'deepseek-chat',
  temperature: 0,
};

async function classifyWithLlm(ticket) {
  const response = await fetch(config.baseUrl + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(buildChatRequest(ticket, systemPrompt, config)),
  });
  if (!response.ok) throw new Error('LLM API error ' + response.status + ': ' + (await response.text()).slice(0, 200));
  return parseClassification(extractContent(await response.json()));
}

/**
 * Rule-based baseline: generic English keywords only, the kind of rules a team writes first.
 * It cannot understand other languages or context — that is exactly what the LLM is compared against.
 */
function classifyWithKeywords(ticket) {
  const text = (ticket.subject + ' ' + ticket.message).toLowerCase();
  const has = (...words) => words.some((w) => text.includes(w));
  let category = 'other';
  if (has('invoice', 'charged', 'payment', 'card')) category = 'payment';
  else if (has('refund', 'return', 'money back')) category = 'refund_return';
  else if (has('broken', 'damaged', 'missing', 'not arrived', 'nothing has arrived')) category = 'delivery_problem';
  else if (has('order status', 'shipped', 'when will')) category = 'order_status';
  else if (has('contain', 'ingredients', 'allergy')) category = 'product_question';
  else if (has('rude', 'unfriendly', 'bad service')) category = 'complaint';
  const priority = has('asap', 'urgent', 'today', 'allergy', 'twice') ? 'high' : 'medium';
  return { category, priority };
}

(async () => {
  const mode = apiKey ? `LLM ${config.model} @ ${config.baseUrl}` : 'keyword baseline (no LLM_API_KEY set)';
  console.log(`Evaluating ${samples.length} tickets with: ${mode}\n`);
  let categoryOk = 0;
  let priorityOk = 0;
  const rows = [];
  for (const s of samples) {
    const ticket = normalizeTicket(s.ticket);
    const started = Date.now();
    const r = apiKey ? await classifyWithLlm(ticket) : classifyWithKeywords(ticket);
    const ms = Date.now() - started;
    const cOk = r.category === s.expected.category;
    const pOk = r.priority === s.expected.priority;
    categoryOk += cOk;
    priorityOk += pOk;
    rows.push({
      id: s.id,
      expected: `${s.expected.category}/${s.expected.priority}`,
      got: `${r.category}/${r.priority}`,
      category: cOk ? 'ok' : 'WRONG',
      priority: pOk ? 'ok' : 'WRONG',
      ms,
    });
  }
  console.table(rows);
  const pct = (n) => ((100 * n) / samples.length).toFixed(0) + '%';
  console.log(`Category accuracy: ${categoryOk}/${samples.length} (${pct(categoryOk)})`);
  console.log(`Priority accuracy: ${priorityOk}/${samples.length} (${pct(priorityOk)})`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
