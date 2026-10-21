// The exact evidence the model sees for one item. Stored verbatim in triage.input so any prompt version
// can be re-run offline against the same night (pnpm eval).

export interface DuplicateCandidate {
  number: number;
  title: string;
  similarity: number; // fused hybrid score, 0..1
  why: string; // e.g. "vector 0.91 + keyword match on 'retry policy'"
}

export interface TriageInput {
  repo: string;
  type: 'pr' | 'issue';
  number: number;
  title: string;
  body: string;
  author: string;
  author_association: string | null;
  author_account_age_days: number | null;
  author_prior_merged: number | null;
  additions: number | null;
  deletions: number | null;
  files_changed: number | null;
  has_tests: boolean | null;
  ci_status: string | null;
  draft: boolean;
  labels: string[];
  top_duplicates: DuplicateCandidate[];
  p_merge: number | null;
}

export const BODY_LIMIT = 1500;

export interface ItemRow {
  repo: string;
  number: number;
  kind: 'pr' | 'issue';
  title: string;
  body: string;
  author: string;
  author_association: string | null;
  author_account_age_days: number | null;
  author_prior_merged: number | null;
  additions: number | null;
  deletions: number | null;
  files_changed: number | null;
  has_tests: boolean | null;
  ci_status: string | null;
  draft: boolean;
  labels: string[];
}

/** Strip HTML comments (PR templates are full of them) and collapse blank runs before truncating. */
export function cleanBody(body: string): string {
  const cleaned = body.replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return cleaned.length > BODY_LIMIT ? `${cleaned.slice(0, BODY_LIMIT)}… [truncated]` : cleaned;
}

export function buildTriageInput(item: ItemRow, duplicates: DuplicateCandidate[] = [], pMerge: number | null = null): TriageInput {
  return {
    repo: item.repo,
    type: item.kind,
    number: item.number,
    title: item.title,
    body: cleanBody(item.body),
    author: item.author,
    author_association: item.author_association,
    author_account_age_days: item.author_account_age_days,
    author_prior_merged: item.author_prior_merged,
    additions: item.additions,
    deletions: item.deletions,
    files_changed: item.files_changed,
    has_tests: item.has_tests,
    ci_status: item.ci_status,
    draft: item.draft,
    labels: item.labels,
    top_duplicates: duplicates.slice(0, 3),
    p_merge: pMerge,
  };
}

export function renderUserMessage(input: TriageInput): string {
  return `Classify this item. Input:\n${JSON.stringify(input, null, 1)}`;
}
