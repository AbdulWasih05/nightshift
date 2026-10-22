import { describe, expect, it } from 'vitest';
import { ModelHealth, triageItem, type GenerateFn } from '../src/triage/agent.ts';
import { buildTriageInput, cleanBody, BODY_LIMIT } from '../src/triage/input.ts';
import type { ModelSpec } from '../src/triage/models.ts';
import { modelChain } from '../src/triage/models.ts';

const models: ModelSpec[] = [
  { path: 'gemma3:4b', id: 'ollama/gemma3:4b', url: 'http://x/v1', apiKey: 'k' },
  { path: 'gemma3:1b', id: 'ollama/gemma3:1b', url: 'http://x/v1', apiKey: 'k' },
  { path: 'hosted', id: 'hosted/m', url: 'http://h/v1', apiKey: 'k' },
];

const input = buildTriageInput({
  repo: 'o/r', number: 1, kind: 'issue', title: 't', body: 'b', author: 'a', author_association: null,
  author_account_age_days: 10, author_prior_merged: 0, additions: null, deletions: null, files_changed: null,
  has_tests: null, ci_status: null, draft: false, labels: [],
});

const good = JSON.stringify({ bucket: 'OUT_OF_SCOPE', confidence: 0.6, reason: 'Support question.', evidence: ['type=issue'], draft_reply: 'Thanks, please ask in Discussions.' });

describe('triageItem fallback chain', () => {
  it('uses the first model that answers', async () => {
    const generate: GenerateFn = async (m) => ({ text: good, tokensIn: 10, tokensOut: 5, model: m.path }) as never;
    const r = await triageItem(input, { promptVersion: 'v1', models, generate });
    expect(r.modelPath).toBe('gemma3:4b');
    expect(r.output.bucket).toBe('OUT_OF_SCOPE');
    expect(r.failures).toEqual([]);
  });

  it('falls through 4b -> 1b when Ollama errors, records the failure', async () => {
    const generate: GenerateFn = async (m) => {
      if (m.path === 'gemma3:4b') throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      return { text: good, tokensIn: 1, tokensOut: 1 };
    };
    const r = await triageItem(input, { promptVersion: 'v1', models, generate });
    expect(r.modelPath).toBe('gemma3:1b');
    expect(r.failures).toHaveLength(1);
  });

  it('reaches the hosted model, then NEEDS_HUMAN with model_path none when everything is down', async () => {
    const down: GenerateFn = async () => {
      throw new Error('down');
    };
    const r = await triageItem(input, { promptVersion: 'v1', models, generate: down });
    expect(r.modelPath).toBe('none');
    expect(r.output.bucket).toBe('NEEDS_HUMAN');
    expect(r.parseOk).toBe(false);
    expect(r.failures.map((f) => f.path)).toEqual(['gemma3:4b', 'gemma3:1b', 'hosted']);
  });

  it('garbage from a model that answered is NEEDS_HUMAN, not a fallback to the next model', async () => {
    let calls = 0;
    const generate: GenerateFn = async () => {
      calls++;
      return { text: 'I am not sure.', tokensIn: 1, tokensOut: 1 };
    };
    const r = await triageItem(input, { promptVersion: 'v1', models, generate });
    expect(calls).toBe(1);
    expect(r.output.bucket).toBe('NEEDS_HUMAN');
    expect(r.parseOk).toBe(false);
    expect(r.rawOutput).toBe('I am not sure.');
  });

  it('a timeout counts as a model failure even though Mastra resolves with empty text instead of throwing', async () => {
    // Mastra 1.79 on abort: resolves { text: '', finishReason: 'aborted' }. Mimic that, not a rejection.
    const generate: GenerateFn = (m, _s, _u, signal) =>
      m.path === 'gemma3:4b'
        ? new Promise((resolve) => signal.addEventListener('abort', () => resolve({ text: '', tokensIn: null, tokensOut: null })))
        : Promise.resolve({ text: good, tokensIn: 1, tokensOut: 1 });
    const r = await triageItem(input, { promptVersion: 'v1', models, generate, timeoutMs: 20 });
    expect(r.modelPath).toBe('gemma3:1b');
    expect(r.failures[0]).toMatchObject({ path: 'gemma3:4b', error: expect.stringMatching(/timed out/) });
  });

  it('circuit breaker skips a model after 3 consecutive failures in a run', async () => {
    const calls: string[] = [];
    const generate: GenerateFn = async (m) => {
      calls.push(m.path);
      if (m.path === 'gemma3:4b') throw new Error('ECONNREFUSED');
      return { text: good, tokensIn: 1, tokensOut: 1 };
    };
    const health = new ModelHealth(3);
    for (let i = 0; i < 5; i++) await triageItem(input, { promptVersion: 'v1', models, generate, health });
    expect(calls.filter((c) => c === 'gemma3:4b')).toHaveLength(3);
    expect(calls.filter((c) => c === 'gemma3:1b')).toHaveLength(5);
  });

  it('rejects path-traversal prompt versions', async () => {
    await expect(triageItem(input, { promptVersion: '../../etc', models, generate: async () => ({ text: good, tokensIn: 0, tokensOut: 0 }) })).rejects.toThrow(/bad prompt version/);
  });
});

describe('input + chain config', () => {
  it('strips template comments and truncates long bodies', () => {
    expect(cleanBody('<!-- fill me -->\nReal text')).toBe('Real text');
    expect(cleanBody('x'.repeat(5000)).length).toBeLessThan(BODY_LIMIT + 20);
  });

  it('hosted model only joins the chain when configured', () => {
    expect(modelChain({}).map((m) => m.path)).toEqual(['gemma3:4b', 'gemma3:1b']);
    expect(modelChain({ HOSTED_MODEL_URL: 'https://h/v1', HOSTED_MODEL_NAME: 'gemma' }).map((m) => m.path)).toEqual(['gemma3:4b', 'gemma3:1b', 'hosted']);
  });
});
