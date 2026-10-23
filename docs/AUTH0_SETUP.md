# Auth0 setup (Token Vault for the hosted dashboard)

The dashboard never stores a GitHub token. You log in with Auth0, connect GitHub once (Connected Accounts), and Auth0 Token Vault hands the dashboard a short-lived GitHub token only when you press **Post** on an approved reply.

Replace `DASHBOARD_URL` with your Render URL (e.g. `https://nightshift-dashboard.onrender.com`) and `YOUR_AUTH0_DOMAIN` with your tenant domain.

## A. Auth0 application
1. **Applications > Applications > Create Application**: name `Nightshift`, type **Regular Web Applications**.
2. **Settings**:
   - Allowed Callback URLs: `http://localhost:3000/auth/callback, DASHBOARD_URL/auth/callback`
   - Allowed Logout URLs: `http://localhost:3000, DASHBOARD_URL`
   - Allowed Web Origins: `http://localhost:3000, DASHBOARD_URL`
3. **Advanced Settings > Grant Types**: Authorization Code, Refresh Token, **Token Vault**.

## B. GitHub App (the OAuth client Auth0 uses for GitHub)
1. GitHub **Settings > Developer settings > GitHub Apps > New GitHub App**.
2. Homepage URL `https://YOUR_AUTH0_DOMAIN`; Callback URL `https://YOUR_AUTH0_DOMAIN/login/callback`; Webhook **inactive**.
3. Repository permissions: **Issues: Read and write**, **Pull requests: Read and write** (Metadata read-only is automatic). Nothing else: no Contents, no merge, no admin.
4. Installable **Only on this account**. Create, then generate a client secret.
5. **Install App > Only select repositories > your own repo only.** GitHub itself then refuses writes anywhere else, a fence behind the code's allowlist.

## C. GitHub connection in Auth0
1. **Authentication > Social > Create Connection > GitHub**: Client ID and secret from B.
2. **Purpose: Connected Accounts for Token Vault** on.
3. On the connection's **Applications** tab, enable `Nightshift`.

## D. My Account API and refresh tokens
1. **Applications > APIs**: on the **My Account API** card, click **Activate** (not "Create API").
2. Open **Auth0 My Account API > Application Access > Nightshift > Edit > User-Delegated Access > Grant Access**, select only `create:me:connected_accounts`, `read:me:connected_accounts`, `delete:me:connected_accounts`, then Save.
3. **Applications > Nightshift > Multi-Resource Refresh Token > Edit Configuration**: toggle **My Account API** on.
4. **Nightshift > Settings > Access Settings**: **Allow Skipping User Consent** on.

## E. Environment
`AUTH0_DOMAIN`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, `AUTH0_SECRET` (32 random bytes, hex), `APP_BASE_URL`, `ALLOWED_EMAILS`. In the dashboard, click **Connect GitHub** once after logging in.

Sources: [Auth0 GitHub integration](https://auth0.com/ai/docs/integrations/github), [Configure Token Vault](https://auth0.com/docs/secure/call-apis-on-users-behalf/token-vault/configure-token-vault), [Connected Accounts for Token Vault](https://auth0.com/docs/secure/call-apis-on-users-behalf/token-vault/connected-accounts-for-token-vault).
