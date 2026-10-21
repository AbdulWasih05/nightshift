#!/usr/bin/env -S npx tsx
import 'dotenv/config';
import { Command, InvalidArgumentError } from 'commander';
import {
  buildTriageInput,
  closePool,
  collectRepo,
  createReadClient,
  embedPending,
  findDuplicates,
  getPool,
  loadConfig,
  saveTriage,
  selectPending,
  triageItem,
} from '@nightshift/core';

const program = new Command().name('nightshift').description("The maintainer's night shift. Never acts without approval.");

program
  .command('collect')
  .description('Pull PRs and issues updated since the last run into the database (read-only)')
  .option('-r, --repo <owner/name...>', 'limit to these repos (must be in nightshift.config.json)')
  .option('-s, --since <iso>', 'override the stored cursor, e.g. 2026-10-20T00:00:00Z', (v) => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) throw new InvalidArgumentError(`not a date: ${v}`);
    return d.toISOString();
  })
  .option('-m, --max <n>', 'max items per repo', (v) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError(`not a positive integer: ${v}`);
    return n;
  })
  // Manual collection is not a night: items get no night id and NIGHTS.md (which counts triage rows
  // per night) does not include them. Nights are created only by the nightly workflow.
  .action(async (opts: { repo?: string[]; since?: string; max?: number }) => {
    const config = loadConfig();
    const repos = opts.repo
      ? config.repos.filter((r) => opts.repo!.some((x) => x.toLowerCase() === r.repo.toLowerCase()))
      : config.repos;
    if (repos.length === 0) throw new Error(`none of ${opts.repo?.join(', ')} are in nightshift.config.json`);

    const gh = createReadClient();
    const db = getPool();
    let failed = 0;
    try {
      for (const { repo } of repos) {
        const started = Date.now();
        try {
          const r = await collectRepo(gh, db, {
            repo,
            nightId: null,
            initialLookbackHours: config.initialLookbackHours,
            maxItems: opts.max ?? config.maxItemsPerRepo,
            since: opts.since,
          });
          console.log(
            `${repo}: ${r.collected} items (${r.prs} PRs, ${r.issues} issues) since ${r.since}` +
              `${r.capped ? ' [capped, rest next run]' : ''}` +
              `${r.errors.length ? ` [${r.errors.length} errors, see collect_errors]` : ''}` +
              ` in ${((Date.now() - started) / 1000).toFixed(1)}s`,
          );
        } catch (err) {
          failed++;
          console.error(`${repo}: FAILED ${(err as Error).message}`);
        }
      }
    } finally {
      await closePool();
    }
    if (failed) process.exitCode = 1;
  });

program
  .command('backfill')
  .description('Store N days of history (title/body/state only) as the duplicate-search corpus. Never triaged, cursor untouched.')
  .requiredOption('-r, --repo <owner/name...>', 'repos to backfill (must be in nightshift.config.json)')
  .option('-d, --days <n>', 'days of history', (v) => Number.parseInt(v, 10), 90)
  .option('-m, --max <n>', 'max items per repo', (v) => Number.parseInt(v, 10), 3000)
  .action(async (opts: { repo: string[]; days: number; max: number }) => {
    const config = loadConfig();
    const gh = createReadClient();
    const db = getPool();
    try {
      for (const repo of opts.repo) {
        if (!config.repos.some((r) => r.repo.toLowerCase() === repo.toLowerCase())) throw new Error(`${repo} is not in nightshift.config.json`);
        const since = new Date(Date.now() - opts.days * 86_400_000).toISOString();
        const r = await collectRepo(gh, db, { repo, nightId: null, initialLookbackHours: 0, maxItems: opts.max, since, corpusOnly: true });
        console.log(`${repo}: ${r.collected} corpus items (${r.prs} PRs, ${r.issues} issues) since ${since}${r.capped ? ' [capped]' : ''}`);
      }
      const embedded = await embedPending(db, { repos: opts.repo });
      console.log(`embedded ${embedded} items`);
    } finally {
      await closePool();
    }
  });

program
  .command('dups')
  .description('Show hybrid duplicate candidates for one item (debug)')
  .argument('<repo>', 'owner/name')
  .argument('<number>', 'issue or PR number')
  .action(async (repo: string, number: string) => {
    const db = getPool();
    try {
      const { rows } = await db.query<{ id: number; title: string }>('SELECT id, title FROM items WHERE repo = $1 AND number = $2', [repo, Number(number)]);
      if (!rows[0]) throw new Error(`${repo}#${number} not collected`);
      console.log(`${repo}#${number} ${rows[0].title}`);
      for (const d of await findDuplicates(db, rows[0].id, 5)) console.log(`  #${d.number} [${d.source}] ${d.title}
     ${d.why}`);
    } finally {
      await closePool();
    }
  });

program
  .command('triage')
  .description('Classify open items that have no triage row yet for the pinned prompt version (manual run, no night)')
  .option('-r, --repo <owner/name...>', 'limit to these repos')
  .option('-n, --limit <n>', 'max items to triage', (v) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError(`not a positive integer: ${v}`);
    return n;
  }, 10)
  .option('-p, --prompt <version>', 'prompt version, defaults to the one pinned in nightshift.config.json')
  .action(async (opts: { repo?: string[]; limit: number; prompt?: string }) => {
    const config = loadConfig();
    const promptVersion = opts.prompt ?? config.promptVersion;
    const repos = (opts.repo ?? config.repos.map((r) => r.repo)).filter((r) =>
      config.repos.some((c) => c.repo.toLowerCase() === r.toLowerCase()),
    );
    const db = getPool();
    try {
      const pending = await selectPending(db, { repos, promptVersion, nightId: null, limit: opts.limit });
      console.log(`triaging ${pending.length} items with prompt ${promptVersion}`);
      const embedded = await embedPending(db, { repos });
      if (embedded) console.log(`embedded ${embedded} items`);
      for (const item of pending) {
        const dups = await findDuplicates(db, item.id);
        const input = buildTriageInput(item, dups);
        const run = await triageItem(input, { promptVersion });
        await saveTriage(db, { itemId: item.id, nightId: null, promptVersion, input, run });
        const fell = run.failures.length ? ` (after ${run.failures.map((f) => f.path).join(' -> ')} failed)` : '';
        console.log(
          `${item.repo}#${item.number} ${run.output.bucket} ${run.output.confidence.toFixed(2)} ` +
            `[${run.modelPath}${fell}, ${(run.latencyMs / 1000).toFixed(1)}s, ${run.tokensIn ?? '?'}→${run.tokensOut ?? '?'} tok` +
            `${run.parseOk ? '' : ', PARSE FAIL'}${run.note ? `, ${run.note}` : ''}] ${run.output.reason}` +
            (dups.length ? `
    dup candidates: ${dups.map((d) => `#${d.number} (${d.source}: ${d.why})`).join(' | ')}` : ''),
        );
      }
    } finally {
      await closePool();
    }
  });

await program.parseAsync();
// Octokit's throttling plugin keeps timers alive; exit explicitly once the command is done.
process.exit(process.exitCode ?? 0);
