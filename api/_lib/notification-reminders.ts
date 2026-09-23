import { prisma } from './prisma';

export async function enqueueDueDataRequestReminders(horizonHours: number) {
  const rows = await prisma.$queryRaw<Array<{ enqueued: number }>>`
    SELECT tracefab_enqueue_due_data_request_reminders(${horizonHours})::integer AS enqueued
  `;
  return Number(rows[0]?.enqueued ?? 0);
}
