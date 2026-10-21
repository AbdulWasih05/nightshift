import { describe, expect, it } from 'vitest';
import { scrubDeep, scrubString } from '../src/scrub.ts';

describe('scrub', () => {
  it('removes NUL and replaces lone surrogates, keeps valid emoji', () => {
    expect(scrubString('a\u0000b')).toBe('ab');
    expect(scrubString('x\uD83Dy')).toBe('x�y');
    expect(scrubString('x\uDE00y')).toBe('x�y');
    expect(scrubString('ok 😀')).toBe('ok 😀');
  });

  it('scrubbed raw JSON is accepted by jsonb rules (no \\u0000 escape)', () => {
    const raw = scrubDeep({ body: 'log\u0000dump', nested: [{ t: 'cut \uD83D' }] });
    const json = JSON.stringify(raw);
    expect(json).not.toContain('\\u0000');
    expect(json).not.toMatch(/\\ud83d(?!\\ude)/i);
  });
});
