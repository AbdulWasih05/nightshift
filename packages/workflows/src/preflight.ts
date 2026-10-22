// Checks CLAUDE.md requires before every nightly run. Prints one line per check; returns false on any hard failure.
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client, Connection } from '@temporalio/client';
import { getPool, isWritable, loadConfig, WRITE_ALLOWLIST } from '@nightshift/core';
import { describeSchedule, TASK_QUEUE } from './client.ts';

type Check = { name: string; ok: boolean; hard: boolean; detail: string };

async function check(name: string, hard: boolean, fn: () => Promise<string>): Promise<Check> {
  try {
    return { name, ok: true, hard, detail: await fn() };
  } catch (err) {
    return { name, ok: false, hard, detail: (err as Error).message };
  }
}

export async function preflight(root = process.cwd()): Promise<boolean> {
  const config = loadConfig(join(root, 'nightshift.config.json'));
  const checks: Check[] = [];

  checks.push(
    await check('database migrated', true, async () => {
      const files = (await readdir(join(root, 'db', 'migrations'))).filter((f) => f.endsWith('.sql'));
      const { rows } = await getPool().query<{ name: string }>('SELECT name FROM schema_migrations');
      const missing = files.filter((f) => !rows.some((r) => r.name === f));
      if (missing.length) throw new Error(`not applied: ${missing.join(', ')} (run pnpm db:migrate)`);
      return `${files.length} migrations applied`;
    }),
  );

  checks.push(
    await check('write allowlist', true, async () => {
      const writers = config.repos.filter((r) => r.mode === 'write').map((r) => r.repo);
      if (writers.some((r) => !isWritable(r))) throw new Error(`write repo outside allowlist: ${writers.join(', ')}`);
      const readers = config.repos.filter((r) => r.mode === 'read').map((r) => r.repo);
      return `write: ${writers.join(', ') || 'none'} (allowlist ${WRITE_ALLOWLIST.join(', ')}); read-only: ${readers.join(', ')}`;
    }),
  );

  checks.push(
    await check('prompt pinned', true, async () => {
      const file = resolve(root, 'packages', 'core', 'prompts', `triage.${config.promptVersion}.md`);
      if (!existsSync(file)) throw new Error(`missing ${file}`);
      return `triage.${config.promptVersion}.md`;
    }),
  );

  checks.push(
    await check('GitHub token', true, async () => {
      const t = process.env.GITHUB_TOKEN ?? '';
      if (!t) throw new Error('GITHUB_TOKEN not set');
      if (!t.startsWith('github_pat_')) throw new Error('not a fine-grained PAT (github_pat_...); see .env.example');
      const res = await fetch('https://api.github.com/rate_limit', { headers: { Authorization: `Bearer ${t}` }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`GitHub said ${res.status}`);
      const j = (await res.json()) as { resources: { core: { remaining: number; limit: number } } };
      return `fine-grained, ${j.resources.core.remaining}/${j.resources.core.limit} requests left this hour`;
    }),
  );

  checks.push(
    await check('Ollama models', true, async () => {
      const host = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/$/, '');
      const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      const names = ((await res.json()) as { models: { name: string }[] }).models.map((m) => m.name.replace(/:latest$/, ''));
      const need = [process.env.TRIAGE_MODEL ?? 'gemma3:4b', process.env.TRIAGE_FALLBACK_MODEL ?? 'gemma3:1b', process.env.EMBED_MODEL ?? 'nomic-embed-text'];
      const missing = need.filter((n) => !names.includes(n.replace(/:latest$/, '')));
      if (missing.length) throw new Error(`missing: ${missing.join(', ')} (ollama pull ...)`);
      return need.join(', ');
    }),
  );

  checks.push(
    await check('Temporal schedule', true, async () => {
      const d = await describeSchedule();
      if (!d) throw new Error('no schedule; run `nightshift schedule`');
      if (d.paused) throw new Error('schedule is paused');
      return `next run ${d.next[0]?.toString() ?? 'unknown'} (${config.schedule.cron} ${config.schedule.timezone})`;
    }),
  );

  checks.push(
    await check('worker polling', true, async () => {
      const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
      try {
        const c = new Client({ connection });
        const r = await c.workflowService.describeTaskQueue({
          namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
          taskQueue: { name: TASK_QUEUE },
          taskQueueType: 1, // workflow
        });
        if (!r.pollers?.length) throw new Error(`no worker polling "${TASK_QUEUE}"; start one (scripts/night-stack.ps1)`);
        return `${r.pollers.length} poller(s) on "${TASK_QUEUE}"`;
      } finally {
        await connection.close();
      }
    }),
  );

  checks.push(
    await check('Sentry tracing', false, async () => {
      if (!process.env.SENTRY_DSN) throw new Error('SENTRY_DSN not set: tonight will have no traces');
      return 'DSN set; metadata-only spans (no prompt or contributor text)';
    }),
  );

  for (const c of checks) console.log(`${c.ok ? 'ok  ' : c.hard ? 'FAIL' : 'warn'} ${c.name.padEnd(18)} ${c.detail}`);
  return checks.every((c) => c.ok || !c.hard);
}
