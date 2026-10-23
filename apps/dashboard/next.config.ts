import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import type { NextConfig } from 'next';

// Laptop mode: reuse the repo's root .env. On Render the variables come from the service (render.yaml).
loadEnv({ path: resolve(import.meta.dirname, '../../.env'), quiet: true });

const config: NextConfig = {
  // @nightshift/core ships TypeScript sources (with .ts import specifiers); compile them with the app.
  transpilePackages: ['@nightshift/core'],
  // pg and the Octokit plugins are server-only Node packages.
  serverExternalPackages: ['pg'],
};

export default config;
