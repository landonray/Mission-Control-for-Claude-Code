/**
 * LLM Gateway client.
 *
 * Routes all AI API calls through the LLM Gateway instead of
 * hitting provider APIs directly. Uses the OpenAI-compatible
 * chat completions endpoint with streaming so long responses
 * (e.g. 10k+ token doc syntheses) don't trip the gateway's
 * per-request timeout.
 */

const BASE_URL = 'https://llm-gateway.replit.app';
const API_KEY = process.env.LLM_GATEWAY_KEY;

// Test seam — replaced by tests so we don't actually hit the network.
let _fetch = (...args) => fetch(...args);
function _setFetchForTests(fn) { _fetch = fn; }
function _resetForTests() { _fetch = (...args) => fetch(...args); }

/**
 * Send a chat completion request via the LLM Gateway. Returns the full
 * accumulated response as a single string — callers don't need to know
 * the response was streamed.
 *
 * @param {object} opts
 * @param {string} opts.model - Model ID (e.g. 'claude-sonnet-4-5')
 * @param {number} opts.max_tokens - Max tokens in response
 * @param {string} [opts.system] - System prompt
 * @param {Array} opts.messages - Array of {role, content} messages
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} The assistant's text response
 */
async function chatCompletion({ model, max_tokens, system, messages, signal }) {
  if (!API_KEY) {
    throw new Error('LLM_GATEWAY_KEY environment variable is not set');
  }

  if (signal?.aborted) throw new Error('Aborted');

  // Prepend system message if provided (OpenAI-compatible format)
  const allMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  const response = await _fetch(`${BASE_URL}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: allMessages,
      max_tokens,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM Gateway error ${response.status}: ${body}`);
  }

  return readStreamedResponse(response, signal);
}

/**
 * Drain an OpenAI-style SSE chat completion stream and return the
 * concatenated text. Tolerates multiple chunk shapes (OpenAI delta,
 * Anthropic delta, gateway-native content) so we don't break if the
 * gateway shifts its passthrough format.
 */
async function readStreamedResponse(response, signal) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    // Some test/mocked environments may not produce a real stream.
    const text = await response.text();
    return parseFallbackBody(text);
  }

  const decoder = new TextDecoder();
  let accumulated = '';
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) throw new Error('Aborted');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line ("\n\n").
      let sepIdx;
      while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        accumulated += extractEventContent(event);
      }
    }
    // Flush any trailing event without a terminating blank line.
    if (buffer.trim()) accumulated += extractEventContent(buffer);
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }

  return accumulated;
}

function extractEventContent(eventText) {
  let chunk = '';
  for (const rawLine of eventText.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let parsed;
    try { parsed = JSON.parse(payload); } catch { continue; }
    chunk += extractChunkText(parsed);
  }
  return chunk;
}

function extractChunkText(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';
  // OpenAI streaming format: choices[0].delta.content
  const openAiDelta = parsed.choices?.[0]?.delta?.content;
  if (typeof openAiDelta === 'string') return openAiDelta;
  // OpenAI non-streaming-shaped chunk (some gateways emit one big chunk)
  const openAiMessage = parsed.choices?.[0]?.message?.content;
  if (typeof openAiMessage === 'string') return openAiMessage;
  // Anthropic-style delta
  const anthropicDelta = parsed.delta?.text;
  if (typeof anthropicDelta === 'string') return anthropicDelta;
  // Gateway-native shape
  if (typeof parsed.content === 'string') return parsed.content;
  if (typeof parsed.text === 'string') return parsed.text;
  return '';
}

/**
 * Fallback for when response.body isn't a stream (e.g. some test mocks).
 * Tries to parse a single JSON body in either OpenAI or gateway-native
 * shape so non-streaming tests still work.
 */
function parseFallbackBody(text) {
  try {
    const data = JSON.parse(text);
    return data.content
      || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
      || '';
  } catch {
    return text;
  }
}

module.exports = { chatCompletion, _setFetchForTests, _resetForTests };
