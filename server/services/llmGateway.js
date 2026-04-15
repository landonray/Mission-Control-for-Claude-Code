/**
 * LLM Gateway client.
 *
 * Routes all AI API calls through the LLM Gateway instead of
 * hitting provider APIs directly. Uses the OpenAI-compatible
 * chat completions endpoint.
 */

const BASE_URL = 'https://llm-gateway.replit.app';
const API_KEY = process.env.LLM_GATEWAY_KEY;

/**
 * Send a chat completion request via the LLM Gateway.
 *
 * @param {object} opts
 * @param {string} opts.model - Model ID (e.g. 'claude-haiku-4-5')
 * @param {number} opts.max_tokens - Max tokens in response
 * @param {string} [opts.system] - System prompt
 * @param {Array} opts.messages - Array of {role, content} messages
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

  const response = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: allMessages,
      max_tokens,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM Gateway error ${response.status}: ${body}`);
  }

  const data = await response.json();
  // Support both the gateway's native format (data.content) and
  // OpenAI-compatible format (data.choices[0].message.content)
  return data.content
    || (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content)
    || '';
}

module.exports = { chatCompletion };
