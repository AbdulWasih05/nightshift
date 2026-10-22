// The triage agent: one Mastra Agent per model in the fallback chain, temperature 0, JSON contract.
// A model that errors or times out hands over to the next one; a model that answers with something
// unreadable does NOT (that is a classification result: NEEDS_HUMAN, parse_ok = false).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agent } from '@mastra/core/agent';
import { needsHuman, parseTriageOutput, triageOutputSchema, type TriageOutput } from './contract.ts';
import { renderUserMessage, type TriageInput } from './input.ts';
import { modelChain, type ModelSpec } from './models.ts';

export interface GenerateResult {
  text: string;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** Injectable for tests: (model, system prompt, user message, abort signal) -> raw model text + usage. */
export type GenerateFn = (model: ModelSpec, system: string, user: string, signal: AbortSignal) => Promise<GenerateResult>;

export interface TriageRun {
  output: TriageOutput;
  parseOk: boolean;
  note?: string;
  rawOutput: string | null;
  modelPath: string; // model that answered, or "none"
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
  /** Models that failed before one answered, with the error, for the fallback-share line in the post. */
  failures: { path: string; error: string }[];
}

const PROMPTS_DIR = join(import.meta.dirname, '..', '..', 'prompts');

export function loadPrompt(version: string): string {
  if (!/^v\d+[a-z]?$/.test(version)) throw new Error(`bad prompt version "${version}"`);
  return readFileSync(join(PROMPTS_DIR, `triage.${version}.md`), 'utf8');
}

// Sentinel so Mastra never throws on a schema miss; we always re-parse the raw text ourselves.
const FALLBACK_SENTINEL: TriageOutput = { bucket: 'NEEDS_HUMAN', confidence: 0, reason: '__mastra_fallback__', evidence: [], draft_reply: null };

const agents = new Map<string, Agent>();

export const mastraGenerate: GenerateFn = async (model, system, user, signal) => {
  const key = `${model.path}\u0000${system}`;
  let agent = agents.get(key);
  if (!agent) {
    agent = new Agent({
      id: `nightshift-triage-${model.path.replace(/[^a-z0-9]+/gi, '-')}`,
      name: 'Nightshift triage',
      instructions: system,
      model: { id: model.id, url: model.url, apiKey: model.apiKey },
    });
    agents.set(key, agent);
  }
  const res = await agent.generate(user, {
    modelSettings: { temperature: 0 },
    abortSignal: signal,
    structuredOutput: { schema: triageOutputSchema, errorStrategy: 'fallback', fallbackValue: FALLBACK_SENTINEL },
  });
  // Mastra 1.79 does not throw on abort: it resolves with text '' and finishReason 'aborted'. Without this
  // check a hung model looks like a parse failure and the next model in the chain is never tried.
  if (signal.aborted || res.finishReason === 'aborted') throw new ModelTimeoutError(model.path);
  return {
    text: res.text ?? '',
    tokensIn: res.usage?.inputTokens ?? null,
    tokensOut: res.usage?.outputTokens ?? null,
  };
};

export class ModelTimeoutError extends Error {
  constructor(path: string) {
    super(`${path} timed out`);
    this.name = 'ModelTimeoutError';
  }
}

/**
 * Per-run circuit breaker. After `threshold` consecutive failures a model is skipped for the rest of the run,
 * so a wedged Ollama costs a few timeouts, not 240s on every remaining item.
 */
export class ModelHealth {
  private consecutive = new Map<string, number>();
  constructor(private threshold = 3) {}
  isOpen(path: string): boolean {
    return (this.consecutive.get(path) ?? 0) >= this.threshold;
  }
  failed(path: string): void {
    this.consecutive.set(path, (this.consecutive.get(path) ?? 0) + 1);
  }
  succeeded(path: string): void {
    this.consecutive.set(path, 0);
  }
}

export interface TriageOptions {
  promptVersion: string;
  models?: ModelSpec[];
  generate?: GenerateFn;
  /** Per-model timeout. The 4B model on the build laptop takes ~15-60s per item. */
  timeoutMs?: number;
  /** Shared across a run so repeated failures trip the breaker. */
  health?: ModelHealth;
}

export async function triageItem(input: TriageInput, opts: TriageOptions): Promise<TriageRun> {
  const system = loadPrompt(opts.promptVersion);
  const user = renderUserMessage(input);
  const models = opts.models ?? modelChain();
  const generate = opts.generate ?? mastraGenerate;
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const failures: TriageRun['failures'] = [];
  const started = Date.now();

  for (const model of models) {
    if (opts.health?.isOpen(model.path)) {
      failures.push({ path: model.path, error: 'skipped: circuit open after repeated failures this run' });
      continue;
    }
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await generate(model, system, user, signal);
      if (signal.aborted) throw new ModelTimeoutError(model.path);
      opts.health?.succeeded(model.path);
      const parsed = parseTriageOutput(res.text, {
        duplicateNumbers: input.top_duplicates.map((d) => d.number),
        changedLines: input.additions === null ? null : input.additions + (input.deletions ?? 0),
        author: input.author,
        title: input.title,
        type: input.type,
      });
      return {
        ...parsed,
        rawOutput: res.text,
        modelPath: model.path,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        latencyMs: Date.now() - started,
        failures,
      };
    } catch (err) {
      opts.health?.failed(model.path);
      failures.push({ path: model.path, error: (err as Error).message.slice(0, 500) });
    }
  }

  return {
    output: needsHuman(`no model answered (${failures.map((f) => f.path).join(', ') || 'none configured'})`),
    parseOk: false,
    rawOutput: null,
    modelPath: 'none',
    tokensIn: null,
    tokensOut: null,
    latencyMs: Date.now() - started,
    failures,
  };
}
