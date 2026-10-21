// Hard write allowlist. This is the only place a repo can be granted write mode,
// and it is a source constant on purpose: no env var, flag or config file can widen it.
// Partner repos are read-only, always.
export const WRITE_ALLOWLIST: readonly string[] = Object.freeze(['AbdulWasih05/nightshift']);

export class WriteNotAllowedError extends Error {
  constructor(repo: string) {
    super(`refusing to write to ${repo}: not in the hard write allowlist (${WRITE_ALLOWLIST.join(', ')})`);
    this.name = 'WriteNotAllowedError';
  }
}

export function isWritable(repo: string): boolean {
  return WRITE_ALLOWLIST.some((r) => r.toLowerCase() === repo.toLowerCase());
}

/** Call before every GitHub mutation. Throws unless the repo is allowlisted. */
export function assertWritable(repo: string): void {
  if (!isWritable(repo)) throw new WriteNotAllowedError(repo);
}
