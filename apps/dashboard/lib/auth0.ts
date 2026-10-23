import { Auth0Client } from '@auth0/nextjs-auth0/server';

// Reads AUTH0_DOMAIN, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, AUTH0_SECRET, APP_BASE_URL from the environment.
export const auth0 = new Auth0Client({
  // offline_access: the refresh token is what Token Vault exchanges for a GitHub token at post time.
  authorizationParameters: { scope: 'openid profile email offline_access' },
  // Mounts /auth/connect?connection=github: the Connected Accounts flow that puts a GitHub token in Token Vault.
  enableConnectAccountEndpoint: true,
});

/** Only these people can see drafts or approve anything. Comma-separated, case-insensitive. */
export function isAllowed(email: string | undefined | null): boolean {
  const allow = (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return Boolean(email) && allow.includes(email!.toLowerCase());
}
