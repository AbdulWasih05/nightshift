import { Client, Connection, ScheduleNotFoundError, ScheduleOverlapPolicy } from '@temporalio/client';
import { nightlyTriage, type NightlyInput, type NightlyResult } from './workflows.ts';

export const TASK_QUEUE = process.env.TEMPORAL_TASK_QUEUE ?? 'nightshift';
export const SCHEDULE_ID = 'nightshift-nightly';

async function client(): Promise<Client> {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233' });
  return new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' });
}

/** Start a night now and wait for it (`nightshift run`). Needs a worker running. */
export async function runNightNow(input: NightlyInput = {}): Promise<NightlyResult> {
  const c = await client();
  const handle = await c.workflow.start(nightlyTriage, {
    taskQueue: TASK_QUEUE,
    workflowId: `nightshift-manual-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    args: [input],
  });
  console.log(`started ${handle.workflowId}; watch at http://localhost:8233/namespaces/default/workflows/${handle.workflowId}`);
  try {
    return await handle.result();
  } finally {
    await c.connection.close();
  }
}

/** Create or update the 02:00 schedule. Idempotent. */
export async function upsertSchedule(opts: { cron: string; timezone: string }): Promise<string> {
  const c = await client();
  try {
    const spec = { cronExpressions: [opts.cron], timezone: opts.timezone };
    const action = { type: 'startWorkflow' as const, workflowType: nightlyTriage, taskQueue: TASK_QUEUE, args: [{}] as [NightlyInput] };
    try {
      const handle = c.schedule.getHandle(SCHEDULE_ID);
      await handle.update((prev) => ({ ...prev, spec, action }));
      return 'updated';
    } catch (err) {
      if (!(err instanceof ScheduleNotFoundError)) throw err;
      await c.schedule.create({
        scheduleId: SCHEDULE_ID,
        spec,
        action,
        // If the laptop was asleep at 02:00, run on wake as long as it is within 6 hours; never two nights at once.
        policies: { overlap: ScheduleOverlapPolicy.SKIP, catchupWindow: '6 hours' },
      });
      return 'created';
    }
  } finally {
    await c.connection.close();
  }
}

export async function describeSchedule(): Promise<{ next: Date[]; paused: boolean } | null> {
  const c = await client();
  try {
    const d = await c.schedule.getHandle(SCHEDULE_ID).describe();
    return { next: d.info.nextActionTimes, paused: d.state.paused };
  } catch (err) {
    if (err instanceof ScheduleNotFoundError) return null;
    throw err;
  } finally {
    await c.connection.close();
  }
}
