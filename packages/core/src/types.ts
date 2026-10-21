export const BUCKETS = [
  'DUPLICATE',
  'SPAM_OR_SLOP',
  'OUT_OF_SCOPE',
  'NEEDS_TESTS_OR_INFO',
  'TRIVIAL_SAFE',
  'NEEDS_HUMAN',
] as const;
export type Bucket = (typeof BUCKETS)[number];

export type CiStatus = 'success' | 'failure' | 'pending' | 'none';

/** Normalised PR/issue as stored in `items`. */
export interface Item {
  repo: string;
  number: number;
  kind: 'pr' | 'issue';
  title: string;
  body: string;
  author: string;
  authorAssociation: string | null;
  authorAccountAgeDays: number | null;
  authorPriorMerged: number | null;
  state: string;
  draft: boolean;
  labels: string[];
  additions: number | null;
  deletions: number | null;
  filesChanged: number | null;
  hasTests: boolean | null;
  ciStatus: CiStatus | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  raw: unknown;
}
