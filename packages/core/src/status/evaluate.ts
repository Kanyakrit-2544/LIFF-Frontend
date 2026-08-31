import type { Db } from "mongodb";
import { env } from "../env";
import { COLLECTIONS, type AuditLogDoc, type CustomerDoc, type InboundEventDoc } from "../db/models";
import type { CustomerIntentDoc, PurchaseDoc } from "../partner/models";

export type StatusSeverity = "warning" | "critical";

export interface StatusIssue {
  code: string;
  severity: StatusSeverity;
  title: string;
  detail: string;
  count: number;
  ageMinutes: number | null;
}

export interface StatusThresholds {
  queueStaleMinutes: number;
  sheetStaleMinutes: number;
  aiStaleMinutes: number;
  errorWindowMinutes: number;
  errorSpikeCount: number;
}

export interface SystemStatus {
  ok: boolean;
  checkedAt: Date;
  issues: StatusIssue[];
  thresholds: StatusThresholds;
}

export function statusThresholds(): StatusThresholds {
  const config = env("status");
  return {
    queueStaleMinutes: config.STATUS_QUEUE_STALE_MINUTES,
    sheetStaleMinutes: config.STATUS_SHEET_STALE_MINUTES,
    aiStaleMinutes: config.STATUS_AI_STALE_MINUTES,
    errorWindowMinutes: config.STATUS_ERROR_WINDOW_MINUTES,
    errorSpikeCount: config.STATUS_ERROR_SPIKE_COUNT,
  };
}

const cutoff = (now: Date, minutes: number) => new Date(now.getTime() - minutes * 60_000);
const age = (now: Date, value: Date | null | undefined) => value ? Math.max(0, Math.floor((now.getTime() - value.getTime()) / 60_000)) : null;

