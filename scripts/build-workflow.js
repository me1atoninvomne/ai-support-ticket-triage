// Generates workflow/ai-support-ticket-triage.n8n.json from src/triage.js and the prompt file.
// Run after changing the logic or the prompt:  npm run build
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/triage.js'), 'utf8');
const prompt = fs.readFileSync(path.join(root, 'prompts/classify-ticket.system.md'), 'utf8').trim();

// Only the functions are copied into n8n; the module.exports part is cut off.
const functions = source.split('// --- not copied into n8n')[0].trim();
const escapeForTemplate = (s) => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const normalizeCode = `// ===== CONFIG — choose the LLM provider (any OpenAI-compatible API) =====
// DeepSeek: baseUrl 'https://api.deepseek.com',                              model 'deepseek-chat'
// Qwen:     baseUrl 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', model 'qwen-plus'
// OpenAI:   baseUrl 'https://api.openai.com/v1',                             model 'gpt-4o-mini'
const CONFIG = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', temperature: 0 };

const SYSTEM_PROMPT = \`${escapeForTemplate(prompt)}\`;

${functions}

return $input.all().map((item) => {
  const ticket = normalizeTicket(item.json.body);
  return {
    json: {
      ...ticket,
      llm_url: CONFIG.baseUrl.replace(/\\/$/, '') + '/chat/completions',
      chat_request: buildChatRequest(ticket, SYSTEM_PROMPT, CONFIG),
    },
  };
});
`;

const parseCode = `${functions}

// Pair every LLM answer with the ticket it belongs to (same order).
const tickets = $('Normalize ticket').all();
return $input.all().map((item, i) => {
  const t = tickets[i].json;
  const c = parseClassification(extractContent(item.json));
  return {
    json: {
      ticket_id: t.ticket_id,
      received_at: t.received_at,
      customer_email: t.customer_email,
      subject: t.subject,
      category: c.category,
      priority: c.priority,
      sentiment: c.sentiment,
      language: c.language,
      summary: c.summary,
      suggested_reply: c.suggested_reply,
      needs_human_review: c.needs_human_review,
      parse_problems: c.parse_problems,
      message: t.message,
    },
  };
});
`;

const node = (id, name, type, typeVersion, position, parameters, extra = {}) =>
  ({ parameters, id, name, type, typeVersion, position, ...extra });

const workflow = {
  name: 'AI Support Ticket Triage',
  nodes: [
    node('8f1d2c9a-0a51-4c3e-9b0e-1a2b3c4d5e01', 'Support ticket webhook', 'n8n-nodes-base.webhook', 2, [0, 300], {
      httpMethod: 'POST',
      path: 'support-ticket',
      responseMode: 'responseNode',
      options: {},
    }, { webhookId: 'f3a9c1e2-7b64-4d2a-9c11-5e6f7a8b9c01' }),

    node('8f1d2c9a-0a51-4c3e-9b0e-1a2b3c4d5e02', 'Normalize ticket', 'n8n-nodes-base.code', 2, [220, 300], {
      jsCode: normalizeCode,
    }),

    node('8f1d2c9a-0a51-4c3e-9b0e-1a2b3c4d5e03', 'Classify with LLM', 'n8n-nodes-base.httpRequest', 4.2, [440, 300], {
      method: 'POST',
      url: '={{ $json.llm_url }}',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: '={{ JSON.stringify($json.chat_request) }}',
      options: { timeout: 30000 },
    }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 }),

    node('8f1d2c9a-0a51-4c3e-9b0e-1a2b3c4d5e04', 'Parse AI answer', 'n8n-nodes-base.code', 2, [660, 300], {
      jsCode: parseCode,
    }),

    node('8f1d2c9a-0a51-4c3e-9b0e-1a2b3c4d5e05', 'Log to Google Sheets', 'n8n-nodes-base.googleSheets', 4.5, [880, 300], {
      operation: 'append',
      documentId: { __rl: true, value: '', mode: 'id' },
      sheetName: { __rl: true, value: 'Tickets', mode: 'name' },
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: [] },
      options: {},
    }),

    node('8f1d2c9a-0a51-4c3e-9b0e-1a2b3c4d5e06', 'Is urgent?', 'n8n-nodes-base.if', 2, [1100, 300], {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'strict' },
        conditions: [{
          id: '2c6f0d7e-4a3b-4b8e-8f61-0c1d2e3f4a01',
          leftValue: "={{ $('Parse AI answer').item.json.priority }}",
          rightValue: 'high',
          operator: { type: 'string', operation: 'equals' },
        }],
        combinator: 'and',
      },
      options: {},
    }),

    node('8f1d2c9a-0a51-4c3e-9b0e-1a2b3c4d5e07', 'Alert support team in Slack', 'n8n-nodes-base.slack', 2.2, [1320, 200], {
      select: 'channel',
      channelId: { __rl: true, value: '#support-urgent', mode: 'name' },
      text: "=URGENT ticket {{ $('Parse AI answer').item.json.ticket_id }} ({{ $('Parse AI answer').item.json.category }})\n"
        + "From: {{ $('Parse AI answer').item.json.customer_email }}\n"
        + "Summary: {{ $('Parse AI answer').item.json.summary }}",
      otherOptions: {},
    }),

    node('8f1d2c9a-0a51-4c3e-9b0e-1a2b3c4d5e08', 'Respond to sender', 'n8n-nodes-base.respondToWebhook', 1.1, [1540, 300], {
      respondWith: 'json',
      responseBody: "={{ JSON.stringify({ ok: true, ticket_id: $('Parse AI answer').item.json.ticket_id, "
        + "category: $('Parse AI answer').item.json.category, priority: $('Parse AI answer').item.json.priority, "
        + "needs_human_review: $('Parse AI answer').item.json.needs_human_review }) }}",
      options: {},
    }),
  ],
  connections: {
    'Support ticket webhook': { main: [[{ node: 'Normalize ticket', type: 'main', index: 0 }]] },
    'Normalize ticket': { main: [[{ node: 'Classify with LLM', type: 'main', index: 0 }]] },
    'Classify with LLM': { main: [[{ node: 'Parse AI answer', type: 'main', index: 0 }]] },
    'Parse AI answer': { main: [[{ node: 'Log to Google Sheets', type: 'main', index: 0 }]] },
    'Log to Google Sheets': { main: [[{ node: 'Is urgent?', type: 'main', index: 0 }]] },
    'Is urgent?': {
      main: [
        [{ node: 'Alert support team in Slack', type: 'main', index: 0 }],
        [{ node: 'Respond to sender', type: 'main', index: 0 }],
      ],
    },
    'Alert support team in Slack': { main: [[{ node: 'Respond to sender', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1' },
  pinData: {},
  meta: { templateCredsSetupCompleted: false },
};

const out = path.join(root, 'workflow/ai-support-ticket-triage.n8n.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2) + '\n');
console.log('Workflow written to', path.relative(root, out));
