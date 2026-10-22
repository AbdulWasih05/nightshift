import { describe, expect, it } from 'vitest';
import { renderDigest, renderTerminalSummary, type DigestData, type DigestRow } from '../src/digest.ts';
import { ModelHealth } from '../src/triage/agent.ts';
import { allowedAttribute, scrubSpanData } from '../src/telemetry.ts';

const row = (i: number, bucket: DigestRow['bucket'], draft: string | null = null): DigestRow => ({
  triage_id: i, repo: 'o/r', number: 100 + i, kind: 'pr', title: `title ${i}`, bucket, confidence: 0.5,
  reason: `reason ${i}`, draft_reply: draft, model_path: 'gemma3:4b', parse_ok: true, latency_ms: 50_000, tokens_in: 1000, tokens_out: 100,
});

describe('digest', () => {
  const d: DigestData = {
    nightId: 4,
    date: '2026-10-23',
    rows: [
      ...Array.from({ length: 12 }, (_, i) => row(i, 'NEEDS_HUMAN')),
      row(20, 'DUPLICATE', 'Thanks! This duplicates #5.'),
      row(21, 'DUPLICATE', null),
      row(22, 'TRIVIAL_SAFE'),
    ],
    errors: [],
  };

  it('the digest file lists every item; nothing is hidden behind a cap', () => {
    const md = renderDigest(d);
    for (let i = 0; i < 12; i++) expect(md).toContain(`#${100 + i} `);
    expect(md).toContain('#121'); // DUPLICATE without a draft still appears
    expect(md).not.toContain('more (full list');
  });

  it('the terminal summary is short and says where the rest is', () => {
    const t = renderTerminalSummary(d);
    expect(t).toContain('12 need you');
    expect(t).toContain('and 4 more');
    expect(t.split('\n').length).toBeLessThan(20);
  });

  it('the estimate is labelled with its assumptions; cost line reflects hosted calls', () => {
    const md = renderDigest(d);
    expect(md).toMatch(/est\. \d+ min/);
    expect(md).toContain('It is an estimate, not a measurement');
    expect(md).toContain('all local, $0.00');
    const hosted = renderDigest({ ...d, rows: [{ ...row(1, 'NEEDS_HUMAN'), model_path: 'hosted' }] });
    expect(hosted).toContain('1 on the hosted fallback');
    expect(hosted).not.toContain('all local');
  });
});

describe('ModelHealth', () => {
  it('opens after 3 failures and half-opens after 5 minutes', () => {
    let now = 0;
    const h = new ModelHealth(3, 5 * 60_000, () => now);
    h.failed('m');
    h.failed('m');
    expect(h.isOpen('m')).toBe(false);
    h.failed('m');
    expect(h.isOpen('m')).toBe(true);
    now += 5 * 60_000;
    expect(h.isOpen('m')).toBe(false); // one more try allowed
    h.failed('m');
    expect(h.isOpen('m')).toBe(true);
    h.succeeded('m');
    expect(h.isOpen('m')).toBe(false);
  });
});

describe('Sentry attribute allowlist', () => {
  it('keeps metadata, drops anything that can carry contributor text', () => {
    const data: Record<string, unknown> = {
      'gen_ai.request.model': 'gemma3:4b',
      'gen_ai.usage.input_tokens': 1000,
      'nightshift.bucket': 'NEEDS_HUMAN',
      'nightshift.item': 'o/r#1',
      'sentry.op': 'gen_ai.chat',
      'http.response.status_code': 200,
      'gen_ai.input.messages': '[{"role":"user","content":"secret issue body"}]',
      'gen_ai.response.object': '{"draft_reply":"..."}',
      'gen_ai.tool.call.arguments': '{}',
      'url.query': 'q=author:someone',
      'url.full': 'https://api.github.com/search/issues?q=author:someone',
      'db.query.text': 'INSERT INTO items ... $5',
      'ai.prompt': 'secret',
      'nightshift.title': 'should not exist',
    };
    scrubSpanData(data);
    expect(Object.keys(data).sort()).toEqual(
      ['gen_ai.request.model', 'gen_ai.usage.input_tokens', 'http.response.status_code', 'nightshift.bucket', 'nightshift.item', 'sentry.op'].sort(),
    );
    expect(allowedAttribute('gen_ai.output.messages')).toBe(false);
  });
});
