import { describe, expect, it, vi } from 'vitest';
import {
  classifyOllamaRuntime,
  getOllamaPsStatus,
  isGpuResidentPlausible,
  isModelInstalled,
  normalizeOllamaChatResponse,
  parseOllamaOffloadLayers,
  runOllamaPreflight,
} from './ollamaPreflight';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('isModelInstalled', () => {
  it('matches an exact tag', () => {
    expect(isModelInstalled('qwen3:14b', ['qwen3:14b', 'llama3.1:8b'])).toBe(true);
  });
  it('matches a base name without tag against any tag', () => {
    expect(isModelInstalled('qwen3', ['qwen3:14b'])).toBe(true);
  });
  it('tolerates a quant suffix', () => {
    expect(isModelInstalled('qwen3:14b', ['qwen3:14b-q4_K_M'])).toBe(true);
  });
  it('is case-insensitive', () => {
    expect(isModelInstalled('Qwen3:14B', ['qwen3:14b'])).toBe(true);
  });
  it('returns false when not installed', () => {
    expect(isModelInstalled('qwen3:14b', ['llama3.1:8b'])).toBe(false);
  });
});

describe('runOllamaPreflight', () => {
  const base = { host: 'http://localhost:11434', model: 'qwen3:14b' };

  it('fails with reason "unreachable" when /api/tags throws', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await runOllamaPreflight({ ...base, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unreachable');
      expect(result.stage).toBe('reachable');
    }
  });

  it('fails with reason "unreachable" on a non-ok /api/tags', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 500)) as unknown as typeof fetch;
    const result = await runOllamaPreflight({ ...base, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unreachable');
  });

  it('fails with reason "model_missing" when the model is not installed', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ models: [{ name: 'llama3.1:8b' }] }),
    ) as unknown as typeof fetch;
    const result = await runOllamaPreflight({ ...base, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('model_missing');
      expect(result.installedModels).toContain('llama3.1:8b');
    }
  });

  it('fails with reason "smoke_failed" when the chat call errors (e.g. HTTP 500)', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({ models: [{ name: 'qwen3:14b' }] });
      }
      return jsonResponse('boom', false, 500); // /api/chat -> 500 (the prod symptom)
    }) as unknown as typeof fetch;
    const result = await runOllamaPreflight({ ...base, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('smoke_failed');
      expect(result.stage).toBe('smoke');
    }
  });

  it('fails with reason "smoke_failed" when the chat answer is empty', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({ models: [{ name: 'qwen3:14b' }] });
      }
      return jsonResponse({ message: { content: '   ' } });
    }) as unknown as typeof fetch;
    const result = await runOllamaPreflight({ ...base, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('smoke_failed');
  });

  it('passes when reachable + model present + smoke ok', async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => {
      if (String(url).endsWith('/api/tags')) {
        return jsonResponse({ models: [{ name: 'qwen3:14b' }] });
      }
      return jsonResponse({ message: { content: '{"ok":true}' } });
    }) as unknown as typeof fetch;
    const result = await runOllamaPreflight({ ...base, fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.model).toBe('qwen3:14b');
      expect(result.installedModels).toContain('qwen3:14b');
    }
  });

  // --- /api/ps residency interplay (external Ollama, warm-but-slow model) ---

  // Routes /api/tags (installed) + /api/ps (residency) + /api/chat (smoke).
  function routedFetch(opts: {
    ps?: unknown;
    chat?: () => Promise<Response>;
  }): typeof fetch {
    return vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'qwen3:14b' }] });
      if (u.endsWith('/api/ps')) return jsonResponse(opts.ps ?? { models: [] });
      if (u.endsWith('/api/chat')) return (opts.chat ?? (async () => jsonResponse({ message: { content: 'x' } })))();
      throw new Error('unexpected url ' + u);
    }) as unknown as typeof fetch;
  }

  const psLoaded = { models: [{ name: 'qwen3:14b', size: 9_400_000_000, size_vram: 9_400_000_000 }] };

  it('SOFT-PASSES (ok + warning) when the smoke times out but /api/ps shows the model GPU-resident', async () => {
    const fetchImpl = routedFetch({
      ps: psLoaded,
      chat: async () => {
        throw new Error('aborted'); // simulate smoke timeout
      },
    });
    const result = await runOllamaPreflight({ ...base, fetchImpl, smokeTimeoutMs: 6000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warning).toMatch(/Smoke-Test/i);
      expect(result.ps?.loaded).toBe(true);
    }
  });

  it('passes WITHOUT warning when the model is loaded and the smoke is fine', async () => {
    const fetchImpl = routedFetch({ ps: psLoaded, chat: async () => jsonResponse({ message: { content: 'ok' } }) });
    const result = await runOllamaPreflight({ ...base, fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.warning ?? null).toBeNull();
  });

  it('skips the chat smoke entirely when the model is loaded and skipSmokeIfLoaded=true', async () => {
    const chat = vi.fn(async () => jsonResponse({ message: { content: 'should not be called' } }));
    const fetchImpl = vi.fn(async (url: string | URL) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'qwen3:14b' }] });
      if (u.endsWith('/api/ps')) return jsonResponse(psLoaded);
      if (u.endsWith('/api/chat')) return chat();
      throw new Error('unexpected ' + u);
    }) as unknown as typeof fetch;
    const result = await runOllamaPreflight({ ...base, fetchImpl, skipSmokeIfLoaded: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.smokeSkipped).toBe(true);
    expect(chat).not.toHaveBeenCalled();
  });

  it('still FAILS when the smoke times out and the model is NOT loaded', async () => {
    const fetchImpl = routedFetch({
      ps: { models: [] }, // nothing loaded
      chat: async () => {
        throw new Error('aborted');
      },
    });
    const result = await runOllamaPreflight({ ...base, fetchImpl, smokeTimeoutMs: 4000 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('smoke_failed');
  });

  // --- Thinking-model compatibility (Qwen3) + controlled single retry ----------

  // Sequenced router: each /api/chat and /api/ps call advances through its list
  // (the last entry repeats), so we can model "first call X, retry Y" and
  // "ps cold before / loaded after". Also records the parsed /api/chat bodies.
  function seqFetch(opts: {
    chat: Array<() => Promise<Response>>;
    ps?: unknown[] | unknown;
  }): {
    fetchImpl: typeof fetch;
    chatCalls: () => number;
    psCalls: () => number;
    bodies: () => Array<Record<string, unknown>>;
  } {
    let chatIdx = 0;
    let psIdx = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/api/tags')) return jsonResponse({ models: [{ name: 'qwen3:14b' }] });
      if (u.endsWith('/api/ps')) {
        const ps = Array.isArray(opts.ps)
          ? opts.ps[Math.min(psIdx, opts.ps.length - 1)]
          : opts.ps;
        psIdx += 1;
        return jsonResponse(ps ?? { models: [] });
      }
      if (u.endsWith('/api/chat')) {
        if (init?.body) bodies.push(JSON.parse(String(init.body)));
        const fn = opts.chat[Math.min(chatIdx, opts.chat.length - 1)];
        chatIdx += 1;
        return fn();
      }
      throw new Error('unexpected url ' + u);
    }) as unknown as typeof fetch;
    return { fetchImpl, chatCalls: () => chatIdx, psCalls: () => psIdx, bodies: () => bodies };
  }

  const thinkingOnly = () => jsonResponse({ message: { thinking: 'let me think…', content: '' }, done: true, done_reason: 'length' });
  const emptyBoth = () => jsonResponse({ message: { content: '' }, done: true, done_reason: 'length' });
  const finalOk = () => jsonResponse({ message: { content: 'ok' }, done: true, done_reason: 'stop' });

  it('sends think:false and a >1 token budget on the smoke (no single-token starvation)', async () => {
    const seq = seqFetch({ chat: [finalOk] });
    const result = await runOllamaPreflight({ ...base, fetchImpl: seq.fetchImpl });
    expect(result.ok).toBe(true);
    const body = seq.bodies()[0];
    expect(body.think).toBe(false);
    expect((body.options as { num_predict: number }).num_predict).toBeGreaterThan(1);
  });

  it('Qwen3 thinking-only first, final content on retry → ok (recovered_after_retry)', async () => {
    const seq = seqFetch({ chat: [thinkingOnly, finalOk] });
    const result = await runOllamaPreflight({ ...base, fetchImpl: seq.fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.diagnostic).toBe('recovered_after_retry');
      expect(result.smoke?.retried).toBe(true);
      expect(result.warning).toMatch(/Retry/i);
    }
    expect(seq.chatCalls()).toBe(2); // exactly one retry
  });

  it('first call empty (num_predict starvation), retry succeeds → ok', async () => {
    const seq = seqFetch({ chat: [emptyBoth, finalOk] });
    const result = await runOllamaPreflight({ ...base, fetchImpl: seq.fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diagnostic).toBe('recovered_after_retry');
    expect(seq.chatCalls()).toBe(2);
  });

  it('both calls HTTP 200 but final empty → smoke_failed (empty_response), retried once', async () => {
    const seq = seqFetch({ chat: [emptyBoth, emptyBoth] });
    const result = await runOllamaPreflight({ ...base, fetchImpl: seq.fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('smoke_failed');
      expect(result.diagnostic).toBe('empty_response');
    }
    expect(seq.chatCalls()).toBe(2);
  });

  it('persistent thinking-only (even after retry) → smoke_failed (empty_final_after_thinking)', async () => {
    const seq = seqFetch({ chat: [thinkingOnly, thinkingOnly] });
    const result = await runOllamaPreflight({ ...base, fetchImpl: seq.fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic).toBe('empty_final_after_thinking');
  });

  it('HTTP 500 → smoke_failed (http_error) with NO retry', async () => {
    const seq = seqFetch({ chat: [() => jsonResponse('boom', false, 500)] });
    const result = await runOllamaPreflight({ ...base, fetchImpl: seq.fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.diagnostic).toBe('http_error');
    expect(seq.chatCalls()).toBe(1); // no pointless retry on a hard HTTP error
  });

  it('does NOT soft-pass a persistent empty answer even when GPU-resident', async () => {
    // Resident the whole time, yet HTTP 200 never yields final text → hard fail:
    // Phase 2 needs real text, residency alone is not enough.
    const seq = seqFetch({ chat: [emptyBoth, emptyBoth], ps: psLoaded });
    const result = await runOllamaPreflight({ ...base, fetchImpl: seq.fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('smoke_failed');
  });

  it('model is loaded by the smoke itself → the post-smoke /api/ps re-probe detects residency', async () => {
    // Cold before, smoke loads it, second /api/ps shows it resident.
    const seq = seqFetch({ chat: [finalOk], ps: [{ models: [] }, psLoaded] });
    const result = await runOllamaPreflight({ ...base, fetchImpl: seq.fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ps?.loaded).toBe(true); // reflects the AFTER snapshot
      expect(result.smoke?.residentBeforeSmoke).toBe(false);
      expect(result.smoke?.residentAfterSmoke).toBe(true);
    }
    expect(seq.psCalls()).toBe(2); // before + after
  });

  it('non-thinking model returning content immediately → ok, no retry (no regression)', async () => {
    const seq = seqFetch({ chat: [finalOk] });
    const result = await runOllamaPreflight({ ...base, fetchImpl: seq.fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.diagnostic).toBe('ok');
    expect(seq.chatCalls()).toBe(1);
  });
});

describe('normalizeOllamaChatResponse', () => {
  it('classifies usable final content', () => {
    const r = normalizeOllamaChatResponse({ message: { content: ' hi ' }, done: true, done_reason: 'stop' });
    expect(r.kind).toBe('final_content');
    expect(r.content).toBe('hi');
    expect(r.done).toBe(true);
    expect(r.doneReason).toBe('stop');
  });
  it('classifies a thinking-only response', () => {
    const r = normalizeOllamaChatResponse({ message: { thinking: 'reasoning', content: '' } });
    expect(r.kind).toBe('thinking_only');
    expect(r.thinking.length).toBeGreaterThan(0);
    expect(r.content).toBe('');
  });
  it('classifies an empty response (message present, both empty)', () => {
    expect(normalizeOllamaChatResponse({ message: { content: '   ' } }).kind).toBe('empty');
  });
  it('classifies an invalid payload (no message / response)', () => {
    expect(normalizeOllamaChatResponse({}).kind).toBe('invalid');
    expect(normalizeOllamaChatResponse(null).kind).toBe('invalid');
    expect(normalizeOllamaChatResponse('nope').kind).toBe('invalid');
  });
  it('treats a top-level `response` string like final content', () => {
    const r = normalizeOllamaChatResponse({ response: 'ok' });
    expect(r.kind).toBe('final_content');
    expect(r.content).toBe('ok');
  });
  it('surfaces an Ollama error field', () => {
    expect(normalizeOllamaChatResponse({ error: 'model not found' }).errorField).toBe('model not found');
  });
});

describe('isGpuResidentPlausible', () => {
  it('true when fully in VRAM', () => {
    expect(isGpuResidentPlausible({ loaded: true, sizeBytes: 9e9, sizeVramBytes: 9e9 })).toBe(true);
  });
  it('true when loaded with VRAM but unknown total', () => {
    expect(isGpuResidentPlausible({ loaded: true, sizeBytes: 0, sizeVramBytes: 9e9 })).toBe(true);
  });
  it('false when mostly on CPU', () => {
    expect(isGpuResidentPlausible({ loaded: true, sizeBytes: 9e9, sizeVramBytes: 1e9 })).toBe(false);
  });
  it('false when not loaded / null', () => {
    expect(isGpuResidentPlausible({ loaded: false, sizeBytes: 0, sizeVramBytes: 0 })).toBe(false);
    expect(isGpuResidentPlausible(null)).toBe(false);
  });
});

describe('classifyOllamaRuntime', () => {
  it('managed when our process runs and it is reachable', () => {
    expect(classifyOllamaRuntime(true, true)).toBe('managed');
  });
  it('external when reachable but not our process', () => {
    expect(classifyOllamaRuntime(false, true)).toBe('external');
  });
  it('unavailable when not reachable (regardless of managed flag)', () => {
    expect(classifyOllamaRuntime(false, false)).toBe('unavailable');
    expect(classifyOllamaRuntime(true, false)).toBe('unavailable');
  });
});

describe('parseOllamaOffloadLayers', () => {
  it('parses "offloaded 41/41 layers to GPU"', () => {
    expect(
      parseOllamaOffloadLayers(['[stderr] llama: offloaded 41/41 layers to GPU']),
    ).toEqual({ gpuLayers: 41, totalLayers: 41 });
  });

  it('parses a partial offload', () => {
    expect(parseOllamaOffloadLayers(['offloaded 20/41 layers to GPU'])).toEqual({
      gpuLayers: 20,
      totalLayers: 41,
    });
  });

  it('returns the most recent match when several loads are logged', () => {
    expect(
      parseOllamaOffloadLayers([
        'offloaded 20/41 layers to GPU',
        'some other log line',
        'offloaded 41/41 layers to GPU',
      ]),
    ).toEqual({ gpuLayers: 41, totalLayers: 41 });
  });

  it('returns null when no offload line is present', () => {
    expect(parseOllamaOffloadLayers(['POST /api/chat 200', ''])).toBeNull();
  });
});

describe('getOllamaPsStatus', () => {
  const base = { host: 'http://localhost:11434', model: 'qwen3:14b' };

  it('reports the configured model as loaded with its byte residency', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        models: [{ name: 'qwen3:14b', size: 9_400_000_000, size_vram: 9_400_000_000 }],
      }),
    ) as unknown as typeof fetch;
    const status = await getOllamaPsStatus({ ...base, fetchImpl });
    expect(status).toEqual({ loaded: true, sizeBytes: 9_400_000_000, sizeVramBytes: 9_400_000_000 });
  });

  it('reports loaded:false when the model is not running', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ models: [{ name: 'llama3.1:8b', size: 1, size_vram: 1 }] }),
    ) as unknown as typeof fetch;
    const status = await getOllamaPsStatus({ ...base, fetchImpl });
    expect(status).toEqual({ loaded: false, sizeBytes: 0, sizeVramBytes: 0 });
  });

  it('returns null when /api/ps is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await getOllamaPsStatus({ ...base, fetchImpl })).toBeNull();
  });
});
