import { describe, expect, it } from 'vitest';
import { evaluateLoadedModel, parseNvidiaSmiCsv, runGpuPreflight } from './gpuPreflight';

describe('parseNvidiaSmiCsv', () => {
  it('parses name,total,free rows', () => {
    const rows = parseNvidiaSmiCsv('NVIDIA GeForce RTX 4070, 12282, 11000\n');
    expect(rows).toEqual([{ name: 'NVIDIA GeForce RTX 4070', totalMb: 12282, freeMb: 11000 }]);
  });
  it('ignores blank/short lines', () => {
    expect(parseNvidiaSmiCsv('\n\nbad line\n')).toEqual([]);
  });
});

describe('runGpuPreflight', () => {
  it('reports no_gpu when nvidia-smi is unavailable (runner throws)', async () => {
    const result = await runGpuPreflight({
      runNvidiaSmi: async () => {
        throw new Error('not found');
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('no_gpu');
      expect(result.gpuPresent).toBe(false);
    }
  });

  it('reports insufficient_vram when free memory is below the requirement', async () => {
    const result = await runGpuPreflight({
      requiredFreeMb: 9000,
      runNvidiaSmi: async () => 'RTX 4070, 12282, 4000',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('insufficient_vram');
      expect(result.gpu?.freeMb).toBe(4000);
    }
  });

  it('passes when enough VRAM is free, and picks the GPU with the most free memory', async () => {
    const result = await runGpuPreflight({
      requiredFreeMb: 9000,
      runNvidiaSmi: async () => 'GPU0, 12000, 3000\nGPU1, 24000, 20000',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.gpu.freeMb).toBe(20000);
      expect(result.warning).toBeNull();
    }
  });

  it('passes but warns when VRAM is tight (within ~1.5 GB of the minimum)', async () => {
    const result = await runGpuPreflight({
      requiredFreeMb: 9000,
      runNvidiaSmi: async () => 'RTX 4070, 12282, 9500',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warning).toMatch(/knapp/i);
    }
  });

  it('reports unknown when nvidia-smi returns no parseable rows', async () => {
    const result = await runGpuPreflight({ runNvidiaSmi: async () => 'garbage' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown');
  });

  // --- The production bug: the smoke-test loads the model, so afterwards there
  // is little free VRAM — but that VRAM is held by the very model we want. ---

  it('does NOT abort when the model is fully loaded (41/41) and free VRAM is now low', async () => {
    const result = await runGpuPreflight({
      modelLabel: 'qwen3:14b',
      requiredFreeMb: 9000,
      // Pre-load there were ~10 GB free; the smoke-test loaded qwen3:14b, so now
      // only ~807 MB are free — the model itself holds the rest.
      runNvidiaSmi: async () => 'RTX 4070, 12282, 807',
      loadedModel: { loaded: true, gpuLayers: 41, totalLayers: 41 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.loadedFull).toBe(true);
      expect(result.message).toBe('GPU OK: qwen3:14b ist geladen (41/41 Layer auf GPU).');
    }
  });

  it('aborts (cpu_offload) when the model only got partial GPU layers (20/41)', async () => {
    const result = await runGpuPreflight({
      modelLabel: 'qwen3:14b',
      requiredFreeMb: 9000,
      // Plenty free, but Ollama only offloaded 20/41 layers → CPU spill.
      runNvidiaSmi: async () => 'RTX 4070, 12282, 11000',
      loadedModel: { loaded: true, gpuLayers: 20, totalLayers: 41 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cpu_offload');
      expect(result.message).toContain('20/41');
    }
  });

  it('aborts (insufficient_vram) when no model is loaded and only 800 MB is free', async () => {
    const result = await runGpuPreflight({
      modelLabel: 'qwen3:14b',
      requiredFreeMb: 9000,
      runNvidiaSmi: async () => 'RTX 4070, 12282, 800',
      // No model loaded yet → the free-VRAM threshold must apply.
      loadedModel: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('insufficient_vram');
  });

  it('accepts a fully loaded model even when nvidia-smi is unavailable', async () => {
    const result = await runGpuPreflight({
      modelLabel: 'qwen3:14b',
      runNvidiaSmi: async () => {
        throw new Error('not found');
      },
      loadedModel: { loaded: true, gpuLayers: 41, totalLayers: 41 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.loadedFull).toBe(true);
  });

  it('uses /api/ps byte residency as a fallback when layer counts are absent', async () => {
    // Full: size_vram == size → pass, low free VRAM tolerated.
    const full = await runGpuPreflight({
      modelLabel: 'qwen3:14b',
      runNvidiaSmi: async () => 'RTX 4070, 12282, 807',
      loadedModel: { loaded: true, sizeVramBytes: 9_400_000_000, sizeBytes: 9_400_000_000 },
    });
    expect(full.ok).toBe(true);

    // Partial: only half in VRAM → abort.
    const partial = await runGpuPreflight({
      modelLabel: 'qwen3:14b',
      runNvidiaSmi: async () => 'RTX 4070, 12282, 11000',
      loadedModel: { loaded: true, sizeVramBytes: 4_700_000_000, sizeBytes: 9_400_000_000 },
    });
    expect(partial.ok).toBe(false);
    if (!partial.ok) expect(partial.reason).toBe('cpu_offload');
  });
});

describe('evaluateLoadedModel', () => {
  it('treats an unloaded model as neither full nor partial', () => {
    expect(evaluateLoadedModel({ loaded: false })).toEqual({
      fullyOnGpu: false,
      partialCpuOffload: false,
      layerLabel: null,
    });
  });

  it('prefers layer counts over byte sizes', () => {
    const evald = evaluateLoadedModel({
      loaded: true,
      gpuLayers: 41,
      totalLayers: 41,
      // Conflicting (would look partial) byte data must be ignored.
      sizeVramBytes: 1,
      sizeBytes: 9_400_000_000,
    });
    expect(evald.fullyOnGpu).toBe(true);
    expect(evald.partialCpuOffload).toBe(false);
    expect(evald.layerLabel).toBe('41/41');
  });

  it('flags partial offload from layer counts', () => {
    expect(evaluateLoadedModel({ loaded: true, gpuLayers: 0, totalLayers: 41 })).toMatchObject({
      fullyOnGpu: false,
      partialCpuOffload: true,
      layerLabel: '0/41',
    });
  });

  it('falls back to bytes (>=95% in VRAM counts as full)', () => {
    expect(
      evaluateLoadedModel({ loaded: true, sizeVramBytes: 9_400_000_000, sizeBytes: 9_400_000_000 }),
    ).toMatchObject({ fullyOnGpu: true, partialCpuOffload: false, layerLabel: null });
    expect(
      evaluateLoadedModel({ loaded: true, sizeVramBytes: 4_000_000_000, sizeBytes: 9_400_000_000 }),
    ).toMatchObject({ fullyOnGpu: false, partialCpuOffload: true });
  });

  it('returns unknown (neither) when loaded but no residency detail is given', () => {
    expect(evaluateLoadedModel({ loaded: true })).toEqual({
      fullyOnGpu: false,
      partialCpuOffload: false,
      layerLabel: null,
    });
  });
});
