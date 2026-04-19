import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const transcribeService = require('../services/transcribe');
const transcribeRouter = require('../routes/transcribe');

function makeApp() {
  const app = express();
  app.use('/api/transcribe', transcribeRouter);
  return app;
}

describe('POST /api/transcribe', () => {
  let transcribeAudio;

  beforeEach(() => {
    transcribeAudio = vi.spyOn(transcribeService, 'transcribeAudio');
  });

  afterEach(() => {
    transcribeAudio.mockRestore();
  });

  it('returns the transcribed text', async () => {
    transcribeAudio.mockResolvedValueOnce('hello world');
    const app = makeApp();
    const res = await request(app)
      .post('/api/transcribe')
      .attach('file', Buffer.from('fake-audio'), { filename: 'audio.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: 'hello world' });
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    const arg = transcribeAudio.mock.calls[0][0];
    expect(Buffer.isBuffer(arg.buffer)).toBe(true);
    expect(arg.buffer.toString()).toBe('fake-audio');
    expect(arg.mimeType).toBe('audio/webm');
    expect(arg.filename).toBe('audio.webm');
  });

  it('returns 400 when no file is uploaded', async () => {
    const app = makeApp();
    const res = await request(app).post('/api/transcribe');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no audio/i);
    expect(transcribeAudio).not.toHaveBeenCalled();
  });

  it('returns 500 when the service throws', async () => {
    transcribeAudio.mockRejectedValueOnce(new Error('gateway exploded'));
    const app = makeApp();
    const res = await request(app)
      .post('/api/transcribe')
      .attach('file', Buffer.from('fake-audio'), { filename: 'a.webm', contentType: 'audio/webm' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/gateway exploded/);
  });
});
