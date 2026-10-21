// Postgres text rejects NUL, and jsonb rejects \u0000 and lone UTF-16 surrogates. Issue bodies with pasted
// binary logs or truncated emoji contain both; one such item would otherwise fail the upsert.

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

export function scrubString(s: string): string {
  return s.replace(/\u0000/g, '').replace(LONE_SURROGATE, '�');
}

export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubString(value) as T;
  if (Array.isArray(value)) return value.map(scrubDeep) as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[scrubString(k)] = scrubDeep(v);
    return out as T;
  }
  return value;
}
