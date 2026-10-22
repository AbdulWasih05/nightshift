// Temporal activities: thin wrappers over @nightshift/core. All I/O lives here; the workflow only orchestrates.
import { resolve } from 'node:path';
import { Context } from '@temporalio/activity';
import {
  collectRepo,
  countPendingForNight,
  createReadClient,
  embedPending,
  finishNight as finishNightRow,
  getPool,
  loadConfig,
  loadDigest,
  ModelHealth,
  renderTerminalSummary,
  selectPending,
  startNight as startNightRow,
  triageBatch,
  writeDigest as writeDigestFile,
  type NightStatus,
} from '@nightshift/core';
import { SCHEDULE_ID } from './client.ts';

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

export async function startNight(args: { repos: string[]; promptVersion: string }): Promise<number> {
  const exec = Context.current().info.workflowExecution;
  // Schedule-started workflows get ids "<scheduleId>-<timestamp>".
  const trigger = exec?.workflowId.startsWith(`${SCHEDULE_ID}-`) ? 'scheduled' : 'manual';
  return startNightRow(getPool(), args.repos, args.promptVersion, exec?.runId ?? null, trigger);
}

export interface CollectSummary {
  repo: string;
  collected: number;
  capped: boolean;
  errors: number;
}

export async function collect(args: { repo: string; nightId: number; maxItems: number; initialLookbackHours: number }): Promise<CollectSummary> {
  const r = await collectRepo(createReadClient(), getPool(), {
    repo: args.repo,
    nightId: args.nightId,
    maxItems: args.maxItems,
    initialLookbackHours: args.initialLookbackHours,
  });
  return { repo: r.repo, collected: r.collected, capped: r.capped, errors: r.errors.length };
}

export async function embed(args: { repos: string[] }): Promise<number> {
  return embedPending(getPool(), { repos: args.repos });
}

// One breaker per worker process and night: a wedged Ollama trips it once, not once per chunk.
const healthByNight = new Map<number, ModelHealth>();

export interface ChunkResult {
  processed: number;
  failed: number;
  remaining: number;
}

/**
 * Triage up to `size` pending items for this night. Resumable by construction: items with a triage row for
 * this night are skipped, so a retry after Ollama restarts or laptop sleep continues where it stopped.
 */
export async function triageChunk(args: { nightId: number; repos: string[]; promptVersion: string; size: number }): Promise<ChunkResult> {
  const db = getPool();
  const ctx = Context.current();
  if (!healthByNight.has(args.nightId)) healthByNight.set(args.nightId, new ModelHealth());
  const pending = await selectPending(db, { repos: args.repos, promptVersion: args.promptVersion, nightId: args.nightId, limit: args.size });
  let processed = 0;
  let failed = 0;
  await triageBatch(db, pending, {
    promptVersion: args.promptVersion,
    nightId: args.nightId,
    repos: args.repos,
    health: healthByNight.get(args.nightId),
    skipEmbed: true,
    onItem: (r) => {
      if (r.triageId) processed++;
      else failed++;
      ctx.heartbeat({ done: processed + failed, of: pending.length });
    },
  });
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
