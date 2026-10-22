import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isWritable } from './allowlist.ts';

export type RepoMode = 'read' | 'write';

export interface RepoConfig {
  repo: string; // owner/name
  mode: RepoMode;
}

export interface NightshiftConfig {
  repos: RepoConfig[];
  /** First run (no cursor) looks back this many hours. */
  initialLookbackHours: number;
  /** Cap per repo per night so a busy repo (mastra: ~150 items/day) cannot starve the others. */
  maxItemsPerRepo: number;
  promptVersion: string;
  /** Nightly run time, cron + IANA timezone. Defaults to 02:00 in the machine's timezone. */
  schedule: { cron: string; timezone: string };
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseConfig(input: unknown): NightshiftConfig {
  const c = input as Partial<NightshiftConfig>;
  if (!c || !Array.isArray(c.repos) || c.repos.length === 0) throw new Error('config: repos[] is required');
  for (const r of c.repos) {
    if (!REPO_RE.test(r.repo)) throw new Error(`config: bad repo name "${r.repo}"`);
    if (r.mode !== 'read' && r.mode !== 'write') throw new Error(`config: ${r.repo} mode must be read|write`);
    if (r.mode === 'write' && !isWritable(r.repo)) {
      throw new Error(`config: ${r.repo} is set to write but is not in the hard allowlist; partner repos are read-only`);
    }
  }
  return {
    repos: c.repos,
    initialLookbackHours: c.initialLookbackHours ?? 24,
    maxItemsPerRepo: c.maxItemsPerRepo ?? 200,
    promptVersion: c.promptVersion ?? 'v1',
    schedule: {
      cron: c.schedule?.cron ?? '0 2 * * *',
      timezone: c.schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  };
}

/** Persist a new schedule into nightshift.config.json (the file stays the source of truth). */
export function saveSchedule(schedule: { cron: string; timezone: string }, path = resolve(process.cwd(), 'nightshift.config.json')): void {
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  raw.schedule = schedule;
  writeFileSync(path, JSON.stringify(raw, null, 2) + '\n', 'utf8');
}

/** "13:30" -> "30 13 * * *". */
export function cronFromTime(hhmm: string): string {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) throw new Error(`not a time (HH:MM, 24h): ${hhmm}`);
  return `${Number(m[2])} ${Number(m[1])} * * *`;
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function loadConfig(path = resolve(process.cwd(), 'nightshift.config.json')): NightshiftConfig {
  return parseConfig(JSON.parse(readFileSync(path, 'utf8')));
}
