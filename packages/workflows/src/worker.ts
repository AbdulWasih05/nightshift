// Long-running worker for the nightly workflow. Start it once (scripts/night-stack.ps1 does it detached);
// the Temporal Schedule fires the workflow at 02:00 and this process does the work.
import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { NativeConnection, Worker } from '@temporalio/worker';
import * as activities from './activities.ts';
import { initTelemetry } from '@nightshift/core';

import { TASK_QUEUE } from './client.ts';

export async function runWorker(): Promise<void> {
  const sentry = initTelemetry('worker');
  // Preflight reads this line from ~/.nightshift/worker.out.log: the worker's env, not the shell's, is what counts.
  console.log(`[worker] sentry: ${sentry ? 'on' : 'off'}`);
  const connection = await NativeConnection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
    activities,
    // Room for the per-repo collects to run in parallel. Triage chunks are sequential in the workflow anyway:
    // the GPU is the bottleneck, and parallel model calls would only thrash it.
    maxConcurrentActivityTaskExecutions: 4,
  });
  console.log(`[worker] polling task queue "${TASK_QUEUE}"`);
  await worker.run();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runWorker().catch((err) => {
    console.error('[worker] fatal:', err);
    process.exit(1);
  });
}
