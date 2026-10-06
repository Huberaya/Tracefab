import { withTracefabWorkerContext } from './context.js';

export async function enqueueDueDataRequestReminders(horizonHours: number) {
  const rows = await withTracefabWorkerContext((tx) => tx.$queryRaw<Array<{ enqueued: number }>>`
    SELECT tracefab_enqueue_due_data_request_reminders(${horizonHours})::integer AS enqueued
  `);
  return Number(rows[0]?.enqueued ?? 0);
}
