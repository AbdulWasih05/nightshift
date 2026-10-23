import { Auth0Client } from '@auth0/nextjs-auth0/server';

// Reads AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_SECRET, APP_BASE_URL from the environment.
export const auth0 = new Auth0Client({
  // offline_access: the refresh token is what Token Vault exchanges for a GitHub token at post time.
  authorizationParameters: { scope: 'openid profile email offline_access' },
  // Mounts /auth/connect?connection=github: the Connected Accounts flow that puts a GitHub token in Token Vault.
  enableConnectAccountEndpoint: true,
});

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

export interface SessionUser {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  nickname?: string;
}

/**
 * Only these people can see drafts or approve anything: ALLOWED_EMAILS (verified emails) or ALLOWED_USERS
 * (Auth0 user ids like "github|12345678"). GitHub logins often carry no email (private email, or the GitHub
 * App lacks the "Email addresses" permission), so the stable user id is the reliable key.
 */
export function isAllowed(user: SessionUser | undefined | null): boolean {
  if (!user) return false;
  const ids = list(process.env.ALLOWED_USERS);
  if (user.sub && ids.includes(user.sub.toLowerCase())) return true;
  const emails = list(process.env.ALLOWED_EMAILS);
  return Boolean(user.email && user.email_verified !== false && emails.includes(user.email.toLowerCase()));
}

/**
 * Has the maintainer connected GitHub (Connected Accounts / Token Vault)? True if Token Vault can hand out a GitHub
 * token for this session. Used only to decide whether to show "Connect GitHub"; the token itself is discarded.
 */
export async function githubConnected(): Promise<boolean> {
  try {
    const t = await auth0.getAccessTokenForConnection({ connection: 'github' });
    return Boolean(t?.token);
  } catch {
    return false;
  }
}
