import { Octokit } from '@octokit/rest';
import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { assertWritable } from '../allowlist.ts';

const Kit = Octokit.plugin(retry, throttling);
export type GitHub = InstanceType<typeof Kit>;

const API = 'https://api.github.com';
/** Waits longer than this are not slept through; the request fails and the Temporal activity retry takes over. */
const MAX_RATE_LIMIT_WAIT_S = 120;

function base(token: string): GitHub {
  return new Kit({
    auth: token,
    baseUrl: API,
    userAgent: 'nightshift-triage',
    throttle: {
      onRateLimit: (retryAfter, options, _kit, retryCount) => {
        console.warn(`[github] rate limited on ${options.method} ${options.url}, retry in ${retryAfter}s (#${retryCount + 1})`);
        return retryCount < 3 && retryAfter <= MAX_RATE_LIMIT_WAIT_S;
      },
      onSecondaryRateLimit: (retryAfter, options, _kit, retryCount) => {
        console.warn(`[github] secondary rate limit on ${options.method} ${options.url}, retry in ${retryAfter}s`);
        return retryCount < 2 && retryAfter <= MAX_RATE_LIMIT_WAIT_S;
      },
    },
  });
}

function requireToken(token: string | undefined): string {
  // Unauthenticated is 60 req/h, which a single night on mastra exhausts in minutes.
  if (!token) throw new Error('GITHUB_TOKEN is not set (use a fine-grained PAT; see .env.example)');
  return token;
}

/**
 * Read-only client for the collector. Any non-GET request throws before it leaves the process,
 * so a bug in collection code cannot mutate a partner repo.
 */
export function createReadClient(token = process.env.GITHUB_TOKEN): GitHub {
  const kit = base(requireToken(token));
  kit.hook.before('request', (options) => {
    if (options.method !== 'GET') {
      throw new Error(`read-only GitHub client refused ${options.method} ${options.url}`);
    }
  });
  return kit;
}

/**
 * Write client bound to a single allowlisted repo. Every non-GET request must resolve to a URL under
 * that repo. The check runs on the fully expanded URL, not the owner/repo parameters, so a literal URL
 * like 'POST /repos/other/repo/...' or a per-request baseUrl cannot slip past it.
 * This client does not check approvals: `post` must refuse unless an `approvals` row exists.
 */
export function createWriteClient(repo: string, token = process.env.GITHUB_TOKEN): GitHub {
  assertWritable(repo);
  const kit = base(requireToken(token));
  kit.hook.before('request', (options) => {
    if (options.method === 'GET') return;
    const { url } = kit.request.endpoint.parse(options as Parameters<typeof kit.request.endpoint.parse>[0]);
    const target = parseRepoUrl(url);
    if (!target || target.toLowerCase() !== repo.toLowerCase()) {
      throw new Error(`write client for ${repo} refused ${options.method} ${url}`);
    }
    assertWritable(target);
  });
  return kit;
}

/** 'https://api.github.com/repos/o/r/issues/1/comments' -> 'o/r'; anything else -> null. */
export function parseRepoUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.origin !== API) return null;
  const m = /^\/repos\/([^/]+)\/([^/]+)(\/|$)/.exec(u.pathname);
  return m ? `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}` : null;
}
