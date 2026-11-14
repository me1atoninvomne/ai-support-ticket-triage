// Run with: npm test   (uses the built-in Node.js test runner, no dependencies)
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTicket, buildChatRequest, extractContent, parseClassification } = require('../src/triage');

const NOW = new Date('2026-03-01T10:00:00Z');

test('normalizeTicket trims fields and lower-cases the email', () => {
  const t = normalizeTicket({ email: '  Anna@Example.COM ', subject: ' Late order ', message: '  Where is my order?  ' }, NOW);
  assert.equal(t.customer_email, 'anna@example.com');
  assert.equal(t.subject, 'Late order');
  assert.equal(t.message, 'Where is my order?');
  assert.equal(t.received_at, '2026-03-01T10:00:00.000Z');
  assert.match(t.ticket_id, /^T-[0-9A-Z]+$/);
});

test('normalizeTicket keeps a given ticket id', () => {
  assert.equal(normalizeTicket({ ticket_id: 'ABC-1', message: 'hi' }, NOW).ticket_id, 'ABC-1');
});

test('normalizeTicket rejects an empty message', () => {
  assert.throws(() => normalizeTicket({ subject: 'x', message: '   ' }, NOW), /empty/);
  assert.throws(() => normalizeTicket(undefined, NOW), /empty/);
});

test('normalizeTicket cuts very long messages', () => {
  assert.equal(normalizeTicket({ message: 'a'.repeat(10000) }, NOW).message.length, 4000);
});

test('buildChatRequest asks for JSON output and includes the ticket', () => {
  const req = buildChatRequest({ subject: 'S', message: 'M' }, 'SYSTEM', { model: 'deepseek-chat', temperature: 0 });
  assert.equal(req.model, 'deepseek-chat');
  assert.deepEqual(req.response_format, { type: 'json_object' });
  assert.equal(req.messages[0].content, 'SYSTEM');
  assert.match(req.messages[1].content, /Subject: S[\s\S]*Message:\nM/);
});

test('extractContent supports OpenAI-style and Anthropic-style responses', () => {
  assert.equal(extractContent({ choices: [{ message: { content: '{"a":1}' } }] }), '{"a":1}');
  assert.equal(extractContent({ content: [{ type: 'text', text: 'hello' }] }), 'hello');
  assert.equal(extractContent({}), '');
});

test('parseClassification accepts a clean answer', () => {
  const r = parseClassification(JSON.stringify({
    category: 'delivery_problem', priority: 'medium', sentiment: 'negative', language: 'de',
    summary: 'Customer received a damaged box of eggs.', suggested_reply: 'Es tut uns leid ...',
  }));
  assert.equal(r.category, 'delivery_problem');
  assert.equal(r.language, 'de');
  assert.equal(r.needs_human_review, false);
  assert.equal(r.parse_problems, '');
});

test('parseClassification handles code fences and extra text around JSON', () => {
  const raw = 'Sure! Here is the result:\n```json\n{"category":"payment","priority":"high","sentiment":"negative","language":"en","summary":"Double charge.","suggested_reply":"Sorry"}\n```';
  const r = parseClassification(raw);
  assert.equal(r.category, 'payment');
  assert.equal(r.priority, 'high');
  assert.equal(r.needs_human_review, true, 'high priority always goes to a human');
});

test('parseClassification replaces values outside the schema and flags the ticket', () => {
  const r = parseClassification('{"category":"shipping","priority":"URGENT!!","sentiment":"angry","language":"German","summary":"x"}');
  assert.equal(r.category, 'other');
  assert.equal(r.priority, 'medium');
  assert.equal(r.sentiment, 'neutral');
  assert.equal(r.language, 'unknown');
  assert.equal(r.needs_human_review, true);
  assert.match(r.parse_problems, /category "shipping" not allowed/);
});

test('parseClassification survives broken or empty output', () => {
  for (const raw of ['', 'I cannot help with that.', '{"category": "payment", ']) {
    const r = parseClassification(raw);
    assert.equal(r.category, 'other');
    assert.equal(r.needs_human_review, true);
  }
});
