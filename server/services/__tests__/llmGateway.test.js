import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

process.env.LLM_GATEWAY_KEY ||= 'test-key';

const gateway = await import('../llmGateway.js');

/**
 * Build a fake fetch Response whose body streams the given chunks as
 * UTF-8 text via a ReadableStream. Mirrors the SSE shape the LLM Gateway
 * sends back when stream:true is set.
 */
function streamingResponse(chunks, { ok = true, status = 200 } = {}) {
  const encoder = new TextEncoder();
  let i = 0;
  const stream = new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
  return {
    ok,
    status,
    body: stream,
    text: async () => chunks.join(''),
  };
}

describe('llmGateway.chatCompletion', () => {
  beforeEach(() => {
    gateway._resetForTests();
  });

  afterEach(() => {
    gateway._resetForTests();
  });

  it('requests stream:true so long completions don\'t hit the gateway timeout', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(streamingResponse([
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    gateway._setFetchForTests(fakeFetch);

    await gateway.chatCompletion({
      model: 'claude-sonnet-4-5',
      max_tokens: 1000,
      messages: [{ role: 'user', content: 'hi' }],
    });

    const body = JSON.parse(fakeFetch.mock.calls[0][1].body);
    expect(body.stream).toBe(true);
    expect(body.model).toBe('claude-sonnet-4-5');
  });

  it('accumulates OpenAI-style delta chunks across multiple SSE events', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(streamingResponse([
      'data: {"choices":[{"delta":{"content":"Hello, "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
      'data: [DONE]\n\n',
    ]));
    gateway._setFetchForTests(fakeFetch);

    const out = await gateway.chatCompletion({
      model: 'm', max_tokens: 100,
      messages: [{ role: 'user', content: 'x' }],
    });

    expect(out).toBe('Hello, world!');
  });

  it('handles chunks split across multiple stream reads (partial buffering)', async () => {
    // Single SSE event delivered in three TCP-sized fragments. The parser
    // must wait for "\n\n" before consuming the event.
    const fakeFetch = vi.fn().mockResolvedValue(streamingResponse([
      'data: {"choices":[{"delta":',
      '{"content":"split"}}]',
      '}\n\ndata: [DONE]\n\n',
    ]));
    gateway._setFetchForTests(fakeFetch);

    const out = await gateway.chatCompletion({
      model: 'm', max_tokens: 100,
      messages: [{ role: 'user', content: 'x' }],
    });

    expect(out).toBe('split');
  });

  it('also accepts Anthropic-style delta text chunks', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(streamingResponse([
      'data: {"delta":{"text":"abc"}}\n\n',
      'data: {"delta":{"text":"def"}}\n\n',
      'data: [DONE]\n\n',
    ]));
    gateway._setFetchForTests(fakeFetch);

    const out = await gateway.chatCompletion({
      model: 'm', max_tokens: 10,
      messages: [{ role: 'user', content: 'x' }],
    });

    expect(out).toBe('abcdef');
  });

  it('ignores [DONE] sentinel and unparseable lines', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(streamingResponse([
      ': comment line\n',
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
      'data: not json at all\n\n',
      'data: [DONE]\n\n',
    ]));
    gateway._setFetchForTests(fakeFetch);

    const out = await gateway.chatCompletion({
      model: 'm', max_tokens: 10,
      messages: [{ role: 'user', content: 'x' }],
    });

    expect(out).toBe('ok');
  });

  it('throws with the response body when the gateway returns a non-2xx status', async () => {
    const fakeFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 504,
      text: async () => 'upstream request timeout',
      body: null,
    });
    gateway._setFetchForTests(fakeFetch);

    await expect(gateway.chatCompletion({
      model: 'm', max_tokens: 10,
      messages: [{ role: 'user', content: 'x' }],
    })).rejects.toThrow(/504.*upstream request timeout/);
  });

  it('aborts mid-stream when the AbortSignal fires', async () => {
    const controller = new AbortController();
    const encoder = new TextEncoder();
    let pulls = 0;
    const stream = new ReadableStream({
      async pull(c) {
        pulls += 1;
        if (pulls === 1) {
          c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"part"}}]}\n\n'));
          controller.abort();
        } else if (pulls < 5) {
          c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
        } else {
          c.close();
        }
      },
    });

    const fakeFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, body: stream, text: async () => '',
    });
    gateway._setFetchForTests(fakeFetch);

    await expect(gateway.chatCompletion({
      model: 'm', max_tokens: 10,
      messages: [{ role: 'user', content: 'x' }],
      signal: controller.signal,
    })).rejects.toThrow(/Aborted/);
  });
});
