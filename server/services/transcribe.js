/**
 * Audio transcription via the LLM Gateway (OpenAI-compatible Whisper endpoint).
 *
 * The gateway key is server-side only; the browser never sees it.
 */

const BASE_URL = 'https://llm-gateway.replit.app';
const ENDPOINT = '/api/v1/audio/transcriptions';
const MODEL = 'whisper-1';

/**
 * @param {object} opts
 * @param {Buffer} opts.buffer - Raw audio bytes.
 * @param {string} opts.mimeType - e.g. 'audio/webm'.
 * @param {string} opts.filename - e.g. 'audio.webm'. Whisper uses the extension to guess the format.
 * @returns {Promise<string>} Transcribed text (may be empty for silence).
 */
async function transcribeAudio({ buffer, mimeType, filename }) {
  const apiKey = process.env.LLM_GATEWAY_KEY;
  if (!apiKey) {
    throw new Error('LLM_GATEWAY_KEY environment variable is not set');
  }

  const form = new FormData();
  const blob = new Blob([buffer], { type: mimeType });
  form.append('file', blob, filename);
  form.append('model', MODEL);

  const response = await fetch(`${BASE_URL}${ENDPOINT}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM Gateway error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return data.text || '';
}

module.exports = { transcribeAudio };
