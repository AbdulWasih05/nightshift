// Keyset pagination over GitHub's `since` filter. Offset pages over a list sorted by updated_at shift when an
// item is updated mid-fetch, silently skipping one item per shift. Re-querying from the last seen
// updated_at each time (deduped by number) cannot skip anything; `page` only advances in the rare case
// that a whole page shares one timestamp.

export interface ListedIssue {
  number: number;
  updated_at: string;
}

export interface SincePageFetcher<T extends ListedIssue> {
  (since: string, page: number): Promise<T[]>;
}

export interface SinceScanResult<T> {
  /** Items that are new or changed since we last stored them, oldest first. */
  changed: T[];
  /** True if `max` was reached before the listing was exhausted. */
  capped: boolean;
  /** Cursor for the next run: max updated_at among items considered (GitHub server time, not laptop time). */
  cursor: string;
}

export const PAGE_SIZE = 100;

export async function scanSince<T extends ListedIssue>(opts: {
  since: string;
  max: number;
  fetchPage: SincePageFetcher<T>;
  /** Returns the subset of numbers whose stored updated_at already equals the listed one (nothing new). */
  unchanged: (items: T[]) => Promise<Set<number>>;
  /** Safety valve against an API that never ends. */
  maxRequests?: number;
}): Promise<SinceScanResult<T>> {
  const seen = new Map<number, string>(); // number -> updated_at we already hold
  const changed: T[] = [];
  let since = opts.since;
  let page = 1;
  let cursor = opts.since;
  let requests = 0;
  const maxRequests = opts.maxRequests ?? 200;

  while (requests++ < maxRequests) {
    const batch = await opts.fetchPage(since, page);
    const fresh: T[] = [];
    for (const item of batch) {
      const held = seen.get(item.number);
      if (held === undefined) {
        fresh.push(item);
      } else if (item.updated_at > held) {
        // Updated while we were paging: keep the newer snapshot so the cursor cannot pass it unseen.
        const idx = changed.findIndex((c) => c.number === item.number);
        if (idx >= 0) changed[idx] = item;
        else fresh.push(item);
      }
      seen.set(item.number, item.updated_at > (held ?? '') ? item.updated_at : held!);
    }
    const same = await opts.unchanged(fresh);

    for (const item of fresh) {
      if (same.has(item.number)) {
        if (item.updated_at > cursor) cursor = item.updated_at;
        continue;
      }
      if (changed.length >= opts.max) return { changed, capped: true, cursor };
      changed.push(item);
      if (item.updated_at > cursor) cursor = item.updated_at;
    }

    if (batch.length < PAGE_SIZE) return { changed, capped: false, cursor };
    const last = batch[batch.length - 1]!.updated_at;
    if (last === since) {
      page++; // whole page shares one timestamp: step through it by offset
    } else {
      since = last;
      page = 1;
    }
  }
  throw new Error(`scanSince: gave up after ${maxRequests} requests (since=${opts.since})`);
}
