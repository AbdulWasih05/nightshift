// Sentry agent tracing: one invoke_agent span per item, one gen_ai.chat span per model attempt.
// Privacy: Sentry receives metadata only (model, tokens, latency, bucket). Prompts, titles, bodies and
// replies are stripped before send, so contributor data still never leaves the laptop. No-op without SENTRY_DSN.
import * as Sentry from '@sentry/node';

let enabled = false;

/**
 * Allowlist, not denylist: a span attribute reaches Sentry only if its key matches one of these. Anything an
 * integration adds that could carry contributor text (prompts, structured output, tool args, SQL params, URL
 * queries with logins) is dropped because it is not on the list.
 */
const ALLOWED_ATTR = [
  /^sentry\./,
  /^nightshift\.(repo|item|kind|prompt_version|night_id|bucket|model_path|parse_ok|fallbacks|duplicate_candidates|latency_ms)$/,
  /^gen_ai\.(operation\.name|provider\.name|request\.model|response\.model|agent\.name|request\.temperature|response\.finish_reasons)$/,
  /^gen_ai\.usage\.(input_tokens|output_tokens|total_tokens)$/,
  /^(http\.request\.method|http\.response\.status_code|http\.method|http\.status_code|server\.address|server\.port|net\.peer\.name)$/,
  /^(db\.system|db\.system\.name|db\.operation\.name|db\.collection\.name)$/,
  /^(otel\.kind|otel\.status_code)$/,
];

export function allowedAttribute(key: string): boolean {
  return ALLOWED_ATTR.some((re) => re.test(key));
}

/** Mutates `data`, removing every attribute not on the allowlist. */
export function scrubSpanData(data: Record<string, unknown> | undefined): void {
  if (!data) return;
  for (const k of Object.keys(data)) if (!allowedAttribute(k)) delete data[k];
}

export function initTelemetry(service: string): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn || enabled) return enabled;
  Sentry.init({
    dsn,
    tracesSampleRate: 1.0,
    // Nothing that can carry contributor text: no AI inputs/outputs, no HTTP bodies (Ollama requests contain
    // the prompt), no DB query data (upserts carry issue bodies), no URL queries (GitHub search has logins),
    // no stack-frame variables.
    dataCollection: {
      genAI: { inputs: false, outputs: false },
      httpBodies: [],
      databaseQueryData: false,
      urlQueryParams: false,
      stackFrameVariables: false,
      userInfo: false,
    },
    // Breadcrumbs collect console lines (logins, error text) and fetch URLs. Drop them all.
    beforeBreadcrumb: () => null,
    // Second fence: allowlist every span attribute.
    beforeSendSpan(span) {
      scrubSpanData(span.attributes as Record<string, unknown>);
      return span;
    },
    beforeSendTransaction(event) {
      scrubSpanData(event.contexts?.trace?.data as Record<string, unknown> | undefined);
      for (const sp of event.spans ?? []) scrubSpanData(sp.data as Record<string, unknown>);
      delete event.request;
      delete event.extra;
      event.breadcrumbs = [];
      return event;
    },
    // Error events (e.g. Mastra's integration capturing an Ollama ECONNREFUSED): keep the type and stack shape,
    // drop messages, breadcrumbs, request data and extras.
    beforeSend(event) {
      event.breadcrumbs = [];
      delete event.request;
      delete event.extra;
      if (event.message) event.message = '[redacted]';
      for (const ex of event.exception?.values ?? []) ex.value = ex.type ? `${ex.type} (message redacted)` : '[redacted]';
      return event;
    },
  });
  enabled = true;
  return true;
}

export function telemetryEnabled(): boolean {
  return enabled;
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
        span.setStatus({ code: 2, message: (err as Error).name || 'Error' }); // class name only, never the message
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
