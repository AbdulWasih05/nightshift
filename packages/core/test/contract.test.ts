import { describe, expect, it } from 'vitest';
import { extractJsonObject, parseTriageOutput } from '../src/triage/contract.ts';

const ok = {
  bucket: 'NEEDS_TESTS_OR_INFO',
  confidence: 0.7,
  reason: 'Code change with has_tests=false.',
  evidence: ['has_tests=false'],
  draft_reply: 'Thanks! Could you add a test?',
};

describe('parseTriageOutput: contract', () => {
  it('accepts a clean object', () => {
    const r = parseTriageOutput(JSON.stringify(ok));
    expect(r.parseOk).toBe(true);
    expect(r.output).toEqual(ok);
  });

  it('accepts fenced JSON with prose around it', () => {
    const r = parseTriageOutput('Sure! Here it is:\n```json\n' + JSON.stringify(ok) + '\n```\nHope that helps.');
    expect(r.parseOk).toBe(true);
    expect(r.output.bucket).toBe('NEEDS_TESTS_OR_INFO');
  });

  it('coerces near-misses: lowercase bucket, percent confidence, string evidence, empty draft', () => {
    const r = parseTriageOutput(JSON.stringify({ ...ok, bucket: 'needs tests or info', confidence: 70, evidence: 'has_tests=false', draft_reply: '' }));
    expect(r.parseOk).toBe(true);
    expect(r.output).toMatchObject({ bucket: 'NEEDS_TESTS_OR_INFO', confidence: 0.7, evidence: ['has_tests=false'], draft_reply: null });
  });

  it.each([
    ['empty', ''],
    ['null', null],
    ['prose only', 'I think this needs a human.'],
    ['truncated', '{"bucket": "DUPLICATE", "reason": "same as'],
    ['invalid json', '{bucket: DUPLICATE}'],
    ['array', '[1,2]'],
    ['unknown bucket', JSON.stringify({ ...ok, bucket: 'MAYBE' })],
    ['missing reason', JSON.stringify({ ...ok, reason: undefined })],
    ['confidence out of range', JSON.stringify({ ...ok, confidence: 150 })],
  ])('falls back to NEEDS_HUMAN on %s, never drops', (_name, text) => {
    const r = parseTriageOutput(text as string | null);
    expect(r.parseOk).toBe(false);
    expect(r.output.bucket).toBe('NEEDS_HUMAN');
    expect(r.output.reason.length).toBeGreaterThan(0);
  });

  it('braces inside strings do not confuse extraction', () => {
    expect(extractJsonObject('x {"a": "}{", "b": {"c": 1}} y')).toBe('{"a": "}{", "b": {"c": 1}}');
  });
});

