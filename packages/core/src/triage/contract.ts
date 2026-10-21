// The triage output contract and its parser. The parser is the source of truth, not the model's
// structured-output mode: whatever comes back, the result is a valid TriageOutput, and anything we
// cannot read lands in NEEDS_HUMAN with parse_ok = false. Nothing is dropped.
import { z } from 'zod';
import { BUCKETS, type Bucket } from '../types.ts';

export const triageOutputSchema = z.object({
  bucket: z.enum(BUCKETS),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
  evidence: z.array(z.string()),
  draft_reply: z.string().nullable(),
});
export type TriageOutput = z.infer<typeof triageOutputSchema>;

export interface ParsedTriage {
  output: TriageOutput;
  parseOk: boolean;
  /** Why the output was overridden, if it was. */
  note?: string;
}

const MAX_DRAFT_WORDS = 80;

export function needsHuman(reason: string): TriageOutput {
  return { bucket: 'NEEDS_HUMAN', confidence: 0, reason, evidence: [], draft_reply: null };
}

/** Pull the first balanced JSON object out of text that may have fences or prose around it. */
export function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Normalise near-misses a small model produces: lowercase bucket, confidence as "0.8" or 80, evidence as a string. */
function coerce(raw: Record<string, unknown>): Record<string, unknown> {
  const out = { ...raw };
  if (typeof out.bucket === 'string') out.bucket = out.bucket.trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (typeof out.confidence === 'string') out.confidence = Number.parseFloat(out.confidence);
  if (typeof out.confidence === 'number' && out.confidence > 1 && out.confidence <= 100) out.confidence = out.confidence / 100;
  if (typeof out.evidence === 'string') out.evidence = [out.evidence];
  if (out.evidence === undefined || out.evidence === null) out.evidence = [];
  if (out.draft_reply === undefined || out.draft_reply === '') out.draft_reply = null;
  return out;
}

export interface RuleContext {
  duplicateNumbers?: number[];
  /** additions + deletions; null for issues. */
  changedLines?: number | null;
  author?: string;
}

/** TRIVIAL_SAFE ceiling for human-authored PRs. Bot dependency bumps are exempt (lockfile diffs are large). */
export const TRIVIAL_MAX_LINES = 40;

export function parseTriageOutput(text: string | null | undefined, ctx: RuleContext = {}): ParsedTriage {
  if (!text || !text.trim()) return { output: needsHuman('model returned no output'), parseOk: false };
  const json = extractJsonObject(text);
  if (!json) return { output: needsHuman('model output contained no JSON object'), parseOk: false };

  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { output: needsHuman('model output was not valid JSON'), parseOk: false };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { output: needsHuman('model output was not a JSON object'), parseOk: false };
  }

  const result = triageOutputSchema.safeParse(coerce(raw as Record<string, unknown>));
  if (!result.success) {
    const issue = result.error.issues[0];
    return { output: needsHuman(`model output failed the contract: ${issue?.path.join('.')} ${issue?.message}`), parseOk: false };
  }
  return enforceRules(result.data, ctx);
}

/** Rules from the prompt that we do not trust a 4B model to follow, enforced after parsing. */
function enforceRules(o: TriageOutput, ctx: RuleContext): ParsedTriage {
  // TRIVIAL_SAFE means small. Pre-flight on 2026-10-22: gemma3:4b called a 414-line concurrency fix trivial at 0.95.
  if (o.bucket === 'TRIVIAL_SAFE' && (ctx.changedLines ?? 0) > TRIVIAL_MAX_LINES && !ctx.author?.endsWith('[bot]')) {
    return {
      output: { ...o, bucket: 'NEEDS_HUMAN', reason: `model said trivial but the diff is ${ctx.changedLines} lines: ${o.reason}` },
      parseOk: true,
      note: 'trivial-too-large',
    };
  }
  // DUPLICATE must cite a number that was actually offered as a candidate.
  if (o.bucket === 'DUPLICATE') {
    const cited = [...`${o.reason} ${o.evidence.join(' ')}`.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
    const offered = new Set(ctx.duplicateNumbers ?? []);
    if (!cited.some((n) => offered.has(n))) {
      return {
        output: { ...o, bucket: 'NEEDS_HUMAN', reason: `model said duplicate without citing a candidate: ${o.reason}` },
        parseOk: true,
        note: 'duplicate-without-citation',
      };
    }
  }
  // SPAM_OR_SLOP needs two independent tells.
  if (o.bucket === 'SPAM_OR_SLOP' && o.evidence.length < 2) {
    return {
      output: { ...o, bucket: 'NEEDS_HUMAN', reason: `model said spam with fewer than two tells: ${o.reason}` },
      parseOk: true,
      note: 'spam-single-tell',
    };
  }
  // Draft must stay short; trim rather than reject.
  if (o.draft_reply) {
    const words = o.draft_reply.trim().split(/\s+/);
    if (words.length > MAX_DRAFT_WORDS) {
      return { output: { ...o, draft_reply: words.slice(0, MAX_DRAFT_WORDS).join(' ') + ' …' }, parseOk: true, note: 'draft-trimmed' };
    }
  }
  return { output: o, parseOk: true };
}

export function isBucket(x: string): x is Bucket {
  return (BUCKETS as readonly string[]).includes(x);
}
