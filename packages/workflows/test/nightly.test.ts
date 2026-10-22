// The workflow survives activity failures (retries, a dead repo, a crashing triage chunk), always writes the
// digest, and its recorded history replays deterministically. Activities are mocks; no DB, GitHub or Ollama.
import { fileURLToPath } from 'node:url';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as activities from '../src/activities.ts';
import { nightlyTriage } from '../src/workflows.ts';

const workflowsPath = fileURLToPath(new URL('../src/workflows.ts', import.meta.url));
let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 120_000);

afterAll(async () => {
  await env?.teardown();
});

function mocks(state: { chunkCalls: number; triaged: number; finished?: { status: string; notes: string }; digest: boolean }) {
  const total = 25;
  const a: Partial<typeof activities> = {
    loadNightConfig: async () => ({ repos: ['a/ok', 'b/down'], promptVersion: 'v1', maxItemsPerRepo: 200, initialLookbackHours: 24 }),
    startNight: async () => 7,
    collect: async ({ repo }) => {
      if (repo === 'b/down') throw new Error('GitHub 502');
      return { repo, collected: total, capped: false, errors: 0 };
    },
    claimBacklog: async () => 0,
    embed: async () => total,
    triageChunk: async ({ size }) => {
      state.chunkCalls++;
      // Ollama "restarts" during the 2nd and 3rd attempts: the activity fails and Temporal retries it.
      if (state.chunkCalls === 2 || state.chunkCalls === 3) throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
      const n = Math.min(size, total - state.triaged);
      state.triaged += n;
      return { processed: n, failed: 0, remaining: total - state.triaged };
    },
    writeDigest: async () => {
      state.digest = true;
      return { path: 'docs/digests/x.md', summary: 'summary' };
    },
    finishNight: async (args) => {
      state.finished = args;
    },
  };
  return a;
}

describe('nightlyTriage', () => {
  it('a crash after startNight still writes the digest and marks the night failed', async () => {
    const state = { chunkCalls: 0, triaged: 0, digest: false } as Parameters<typeof mocks>[0];
    const a = mocks(state);
    a.claimBacklog = async () => {
      throw new Error('relation "items" does not exist');
    };
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: 'test3', workflowsPath, activities: a });
    await worker.runUntil(async () => {
      // claimBacklog is on the DB proxy (retries until scheduleToClose); time-skipping fast-forwards the 3h budget.
      await expect(
        env.client.workflow.execute(nightlyTriage, { taskQueue: 'test3', workflowId: 'night-test-3', args: [{}] }),
      ).rejects.toThrow();
    });
    expect(state.digest).toBe(true);
    expect(state.finished?.status).toBe('failed');
    expect(state.finished?.notes).toMatch(/night crashed/);
  }, 180_000);

  it('retries a failing triage chunk, isolates a dead repo, still writes the digest, and replays deterministically', async () => {
    const state = { chunkCalls: 0, triaged: 0, digest: false } as Parameters<typeof mocks>[0];
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'test',
      workflowsPath,
      activities: mocks(state),
    });

    const handle = await worker.runUntil(async () => {
      const h = await env.client.workflow.start(nightlyTriage, { taskQueue: 'test', workflowId: 'night-test', args: [{}] });
      await h.result();
      return h;
    });
    const result = await handle.result();

    expect(result.triaged).toBe(25); // nothing lost to the two failed attempts
    expect(state.chunkCalls).toBe(5); // 3 successful chunks of 10/10/5 + 2 failed attempts
    expect(result.failedRepos).toEqual(['b/down']);
    expect(result.status).toBe('partial');
    expect(state.digest).toBe(true);
    expect(state.finished?.status).toBe('partial');
    expect(state.finished?.notes).toMatch(/collect b\/down failed/);

    // Replay the recorded history against the current workflow code: throws on any nondeterminism.
    const history = await handle.fetchHistory();
    await Worker.runReplayHistory({ workflowsPath }, history, 'night-test');
  }, 180_000);

  it('rejects repos that are not in the config', async () => {
    const state = { chunkCalls: 0, triaged: 0, digest: false } as Parameters<typeof mocks>[0];
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: 'test2', workflowsPath, activities: mocks(state) });
    await worker.runUntil(async () => {
      await expect(
        env.client.workflow.execute(nightlyTriage, { taskQueue: 'test2', workflowId: 'night-test-2', args: [{ repos: ['evil/repo'] }] }),
      ).rejects.toThrow();
    });
    expect(state.chunkCalls).toBe(0);
  }, 120_000);
});
