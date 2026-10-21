#!/usr/bin/env -S npx tsx
import 'dotenv/config';
import { Command, InvalidArgumentError } from 'commander';
import { closePool, collectRepo, createReadClient, getPool, loadConfig } from '@nightshift/core';

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

await program.parseAsync();
// Octokit's throttling plugin keeps timers alive; exit explicitly once the command is done.
process.exit(process.exitCode ?? 0);