describe('parseTriageOutput: rules the model cannot be trusted with', () => {
  it('DUPLICATE without citing an offered candidate becomes NEEDS_HUMAN', () => {
    const dup = { ...ok, bucket: 'DUPLICATE', reason: 'Same as an earlier issue.', evidence: [] };
    expect(parseTriageOutput(JSON.stringify(dup), { duplicateNumbers: [12] }).output.bucket).toBe('NEEDS_HUMAN');
    const cites = { ...dup, reason: 'Same as #12.' };
    expect(parseTriageOutput(JSON.stringify(cites), { duplicateNumbers: [12] }).output.bucket).toBe('DUPLICATE');
    const citesWrong = { ...dup, reason: 'Same as #99.' };
    expect(parseTriageOutput(JSON.stringify(citesWrong), { duplicateNumbers: [12] }).output.bucket).toBe('NEEDS_HUMAN');
  });

  it('SPAM_OR_SLOP needs two tells', () => {
    const one = { ...ok, bucket: 'SPAM_OR_SLOP', evidence: ['generic title'] };
    expect(parseTriageOutput(JSON.stringify(one)).output.bucket).toBe('NEEDS_HUMAN');
    const two = { ...one, evidence: ['generic title', 'additions=412 for a typo fix'] };
    expect(parseTriageOutput(JSON.stringify(two)).output.bucket).toBe('SPAM_OR_SLOP');
  });

  it('TRIVIAL_SAFE over 40 changed lines becomes NEEDS_HUMAN unless a real dependency bump', () => {
    const t = JSON.stringify({ ...ok, bucket: 'TRIVIAL_SAFE', draft_reply: null });
    expect(parseTriageOutput(t, { type: 'pr', changedLines: 414, author: 'alice' }).output.bucket).toBe('NEEDS_HUMAN');
    expect(parseTriageOutput(t, { type: 'pr', changedLines: 12, author: 'alice' }).output.bucket).toBe('TRIVIAL_SAFE');
    expect(parseTriageOutput(t, { type: 'pr', changedLines: 900, author: 'dependabot[bot]', title: 'Bump grpc from 1.65 to 1.66' }).output.bucket).toBe('TRIVIAL_SAFE');
    expect(parseTriageOutput(t, { type: 'pr', changedLines: 900, author: 'renovate[bot]', title: 'chore(deps): update dependency x' }).output.bucket).toBe('TRIVIAL_SAFE');
  });

  it('TRIVIAL_SAFE fails closed: unknown PR size, or a non-dependency bot', () => {
    const t = JSON.stringify({ ...ok, bucket: 'TRIVIAL_SAFE', draft_reply: null });
    expect(parseTriageOutput(t, { type: 'pr', changedLines: null }).output.bucket).toBe('NEEDS_HUMAN');
    expect(parseTriageOutput(t, { type: 'pr', changedLines: 2000, author: 'github-actions[bot]', title: 'Regenerate API' }).output.bucket).toBe('NEEDS_HUMAN');
    expect(parseTriageOutput(t, { type: 'pr', changedLines: 2000, author: 'dependabot[bot]', title: 'Rewrite the scheduler' }).output.bucket).toBe('NEEDS_HUMAN');
    expect(parseTriageOutput(t, { type: 'issue', changedLines: null }).output.bucket).toBe('TRIVIAL_SAFE');
  });

  it('a demoted item loses the model draft and its confidence is capped', () => {
    const spam = { ...ok, bucket: 'SPAM_OR_SLOP', confidence: 0.95, evidence: ['generic title'], draft_reply: 'This looks like low-effort spam.' };
    const r = parseTriageOutput(JSON.stringify(spam));
    expect(r.output).toMatchObject({ bucket: 'NEEDS_HUMAN', draft_reply: null });
    expect(r.output.confidence).toBeLessThanOrEqual(0.5);
    const dup = { ...ok, bucket: 'DUPLICATE', reason: 'Closing as duplicate.', draft_reply: 'Closing as a duplicate.' };
    expect(parseTriageOutput(JSON.stringify(dup), { duplicateNumbers: [3] }).output.draft_reply).toBeNull();
  });

  it('NEEDS_HUMAN never carries a draft, even when the model wrote one', () => {
    const nh = { ...ok, bucket: 'NEEDS_HUMAN', draft_reply: 'LGTM, merging!' };
    expect(parseTriageOutput(JSON.stringify(nh)).output.draft_reply).toBeNull();
  });

  it('confidence 1.5 is out of range, not 1.5%', () => {
    expect(parseTriageOutput(JSON.stringify({ ...ok, confidence: 1.5 })).parseOk).toBe(false);
    expect(parseTriageOutput(JSON.stringify({ ...ok, confidence: 85 })).output.confidence).toBe(0.85);
  });

  it('long drafts are trimmed to 80 words', () => {
    const long = { ...ok, draft_reply: Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ') };
    const r = parseTriageOutput(JSON.stringify(long));
    expect(r.output.draft_reply!.split(/\s+/).length).toBeLessThanOrEqual(81);
  });
});
