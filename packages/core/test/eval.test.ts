import { describe, expect, it } from 'vitest';
import { renderEval, score, type EvalRow } from '../src/eval.ts';

const r = (model: EvalRow['model'], human: EvalRow['human'], confidence = 0.5, number = 1, parse_ok = true): EvalRow => ({
  night_id: 5, item_id: number, repo: 'o/r', number, model, human, confidence, model_reason: 'm', human_reason: 'h', parse_ok,
});

describe('eval scorer on a fixture night', () => {
  const rows = [
    r('NEEDS_HUMAN', 'NEEDS_HUMAN', 0.8, 1),
    r('NEEDS_HUMAN', 'NEEDS_HUMAN', 0.8, 2),
    r('TRIVIAL_SAFE', 'NEEDS_HUMAN', 0.95, 3), // the confident miss
    r('DUPLICATE', 'DUPLICATE', 0.9, 4),
    r('NEEDS_TESTS_OR_INFO', 'NEEDS_HUMAN', 0.6, 5),
  ];
  const e = score(rows, 'v1');

  it('accuracy, precision and recall', () => {
    expect(e.n).toBe(5);
    expect(e.correct).toBe(3);
    expect(e.perBucket.NEEDS_HUMAN).toEqual({ precision: 1, recall: 0.5, support: 4 });
    expect(e.perBucket.TRIVIAL_SAFE.precision).toBe(0);
    expect(e.perBucket.SPAM_OR_SLOP).toEqual({ precision: null, recall: null, support: 0 });
  });

  it('confusion matrix is [human][model]; worst misses are the most confident wrong answers', () => {
    expect(e.confusion.NEEDS_HUMAN.TRIVIAL_SAFE).toBe(1);
    expect(e.worst.map((w) => w.number)).toEqual([3, 5]);
  });

  it('a parse-failure fallback that happens to match the human label is not counted as correct', () => {
    const f = score([r('NEEDS_HUMAN', 'NEEDS_HUMAN', 0, 9, false), r('NEEDS_HUMAN', 'NEEDS_HUMAN', 0.7, 10)], 'v1');
    expect(f.correct).toBe(1);
    expect(f.parseFailures).toBe(1);
  });

  it('renders without inventing numbers for empty input', () => {
    expect(renderEval(score([], 'v2'))).toContain('No labelled items yet.');
    expect(renderEval(e)).toContain('Accuracy: 3/5 (60%)');
  });
});
