#!/usr/bin/env -S npx tsx
import 'dotenv/config';
import { resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { describeSchedule, ONCE_SCHEDULE_ID, preflight, runNightNow, runWorker, SCHEDULE_ID, scheduleOnce, upsertSchedule } from '@nightshift/workflows';
import {
  closePool,
  collectRepo,
  createReadClient,
  embedPending,
  findDuplicates,
  getPool,
  cronFromTime,
  isValidTimezone,
  loadConfig,
  loadDigest,
  saveSchedule,
  renderDigest,
  renderTerminalSummary,
  writeDigest,
  selectPending,
  triageBatch,
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
  .command('embed')
  .description('Embed items whose title/body changed since last embedded')
  .option('-r, --repo <owner/name...>', 'limit to these repos')
  .action(async (opts: { repo?: string[] }) => {
    const db = getPool();
    try {
      const repos = opts.repo ?? loadConfig().repos.map((r) => r.repo);
      console.log(`embedded ${await embedPending(db, { repos })} items`);
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
      await triageBatch(db, pending, {
        promptVersion,
        nightId: null,
        repos,
        onItem: ({ item, run, duplicates, error }) => {
          if (!run) return console.log(`${item.repo}#${item.number} ERROR ${error} (stays pending)`);
          const fell = run.failures.length ? ` (after ${run.failures.map((f) => f.path).join(' -> ')} failed)` : '';
          console.log(
            `${item.repo}#${item.number} ${run.output.bucket} ${run.output.confidence.toFixed(2)} ` +
              `[${run.modelPath}${fell}, ${(run.latencyMs / 1000).toFixed(1)}s, ${run.tokensIn ?? '?'}→${run.tokensOut ?? '?'} tok` +
              `${run.parseOk ? '' : ', PARSE FAIL'}${run.note ? `, ${run.note}` : ''}] ${run.output.reason}` +
              (duplicates.length ? `
    dup candidates: ${duplicates.map((d) => `#${d.number} (${d.source}: ${d.why})`).join(' | ')}` : ''),
          );
        },
      });
    } finally {
      await closePool();
    }
  });

program
  .command('worker')
  .description('Run the Temporal worker (long-running; the 02:00 schedule needs it up)')
  .action(async () => {
    await runWorker();
  });

program
  .command('schedule')
  .description('Show or change when the nightly run fires. The run time is yours: 02:00, midday, or once in N minutes.')
  .option('--at <HH:MM>', 'daily run time, 24h, e.g. 02:00 or 13:30')
  .option('--cron <expr>', 'full cron expression instead of --at, e.g. "0 2,13 * * 1-5"')
  .option('--tz <iana>', 'timezone, e.g. Asia/Kolkata, Asia/Dubai, Europe/Berlin (default: config, else this machine)')
  .option('--once-in <minutes>', 'additionally fire the scheduled run once, N minutes from now (does not change the daily time)', (v) => {
    const n = Number.parseInt(v, 10);
    if (!Number.isInteger(n) || n < 1 || n > 1440) throw new InvalidArgumentError(`minutes 1-1440: ${v}`);
    return n;
  })
  .action(async (opts: { at?: string; cron?: string; tz?: string; onceIn?: number }) => {
    if (opts.at && opts.cron) throw new InvalidArgumentError('use --at or --cron, not both');
    if (opts.tz && !isValidTimezone(opts.tz)) throw new InvalidArgumentError(`unknown timezone: ${opts.tz}`);
    const current = loadConfig().schedule;
    const schedule = {
      cron: opts.cron ?? (opts.at ? cronFromTime(opts.at) : current.cron),
      timezone: opts.tz ?? current.timezone,
    };
    if (schedule.cron !== current.cron || schedule.timezone !== current.timezone) saveSchedule(schedule);
    console.log(`${await upsertSchedule(schedule)} daily schedule "${SCHEDULE_ID}": ${schedule.cron} (${schedule.timezone})`);
    const d = await describeSchedule();
    console.log(`next daily runs: ${d?.next.slice(0, 3).map((t) => t.toString()).join(' | ')}${d?.paused ? ' [PAUSED]' : ''}`);
    if (opts.onceIn) {
      const at = new Date(Date.now() + opts.onceIn * 60_000);
      at.setSeconds(0, 0);
      await scheduleOnce(at);
      console.log(`one-off scheduled run at ${at.toString()} ("${ONCE_SCHEDULE_ID}", fires once)`);
    }
  });

program
  .command('preflight')
  .description('Check everything the nightly run needs: DB, allowlist, prompt, token, Ollama, schedule, worker, Sentry')
  .action(async () => {
    try {
      if (!(await preflight())) process.exitCode = 1;
    } finally {
      await closePool();
    }
  });

program
  .command('run')
  .description('Run a night now through Temporal and wait for it (needs `nightshift worker` running)')
  .option('-r, --repo <owner/name...>', 'limit to these repos')
  .option('-c, --chunk <n>', 'items per triage activity', (v) => Number.parseInt(v, 10))
  .option('-m, --max <n>', 'cap items per repo for a test run (rest is collected next night)', (v) => Number.parseInt(v, 10))
  .action(async (opts: { repo?: string[]; chunk?: number; max?: number }) => {
    const r = await runNightNow({ repos: opts.repo, chunkSize: opts.chunk, maxItemsPerRepo: opts.max });
    console.log(`
night ${r.nightId}: ${r.status}; collected ${JSON.stringify(r.collected)}; triaged ${r.triaged}, failed ${r.triageFailed}`);
    if (r.failedRepos.length) console.log(`failed repos: ${r.failedRepos.join(', ')}`);
    if (r.summary) console.log(`
${r.summary}

full digest: ${r.digestPath}`);
  });

program
  .command('digest')
  .description("Print the latest night's digest summary (or --night N) and rewrite docs/digests/<date>.md")
  .option('-n, --night <id>', 'night id', (v) => Number.parseInt(v, 10))
  .option('-a, --all', 'print the full markdown digest')
  .action(async (opts: { night?: number; all?: boolean }) => {
    const db = getPool();
    try {
      const nightId =
        opts.night ??
        (await db.query<{ id: number }>("SELECT max(id) AS id FROM nights WHERE status <> 'running'")).rows[0]?.id;
      if (!nightId) throw new Error('no nights yet; run `nightshift run` or wait for the schedule');
      const d = await loadDigest(db, nightId);
      const file = await writeDigest(d, resolve(process.cwd(), 'docs', 'digests'));
      console.log(opts.all ? renderDigest(d) : `${renderTerminalSummary(d)}

full digest: ${file}`);
    } finally {
      await closePool();
    }
  });

await program.parseAsync();
// Octokit's throttling plugin keeps timers alive; exit explicitly once the command is done.
process.exit(process.exitCode ?? 0);
