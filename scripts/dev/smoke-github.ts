// Dev smoke test: exercises the read-only GitHub path against one repo without touching the DB.
import { createReadClient } from '../../packages/core/src/github/client.ts';
import { mapIssue, summariseCi } from '../../packages/core/src/github/map.ts';

const [owner, repo] = (process.argv[2] ?? 'temporalio/temporal').split('/') as [string, string];
const gh = createReadClient();
console.log('listing', owner, repo);
const since = new Date(Date.now() - 24 * 3600e3).toISOString();
const { data } = await gh.issues.listForRepo({ owner, repo, state: 'all', since, sort: 'updated', direction: 'asc', per_page: 100 });
const prs = data.filter((i) => i.pull_request);
console.log(`${owner}/${repo} updated in 24h: ${data.length} (${prs.length} PRs)`);
const p = prs[0];
if (p) {
  const { data: pr } = await gh.pulls.get({ owner, repo, pull_number: p.number });
  const { data: files } = await gh.pulls.listFiles({ owner, repo, pull_number: p.number, per_page: 100 });
  const { data: checks } = await gh.checks.listForRef({ owner, repo, ref: pr.head.sha, per_page: 100 });
  const item = mapIssue(`${owner}/${repo}`, p as never, {
    additions: pr.additions, deletions: pr.deletions, changed_files: pr.changed_files, draft: pr.draft,
    merged_at: pr.merged_at, files: files.map((f) => f.filename), ci: summariseCi(checks.check_runs),
  }, { accountAgeDays: null, priorMerged: null });
  const { raw: _raw, body: _body, ...rest } = item;
  console.log(rest);
  const s = await gh.request('GET /search/issues', { q: `repo:${owner}/${repo} is:pr is:merged author:${p.user?.login}`, per_page: 1 });
  console.log('prior merged for', p.user?.login, s.data.total_count);
}
process.exit(0);
