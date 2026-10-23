// Temporal activities: thin wrappers over @nightshift/core. All I/O lives here; the workflow only orchestrates.
// Long activities heartbeat and honour cancellation, so after laptop sleep a stale attempt stops instead of
// racing its retry on the same items.
import { resolve } from 'node:path';
import { ApplicationFailure, Context } from '@temporalio/activity';
import {
  claimBacklog as claimBacklogRows,
  collectRepo,
  countPendingForNight,
  createReadClient,
  embedPending,
  finishNight as finishNightRow,
  getPool,
  loadConfig,
  loadDigest,
  ModelHealth,
  ModelsUnavailableError,
  renderTerminalSummary,
  selectPending,
  startNight as startNightRow,
  triageBatch,
  writeDigest as writeDigestFile,
  type NightStatus,
} from '@nightshift/core';

export interface NightConfig {
  repos: string[];
  promptVersion: string;
  maxItemsPerRepo: number;
  initialLookbackHours: number;
}

export async function loadNightConfig(): Promise<NightConfig> {
  const c = loadConfig();
  return {
    repos: c.repos.map((r) => r.repo),
    promptVersion: c.promptVersion,
    maxItemsPerRepo: c.maxItemsPerRepo,
    initialLookbackHours: c.initialLookbackHours,
  };
}

export async function startNight(args: { repos: string[]; promptVersion: string; trigger: 'scheduled' | 'manual' }): Promise<number> {
  const runId = Context.current().info.workflowExecution?.runId ?? null;
  return startNightRow(getPool(), args.repos, args.promptVersion, runId, args.trigger);
}

export interface CollectSummary {
  repo: string;
  collected: number;
  capped: boolean;
  errors: number;
}

export async function collect(args: { repo: string; nightId: number; maxItems: number; initialLookbackHours: number }): Promise<CollectSummary> {
  const ctx = Context.current();
  const r = await collectRepo(createReadClient(), getPool(), {
    repo: args.repo,
    nightId: args.nightId,
    maxItems: args.maxItems,
    initialLookbackHours: args.initialLookbackHours,
    signal: ctx.cancellationSignal,
    onProgress: (done) => ctx.heartbeat({ repo: args.repo, done }),
  });
  return { repo: r.repo, collected: r.collected, capped: r.capped, errors: r.errors.length };
}

export async function claimBacklog(args: { nightId: number; repos: string[]; promptVersion: string }): Promise<number> {
  return claimBacklogRows(getPool(), args.nightId, args.repos, args.promptVersion);
}

export async function embed(args: { repos: string[] }): Promise<number> {
  const ctx = Context.current();
  return embedPending(getPool(), { repos: args.repos, signal: ctx.cancellationSignal, onProgress: (done) => ctx.heartbeat({ done }) });
}

// One breaker per worker process and night. It half-opens after 5 minutes, so an Ollama restart costs minutes.
const healthByNight = new Map<number, ModelHealth>();

export interface ChunkResult {
  processed: number;
  failed: number;
  remaining: number;
}

/**
 * Triage up to `size` pending items for this night. Resumable by construction: items with a triage row for
 * this night are skipped, so a retry after an Ollama restart or laptop sleep continues where it stopped.
 * If no model answers, nothing is stored and the activity fails, so Temporal backs off and retries.
 */
export async function triageChunk(args: { nightId: number; repos: string[]; promptVersion: string; size: number }): Promise<ChunkResult> {
  const db = getPool();
  const ctx = Context.current();
  if (!healthByNight.has(args.nightId)) healthByNight.set(args.nightId, new ModelHealth());
  const pending = await selectPending(db, { repos: args.repos, promptVersion: args.promptVersion, nightId: args.nightId, limit: args.size });
  let processed = 0;
  let failed = 0;
  try {
    await triageBatch(db, pending, {
      promptVersion: args.promptVersion,
      nightId: args.nightId,
      repos: args.repos,
      health: healthByNight.get(args.nightId),
      skipEmbed: true,
      signal: ctx.cancellationSignal,
      onItem: (r) => {
        if (r.triageId) processed++;
        else failed++;
        ctx.heartbeat({ done: processed + failed, of: pending.length });
      },
    });
  } catch (err) {
    if (err instanceof ModelsUnavailableError) {
      // Retryable on purpose: the workflow's retry policy backs off (1 min doubling to 10 min) until Ollama is back.
      throw ApplicationFailure.retryable(err.message, 'ModelsUnavailable');
    }
    throw err;
  }
  ctx.cancellationSignal.throwIfAborted();
  return { processed, failed, remaining: await countPendingForNight(db, args.nightId, args.promptVersion) };
}

export async function writeDigest(args: { nightId: number }): Promise<{ path: string; summary: string }> {
  const d = await loadDigest(getPool(), args.nightId);
  const path = await writeDigestFile(d, resolve(process.cwd(), 'docs', 'digests'));
  return { path, summary: renderTerminalSummary(d) };
}

export async function finishNight(args: { nightId: number; status: Exclude<NightStatus, 'running'>; notes: string }): Promise<void> {
  await finishNightRow(getPool(), args.nightId, args.status, args.notes);
}

// ---- Ollama lifecycle: started for a run, stopped after it (Wasih's call: nothing heavy idles on the laptop) ----

const OLLAMA = (process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434').replace(/\/$/, '').replace('localhost', '127.0.0.1');

async function ollamaUp(): Promise<boolean> {
  try {
    return (await fetch(`${OLLAMA}/api/version`, { signal: AbortSignal.timeout(3000) })).ok;
  } catch {
    return false;
  }
}

/** Start Ollama if it is not answering (Windows: the tray app, which starts the server). Waits up to 90s. */
export async function ensureModels(): Promise<string> {
  if (await ollamaUp()) return 'already running';
  const { spawn } = await import('node:child_process');
  const { join } = await import('node:path');
  if (process.platform === 'win32') {
    const app = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama app.exe');
    spawn(app, [], { detached: true, stdio: 'ignore', env: { ...process.env, OLLAMA_NUM_PARALLEL: '1', OLLAMA_MAX_LOADED_MODELS: '1' } }).unref();
  } else {
    spawn('ollama', ['serve'], { detached: true, stdio: 'ignore' }).unref();
  }
  for (let i = 0; i < 45; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    Context.current().heartbeat();
    if (await ollamaUp()) return 'started';
  }
  throw ApplicationFailure.retryable('Ollama did not start within 90s');
}

/**
 * After a run: unload every model (frees GPU and RAM at once) and, unless NIGHTSHIFT_STOP_OLLAMA_AFTER_RUN=0,
 * stop Ollama entirely. Best effort: a failure here never fails the night.
 */
export async function releaseModels(): Promise<string> {
  if (!(await ollamaUp())) return 'not running';
  try {
    const ps = (await (await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(5000) })).json()) as { models?: { name: string }[] };
    for (const m of ps.models ?? []) {
      await fetch(`${OLLAMA}/api/generate`, { method: 'POST', body: JSON.stringify({ model: m.name, keep_alive: 0 }), signal: AbortSignal.timeout(15000) });
    }
  } catch {
    // unloading is an optimisation; stopping below frees everything anyway
  }
  if (process.env.NIGHTSHIFT_STOP_OLLAMA_AFTER_RUN === '0') return 'models unloaded';
  if (process.platform === 'win32') {
    const { execFile } = await import('node:child_process');
    for (const image of ['ollama app.exe', 'ollama.exe', 'llama-server.exe']) {
      await new Promise((r) => execFile('taskkill', ['/IM', image, '/F'], () => r(null)));
    }
  }
  return 'ollama stopped';
}
