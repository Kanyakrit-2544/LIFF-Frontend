import { getDb, pingDb } from "../db/client";
import type { StatusSink } from "./incidents";
import { ConsoleStatusSink, updateStatusIncidents } from "./incidents";
import { evaluateDataStatus, statusThresholds, type SystemStatus } from "./evaluate";

export async function checkSystemStatus(options: {
  persist?: boolean;
  sink?: StatusSink;
  now?: Date;
} = {}): Promise<SystemStatus & { incidentUpdate?: Awaited<ReturnType<typeof updateStatusIncidents>> }> {
  const now = options.now ?? new Date();
  const dbStatus = await pingDb();
  if (!dbStatus.ok) {
    return {
      ok: false,
      checkedAt: now,
      thresholds: statusThresholds(),
      issues: [{ code: "database.unavailable", severity: "critical", title: "เชื่อมฐานข้อมูลไม่ได้", detail: "MongoDB ping ไม่ผ่าน", count: 1, ageMinutes: null }],
    };
  }
  const db = await getDb();
  const status = await evaluateDataStatus(db, statusThresholds(), now);
  if (!options.persist) return status;
  return {
    ...status,
    incidentUpdate: await updateStatusIncidents(db, status.issues, options.sink ?? new ConsoleStatusSink(), now),
  };
}