export async function evaluateDataStatus(
  db: Db,
  thresholds = statusThresholds(),
  now = new Date()
): Promise<SystemStatus> {
  const queueCutoff = cutoff(now, thresholds.queueStaleMinutes);
  const sheetCutoff = cutoff(now, thresholds.sheetStaleMinutes);
  const aiCutoff = cutoff(now, thresholds.aiStaleMinutes);
  const errorCutoff = cutoff(now, thresholds.errorWindowMinutes);
  const [dead, staleQueue, staleSheet, sheetDead, staleCustomersAi, customerAiDead, stalePurchasesAi, purchaseAiDead, staleIntentsAi, intentAiDead, recentErrors] = await Promise.all([
    db.collection<InboundEventDoc>(COLLECTIONS.inboundEvents).countDocuments({ status: "dead" }),
    db.collection<InboundEventDoc>(COLLECTIONS.inboundEvents).findOne(
      { $or: [
        { status: "pending", nextAttemptAt: { $lte: queueCutoff } },
        { status: "processing", claimedAt: { $lte: queueCutoff } },
        { status: "failed", receivedAt: { $lte: queueCutoff } },
      ] },
      { sort: { receivedAt: 1 }, projection: { receivedAt: 1 } }
    ),
    db.collection<CustomerDoc>(COLLECTIONS.customers).findOne(
      { "sheetSync.dirty": true, updatedAt: { $lte: sheetCutoff }, $or: [
        { "sheetSync.lockedAt": null }, { "sheetSync.lockedAt": { $lte: sheetCutoff } },
      ] },
      { sort: { updatedAt: 1 }, projection: { updatedAt: 1 } }
    ),
    db.collection<CustomerDoc>(COLLECTIONS.customers).countDocuments({ "sheetSync.dirty": true, "sheetSync.attempts": { $gte: 5 } }),
    db.collection<CustomerDoc>(COLLECTIONS.customers).findOne(
      { "aiSync.dirty": true, updatedAt: { $lte: aiCutoff }, $or: [
        { "aiSync.lockedAt": null }, { "aiSync.lockedAt": { $lte: aiCutoff } },
      ] },
      { sort: { updatedAt: 1 }, projection: { updatedAt: 1 } }
    ),
    db.collection<CustomerDoc>(COLLECTIONS.customers).countDocuments({ "aiSync.dirty": true, "aiSync.attempts": { $gte: 5 } }),
    db.collection<PurchaseDoc>(COLLECTIONS.purchases).findOne(
      { "aiSync.dirty": true, updatedAt: { $lte: aiCutoff }, $or: [
        { "aiSync.lockedAt": null }, { "aiSync.lockedAt": { $lte: aiCutoff } },
      ] },
      { sort: { updatedAt: 1 }, projection: { updatedAt: 1 } }
    ),
    db.collection<PurchaseDoc>(COLLECTIONS.purchases).countDocuments({ "aiSync.dirty": true, "aiSync.attempts": { $gte: 5 } }),
    db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents).findOne(
      { "aiSync.dirty": true, updatedAt: { $lte: aiCutoff }, $or: [
        { "aiSync.lockedAt": null }, { "aiSync.lockedAt": { $lte: aiCutoff } },
      ] },
      { sort: { updatedAt: 1 }, projection: { updatedAt: 1 } }
    ),
    db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents).countDocuments({ "aiSync.dirty": true, "aiSync.attempts": { $gte: 5 } }),
    db.collection<AuditLogDoc>(COLLECTIONS.auditLogs).countDocuments({ action: "workflow.error", at: { $gte: errorCutoff } }),
  ]);

  const issues: StatusIssue[] = [];
  if (dead > 0) issues.push({ code: "inbound.dead", severity: "critical", title: "มีข้อความเข้า dead letter", detail: "ข้อความบางรายการ retry ครบเพดานแล้ว", count: dead, ageMinutes: null });
  if (staleQueue) issues.push({ code: "inbound.stale", severity: "warning", title: "คิวรับข้อความค้าง", detail: `รายการเก่าที่สุดค้างเกิน ${thresholds.queueStaleMinutes} นาที`, count: 1, ageMinutes: age(now, staleQueue.receivedAt) });
  if (sheetDead > 0) issues.push({ code: "sheet.dead", severity: "critical", title: "ซิงก์ชีตล้มเหลวครบเพดาน", detail: "มีลูกค้าที่เขียนลงชีตไม่สำเร็จหลัง retry", count: sheetDead, ageMinutes: null });
  if (staleSheet) issues.push({ code: "sheet.stale", severity: "warning", title: "Google Sheet ยังไม่อัปเดต", detail: `มีข้อมูลรอซิงก์เกิน ${thresholds.sheetStaleMinutes} นาที`, count: 1, ageMinutes: age(now, staleSheet.updatedAt) });
  const aiDead = customerAiDead + purchaseAiDead + intentAiDead;
  if (aiDead > 0) issues.push({ code: "ai_mirror.dead", severity: "critical", title: "AI mirror ล้มเหลวครบเพดาน", detail: "มีข้อมูลที่ส่งไปฐาน AI ไม่สำเร็จหลัง retry", count: aiDead, ageMinutes: null });
  const oldestAi = [staleCustomersAi?.updatedAt, stalePurchasesAi?.updatedAt, staleIntentsAi?.updatedAt]
    .filter((value): value is Date => Boolean(value)).sort((a, b) => a.getTime() - b.getTime())[0];
  if (oldestAi) issues.push({ code: "ai_mirror.stale", severity: "warning", title: "AI mirror ค้าง", detail: `มีข้อมูลรอส่งเกิน ${thresholds.aiStaleMinutes} นาที`, count: 1, ageMinutes: age(now, oldestAi) });
  if (recentErrors >= thresholds.errorSpikeCount) issues.push({ code: "workflow.error_spike", severity: "warning", title: "Workflow error พุ่งผิดปกติ", detail: `พบ ${recentErrors} ครั้งใน ${thresholds.errorWindowMinutes} นาที`, count: recentErrors, ageMinutes: thresholds.errorWindowMinutes });
  return { ok: issues.length === 0, checkedAt: now, issues, thresholds };
}
