// Runs the JavaScript from the generated n8n Code nodes in a sandbox that imitates n8n
// ($input and $('Node name')), so we know the exported workflow actually works.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const workflow = require('../workflow/ai-support-ticket-triage.n8n.json');

const nodeByName = (name) => workflow.nodes.find((n) => n.name === name);

function runCodeNode(name, inputItems, otherNodes = {}) {
  const code = nodeByName(name).parameters.jsCode;
  const sandbox = {
    $input: { all: () => inputItems },
    $: (nodeName) => ({ all: () => otherNodes[nodeName] }),
    Date,
    JSON,
  };
  // n8n wraps Code node content in a function, so a top-level `return` is allowed
  return vm.runInNewContext('(function () {' + code + '\n})()', sandbox);
}

test('every connection points to an existing node', () => {
  const names = new Set(workflow.nodes.map((n) => n.name));
  for (const [from, conn] of Object.entries(workflow.connections)) {
    assert.ok(names.has(from), from);
    conn.main.flat().forEach((c) => assert.ok(names.has(c.node), c.node));
  }
});

test('"Normalize ticket" node builds the LLM request', () => {
  const out = runCodeNode('Normalize ticket', [
    { json: { body: { email: 'A@B.com', subject: 'Eggs', message: 'Half of the eggs were broken.' } } },
  ]);
  assert.equal(out.length, 1);
  const t = out[0].json;
  assert.equal(t.customer_email, 'a@b.com');
  assert.equal(t.llm_url, 'https://api.deepseek.com/chat/completions');
  assert.equal(t.chat_request.model, 'deepseek-chat');
  assert.match(t.chat_request.messages[0].content, /support-ticket triage assistant/);
  assert.match(t.chat_request.messages[1].content, /Half of the eggs were broken/);
});

test('"Parse AI answer" node pairs the answer with its ticket', () => {
  const ticket = { ticket_id: 'T-1', received_at: 'now', customer_email: 'a@b.com', subject: 'Eggs', message: 'Broken eggs' };
  const llmResponse = {
    choices: [{ message: { content: '{"category":"delivery_problem","priority":"medium","sentiment":"negative","language":"en","summary":"Broken eggs in delivery.","suggested_reply":"Sorry!"}' } }],
  };
  const out = runCodeNode('Parse AI answer', [{ json: llmResponse }], { 'Normalize ticket': [{ json: ticket }] });
  const r = out[0].json;
  assert.equal(r.ticket_id, 'T-1');
  assert.equal(r.category, 'delivery_problem');
  assert.equal(r.needs_human_review, false);
  assert.equal(r.message, 'Broken eggs');
});
