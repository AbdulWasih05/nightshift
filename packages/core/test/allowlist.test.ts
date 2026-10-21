import { describe, expect, it } from 'vitest';
import { assertWritable, isWritable, WRITE_ALLOWLIST, WriteNotAllowedError } from '../src/allowlist.ts';
import { parseConfig } from '../src/config.ts';
import { createReadClient, createWriteClient, parseRepoUrl } from '../src/github/client.ts';

describe('write allowlist', () => {
  it('allows only the own repo, case-insensitively', () => {
    expect(isWritable('AbdulWasih05/nightshift')).toBe(true);
    expect(isWritable('abdulwasih05/NIGHTSHIFT')).toBe(true);
    for (const partner of ['mastra-ai/mastra', 'temporalio/temporal', 'timescale/timescaledb']) {
      expect(isWritable(partner)).toBe(false);
      expect(() => assertWritable(partner)).toThrow(WriteNotAllowedError);
    }
  });

  it('cannot be widened at runtime', () => {
    expect(() => (WRITE_ALLOWLIST as string[]).push('mastra-ai/mastra')).toThrow();
    expect(isWritable('mastra-ai/mastra')).toBe(false);
  });

  it('rejects a config that puts a partner repo in write mode', () => {
    expect(() => parseConfig({ repos: [{ repo: 'mastra-ai/mastra', mode: 'write' }] })).toThrow(/read-only/);
    expect(parseConfig({ repos: [{ repo: 'mastra-ai/mastra', mode: 'read' }] }).repos).toHaveLength(1);
  });

  it('refuses to build a write client for a partner repo', () => {
    expect(() => createWriteClient('temporalio/temporal', 'x')).toThrow(WriteNotAllowedError);
  });

  it('write client refuses mutations aimed at another repo', async () => {
    const gh = createWriteClient('AbdulWasih05/nightshift', 'x');
    await expect(
      gh.issues.createComment({ owner: 'mastra-ai', repo: 'mastra', issue_number: 1, body: 'hi' }),
    ).rejects.toThrow(/refused POST/);
  });

  it('write client checks the resolved URL, not the owner/repo params (literal-URL bypass)', async () => {
    const gh = createWriteClient('AbdulWasih05/nightshift', 'x');
    await expect(
      gh.request('POST /repos/mastra-ai/mastra/issues/1/comments', { owner: 'AbdulWasih05', repo: 'nightshift', body: 'hi' }),
    ).rejects.toThrow(/refused POST https:\/\/api.github.com\/repos\/mastra-ai\/mastra/);
  });

  it('write client refuses a per-request baseUrl override', async () => {
    const gh = createWriteClient('AbdulWasih05/nightshift', 'x');
    await expect(
      gh.request('POST /repos/{owner}/{repo}/issues/1/comments', {
        owner: 'AbdulWasih05', repo: 'nightshift', body: 'hi', baseUrl: 'https://evil.example',
      }),
    ).rejects.toThrow(/refused POST/);
  });

  it('write client refuses non-repo endpoints (gists, user)', async () => {
    const gh = createWriteClient('AbdulWasih05/nightshift', 'x');
    await expect(gh.request('POST /gists', { files: {} })).rejects.toThrow(/refused POST/);
  });

  it('parseRepoUrl only accepts api.github.com/repos/o/r', () => {
    expect(parseRepoUrl('https://api.github.com/repos/AbdulWasih05/nightshift/issues/1/comments')).toBe('AbdulWasih05/nightshift');
    expect(parseRepoUrl('https://api.github.com/repos/AbdulWasih05/nightshift')).toBe('AbdulWasih05/nightshift');
    expect(parseRepoUrl('https://evil.example/repos/AbdulWasih05/nightshift/issues')).toBeNull();
    expect(parseRepoUrl('https://api.github.com/gists')).toBeNull();
    expect(parseRepoUrl('/repos/a/b')).toBeNull();
  });

  it('clients refuse to start without a token', () => {
    expect(() => createReadClient('')).toThrow(/GITHUB_TOKEN/);
  });

  it('read client refuses every non-GET request', async () => {
    const gh = createReadClient('x');
    await expect(
      gh.issues.createComment({ owner: 'AbdulWasih05', repo: 'nightshift', issue_number: 1, body: 'hi' }),
    ).rejects.toThrow(/read-only GitHub client refused POST/);
  });
});
