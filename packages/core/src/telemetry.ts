// Sentry agent tracing: one invoke_agent span per item, one gen_ai.chat span per model attempt.
// Privacy: Sentry receives metadata only (model, tokens, latency, bucket). Prompts, titles, bodies and
// replies are stripped before send, so contributor data still never leaves the laptop. No-op without SENTRY_DSN.
import * as Sentry from '@sentry/node';

let enabled = false;

/** Attribute keys that can carry contributor text. Removed from every span before it is sent. */
const CONTENT_KEY = /^gen_ai\.(input|output|system_instructions|request\.messages|response\.text|response\.tool_calls|tool\.definitions|prompt|completion)/;

export function scrubSpanData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const k of Object.keys(data)) if (CONTENT_KEY.test(k) || k.startsWith('ai.prompt') || k.startsWith('ai.response')) delete data[k];
}

export function initTelemetry(service: string): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || enabled) return enabled;
  Sentry.init({
    dsn,
    tracesSampleRate: 1.0,
    // Nothing that can carry contributor text: no AI inputs/outputs, no HTTP bodies (Ollama requests contain
    // the prompt), no DB query data (upserts carry issue bodies), no stack-frame variables.
    dataCollection: {
      genAI: { inputs: false, outputs: false },
      httpBodies: [],
      databaseQueryData: false,
      stackFrameVariables: false,
      userInfo: false,
    },
    environment: process.env.NIGHTSHIFT_ENV ?? 'laptop',
    serverName: 'nightshift',
    initialScope: { tags: { service } },
    // Second fence behind dataCollection, in case an integration ignores it.
    beforeSendSpan(span) {
      scrubSpanData(span.attributes as Record<string, unknown>);
      return span;
    },
    beforeSendTransaction(event) {
      scrubSpanData(event.contexts?.trace?.data as Record<string, unknown> | undefined);
      for (const s of event.spans ?? []) scrubSpanData(s.data as Record<string, unknown>);
      return event;
    },
  });
  enabled = true;
  return true;
}

export async function flushTelemetry(): Promise<void> {
  if (enabled) await Sentry.flush(5000);
}

export function traceTriageItem<T>(attrs: { repo: string; number: number; kind: string; promptVersion: string; nightId: number | null }, fn: () => Promise<T>): Promise<T> {
  if (!enabled) return fn();
  return Sentry.startSpan(
    {
      op: 'gen_ai.invoke_agent',
      name: 'invoke_agent nightshift-triage',
      forceTransaction: true,
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        'gen_ai.agent.name': 'nightshift-triage',
        'nightshift.repo': attrs.repo,
        'nightshift.item': `${attrs.repo}#${attrs.number}`,
        'nightshift.kind': attrs.kind,
        'nightshift.prompt_version': attrs.promptVersion,
        'nightshift.night_id': attrs.nightId ?? -1,
      },
    },
    fn,
  );
}

export interface ChatOutcome {
  tokensIn: number | null;
  tokensOut: number | null;
  ok: boolean;
  error?: string;
}

/** Wraps one model attempt. `provider` is "ollama" for local models, "hosted" for the Render fallback. */
export async function traceChat<T>(model: { path: string; id: string }, fn: () => Promise<T>, outcome: (r: T) => ChatOutcome): Promise<T> {
  if (!enabled) return fn();
  const provider = model.id.split('/')[0] ?? 'unknown';
  return Sentry.startSpan(
    {
      op: 'gen_ai.chat',
      name: `chat ${model.path}`,
      attributes: {
        'gen_ai.operation.name': 'chat',
        'gen_ai.provider.name': provider,
        'gen_ai.request.model': model.path,
        'gen_ai.agent.name': 'nightshift-triage',
        'gen_ai.request.temperature': 0,
      },
    },
    async (span) => {
      try {
        const r = await fn();
        const o = outcome(r);
        span.setAttribute('gen_ai.response.model', model.path);
        if (o.tokensIn !== null) span.setAttribute('gen_ai.usage.input_tokens', o.tokensIn);
        if (o.tokensOut !== null) span.setAttribute('gen_ai.usage.output_tokens', o.tokensOut);
        if (o.tokensIn !== null && o.tokensOut !== null) span.setAttribute('gen_ai.usage.total_tokens', o.tokensIn + o.tokensOut);
        return r;
      } catch (err) {
        span.setStatus({ code: 2, message: (err as Error).message.slice(0, 200) });
        throw err;
      }
    },
  );
}

/** Tag the item span with the outcome once the bucket is known. */
export function annotateActiveSpan(attrs: Record<string, string | number | boolean>): void {
  if (!enabled) return;
  const span = Sentry.getActiveSpan();
  if (span) for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
}
