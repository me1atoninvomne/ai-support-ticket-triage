// Core logic of the triage workflow.
// The same functions run in two places:
//   1. inside the n8n "Code" nodes (scripts/build-workflow.js copies them into the workflow JSON)
//   2. in unit tests (test/triage.test.js) and the evaluation script, using plain Node.js
// Keeping the logic here means it can be tested without n8n.

const CATEGORIES = ['order_status', 'delivery_problem', 'refund_return', 'product_question', 'payment', 'complaint', 'other'];
const PRIORITIES = ['high', 'medium', 'low'];
const SENTIMENTS = ['positive', 'neutral', 'negative'];
const MAX_MESSAGE_LENGTH = 4000;

/** Cleans the raw webhook body and gives every ticket an id and a timestamp. */
function normalizeTicket(body, now) {
  const b = body || {};
  const message = String(b.message || '').trim();
  if (!message) {
    throw new Error('Ticket message is empty');
  }
  const receivedAt = (now || new Date()).toISOString();
  return {
    ticket_id: String(b.ticket_id || 'T-' + Date.parse(receivedAt).toString(36).toUpperCase()),
    received_at: receivedAt,
    customer_email: String(b.email || '').trim().toLowerCase(),
    subject: String(b.subject || '').trim().slice(0, 200),
    message: message.slice(0, MAX_MESSAGE_LENGTH),
  };
}

/**
 * Builds a request body for any OpenAI-compatible Chat Completions API
 * (OpenAI, DeepSeek, Qwen / DashScope compatible mode, many local servers).
 */
function buildChatRequest(ticket, systemPrompt, config) {
  return {
    model: config.model,
    temperature: config.temperature,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Subject: ' + (ticket.subject || '(none)') + '\n\nMessage:\n' + ticket.message },
    ],
  };
}

/** Gets the text answer from an OpenAI-style or Anthropic-style API response. */
function extractContent(apiResponse) {
  const r = apiResponse || {};
  if (r.choices && r.choices[0] && r.choices[0].message) return String(r.choices[0].message.content || '');
  if (Array.isArray(r.content) && r.content[0]) return String(r.content[0].text || '');
  return '';
}

/**
 * Turns the model's text into a safe, validated object.
 * LLMs sometimes wrap JSON in ```code fences```, add text around it, or use values outside the schema.
 * Anything unexpected is replaced with a safe default and the ticket is flagged for human review.
 */
function parseClassification(rawContent) {
  const problems = [];
  let data = {};
  const text = String(rawContent || '').replace(/```(?:json)?/gi, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) {
    problems.push('no JSON object in model output');
  } else {
    try {
      data = JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      problems.push('invalid JSON: ' + e.message);
    }
  }

  const pick = (field, allowed, fallback) => {
    const value = String(data[field] || '').toLowerCase().trim();
    if (allowed.includes(value)) return value;
    problems.push(field + ' "' + value + '" not allowed');
    return fallback;
  };

  const result = {
    category: pick('category', CATEGORIES, 'other'),
    priority: pick('priority', PRIORITIES, 'medium'),
    sentiment: pick('sentiment', SENTIMENTS, 'neutral'),
    language: /^[a-z]{2}$/.test(String(data.language || '').toLowerCase()) ? String(data.language).toLowerCase() : 'unknown',
    summary: String(data.summary || '').trim().slice(0, 300),
    suggested_reply: String(data.suggested_reply || '').trim().slice(0, 1000),
  };
  if (!result.summary) problems.push('summary missing');
  result.needs_human_review = problems.length > 0 || result.priority === 'high';
  result.parse_problems = problems.join('; ');
  return result;
}

// --- not copied into n8n (n8n Code nodes have no module system) ---
if (typeof module !== 'undefined') {
  module.exports = { normalizeTicket, buildChatRequest, extractContent, parseClassification, CATEGORIES, PRIORITIES, SENTIMENTS };
}
