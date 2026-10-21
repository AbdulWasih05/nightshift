// Pure mapping from GitHub REST payloads to our Item shape. No I/O, so it is unit-tested directly.
import type { CiStatus, Item } from '../types.ts';

const TEST_FILE_RE = /(^|\/)(__tests__|tests?|spec|e2e)(\/|$)|[._-](test|spec)\.[a-z0-9]+$|_test\.(go|py)$|^test_.*\.py$|(^|\/)test_[^/]*\.py$/i;

export function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path);
}

type Conclusion = string | null | undefined;

/** Collapse check runs + legacy commit statuses into one status. Any failure wins, then pending. */
export function summariseCi(checkRuns: { status: string; conclusion: Conclusion }[], combinedState?: string | null): CiStatus {
  const states: CiStatus[] = [];
  for (const run of checkRuns) {
    if (run.status !== 'completed') states.push('pending');
    else if (['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(run.conclusion ?? '')) states.push('failure');
    else states.push('success'); // success, neutral, skipped
  }
  if (combinedState === 'failure' || combinedState === 'error') states.push('failure');
  else if (combinedState === 'pending' && checkRuns.length === 0) {
    // GitHub reports "pending" for a commit with zero statuses; ignore that case.
  } else if (combinedState === 'success') states.push('success');
  if (states.length === 0) return 'none';
  if (states.includes('failure')) return 'failure';
  if (states.includes('pending')) return 'pending';
  return 'success';
}

export interface PrDetails {
  additions: number;
  deletions: number;
  changed_files: number;
  draft?: boolean;
  merged_at: string | null;
  files: string[];
  ci: CiStatus;
}

export interface AuthorFacts {
  accountAgeDays: number | null;
  priorMerged: number | null;
}

// Minimal shape of an issues.listForRepo entry that we rely on.
export interface GhIssue {
  number: number;
  title: string;
  body?: string | null;
  user: { login: string } | null;
  author_association?: string;
  state: string;
  draft?: boolean;
  labels: (string | { name?: string })[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: { merged_at?: string | null } | null;
}

export function mapIssue(repo: string, issue: GhIssue, pr: PrDetails | null, author: AuthorFacts): Item {
  const isPr = Boolean(issue.pull_request);
  return {
    repo,
    number: issue.number,
    kind: isPr ? 'pr' : 'issue',
    title: issue.title,
    body: issue.body ?? '',
    author: issue.user?.login ?? 'ghost',
    authorAssociation: issue.author_association ?? null,
    authorAccountAgeDays: author.accountAgeDays,
    authorPriorMerged: author.priorMerged,
    state: issue.state,
    draft: Boolean(pr?.draft ?? issue.draft),
    labels: issue.labels.map((l) => (typeof l === 'string' ? l : (l.name ?? ''))).filter(Boolean),
    additions: pr?.additions ?? null,
    deletions: pr?.deletions ?? null,
    filesChanged: pr?.changed_files ?? null,
    hasTests: pr ? pr.files.some(isTestFile) : null,
    ciStatus: pr ? pr.ci : null,
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    closedAt: issue.closed_at,
    mergedAt: pr?.merged_at ?? issue.pull_request?.merged_at ?? null,
    raw: issue,
  };
}

export function daysBetween(fromIso: string, to: Date = new Date()): number {
  return Math.floor((to.getTime() - new Date(fromIso).getTime()) / 86_400_000);
}
