import { describe, expect, it } from 'vitest';
import { isTestFile, mapIssue, summariseCi, type GhIssue } from '../src/github/map.ts';

describe('isTestFile', () => {
  it.each([
    'packages/core/src/agent.test.ts',
    'src/__tests__/foo.ts',
    'tests/unit/a.py',
    'pkg/server/handler_test.go',
    'test_sql.py',
    'e2e/login.spec.ts',
  ])('detects %s', (p) => expect(isTestFile(p)).toBe(true));

  it.each(['src/testing-utils.ts', 'docs/latest.md', 'src/contest.ts'])('ignores %s', (p) =>
    expect(isTestFile(p)).toBe(false),
  );
});

describe('summariseCi', () => {
  it('failure beats everything', () => {
    expect(summariseCi([{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'failure' }])).toBe('failure');
  });
  it('pending if any run incomplete', () => {
    expect(summariseCi([{ status: 'in_progress', conclusion: null }, { status: 'completed', conclusion: 'success' }])).toBe('pending');
  });
  it('none when there is no CI at all', () => {
    expect(summariseCi([], null)).toBe('none');
  });
  it('legacy status failure counts', () => {
    expect(summariseCi([{ status: 'completed', conclusion: 'success' }], 'error')).toBe('failure');
  });
});

describe('mapIssue', () => {
  const base: GhIssue = {
    number: 42,
    title: 'Fix typo',
    body: null,
    user: { login: 'alice' },
    author_association: 'FIRST_TIME_CONTRIBUTOR',
    state: 'open',
    labels: ['bug', { name: 'good first issue' }],
    created_at: '2026-10-20T00:00:00Z',
    updated_at: '2026-10-21T00:00:00Z',
    closed_at: null,
  };

  it('maps an issue without PR fields', () => {
    const item = mapIssue('o/r', base, null, { accountAgeDays: 3, priorMerged: 0 });
    expect(item.kind).toBe('issue');
    expect(item.body).toBe('');
    expect(item.labels).toEqual(['bug', 'good first issue']);
    expect(item.hasTests).toBeNull();
    expect(item.additions).toBeNull();
  });

  it('maps a PR with diff stats and test detection', () => {
    const item = mapIssue(
      'o/r',
      { ...base, pull_request: { merged_at: null } },
      { additions: 410, deletions: 2, changed_files: 3, merged_at: null, files: ['README.md', 'src/a.test.ts'], ci: 'success' },
      { accountAgeDays: 3, priorMerged: 0 },
    );
    expect(item.kind).toBe('pr');
    expect(item.additions).toBe(410);
    expect(item.hasTests).toBe(true);
    expect(item.ciStatus).toBe('success');
    expect(item.authorAccountAgeDays).toBe(3);
  });
});
