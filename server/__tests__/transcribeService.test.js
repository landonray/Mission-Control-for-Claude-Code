import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { transcribeAudio } = require('../services/transcribe');

describe('transcribeAudio', () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.LLM_GATEWAY_KEY;

  beforeEach(() => {
    process.env.LLM_GATEWAY_KEY = 'test-key';
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env.LLM_GATEWAY_KEY = originalKey;
  });

  it('posts multipart audio to the gateway and returns the transcribed text', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'hello world' }),
    });
    global.fetch = mockFetch;

    const buffer = Buffer.from('fake-audio-bytes');
    const text = await transcribeAudio({ buffer, mimeType: 'audio/webm', filename: 'audio.webm' });

    expect(text).toBe('hello world');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://llm-gateway.replit.app/api/v1/audio/transcriptions');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer test-key');
    expect(opts.body).toBeInstanceOf(FormData);
  });

  it('throws when LLM_GATEWAY_KEY is not set', async () => {
    delete process.env.LLM_GATEWAY_KEY;
    await expect(
      transcribeAudio({ buffer: Buffer.from('x'), mimeType: 'audio/webm', filename: 'a.webm' })
    ).rejects.toThrow(/LLM_GATEWAY_KEY/);
  });

  it('throws with the gateway error body when the response is not ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'gateway exploded',
    });
    await expect(
      transcribeAudio({ buffer: Buffer.from('x'), mimeType: 'audio/webm', filename: 'a.webm' })
    ).rejects.toThrow(/500.*gateway exploded/);
  });

  it('returns an empty string when the gateway returns no text field', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    const text = await transcribeAudio({
      buffer: Buffer.from('x'),
      mimeType: 'audio/webm',
      filename: 'a.webm',
    });
    expect(text).toBe('');
  });
});
