import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "mongodb";
import {
  COLLECTIONS,
  closeClient,
  ensureIndexes,
  evaluateDataStatus,
  getDb,
  updateStatusIncidents,
  type StatusIssue,
  type StatusSink,
} from "../src";

const runIntegration = process.env.RUN_MONGO_INTEGRATION === "true";
const runId = `status_${Date.now()}_${Math.random().toString(16).slice(2)}`;
let db: Db;

beforeAll(async () => {
  if (!runIntegration) return;
  db = await getDb();
  await ensureIndexes(db);
});

afterAll(async () => {
  if (runIntegration) {
    await Promise.all([
      db.collection(COLLECTIONS.inboundEvents).deleteMany({ eventId: runId }),
      db.collection(COLLECTIONS.statusIncidents).deleteMany({ code: { $regex: `^${runId}` } }),
    ]);
  }
  await closeClient();
});

describe.runIf(runIntegration)("system status", () => {
  it("พบคิวที่ค้างเกิน threshold", async () => {
    const now = new Date("2026-08-31T12:00:00Z");
    await db.collection(COLLECTIONS.inboundEvents).insertOne({
      eventId: runId, provider: "test", channelId: null, status: "pending", attempts: 0,
      nextAttemptAt: new Date(now.getTime() - 20 * 60_000), raw: {}, lastError: null, receivedAt: new Date(now.getTime() - 20 * 60_000), processedAt: null,
    });
    const status = await evaluateDataStatus(db, {
      queueStaleMinutes: 15, sheetStaleMinutes: 30, aiStaleMinutes: 30, errorWindowMinutes: 15, errorSpikeCount: 10,
    }, now);
    expect(status.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: "inbound.stale", ageMinutes: 20 })]));
  });

  it("event เก่าแต่ยังอยู่ในช่วง backoff ไม่ถูกแจ้งว่าค้าง", async () => {
    const now = new Date("2026-08-31T13:00:00Z");
    await db.collection(COLLECTIONS.inboundEvents).updateOne(
      { eventId: runId },
      { $set: { receivedAt: new Date(now.getTime() - 20 * 60_000), nextAttemptAt: new Date(now.getTime() + 5 * 60_000) } }
    );
    const status = await evaluateDataStatus(db, {
      queueStaleMinutes: 15, sheetStaleMinutes: 30, aiStaleMinutes: 30, errorWindowMinutes: 15, errorSpikeCount: 10,
    }, now);
    expect(status.issues.some((issue) => issue.code === "inbound.stale")).toBe(false);
  });

  it("ปัญหาเดิมรายงานครั้งเดียว หายแล้วเกิดใหม่จึงรายงานอีก", async () => {
    const sent: string[] = [];
    const sink: StatusSink = { async send(issue) { sent.push(issue.code); } };
    const issue: StatusIssue = { code: `${runId}.repeat`, severity: "warning", title: "test", detail: "test", count: 1, ageMinutes: 20 };
    const first = await updateStatusIncidents(db, [issue], sink, new Date("2026-08-31T12:00:00Z"));
    const second = await updateStatusIncidents(db, [issue], sink, new Date("2026-08-31T12:05:00Z"));
    await updateStatusIncidents(db, [], sink, new Date("2026-08-31T12:10:00Z"));
    const again = await updateStatusIncidents(db, [issue], sink, new Date("2026-08-31T12:15:00Z"));
    expect(first.newlyReported).toEqual([issue.code]);
    expect(second.stillOpen).toEqual([issue.code]);
    expect(again.newlyReported).toEqual([issue.code]);
    expect(sent).toEqual([issue.code, issue.code]);
  });

  it("sink ล้มเหลวแล้วรอบถัดไปต้องลองรายงานใหม่", async () => {
    const code = `${runId}.sink-retry`;
    const issue: StatusIssue = { code, severity: "critical", title: "test", detail: "test", count: 1, ageMinutes: null };
    await expect(updateStatusIncidents(db, [issue], { async send() { throw new Error("sink down"); } }))
      .rejects.toThrow("sink down");
    expect(await db.collection(COLLECTIONS.statusIncidents).findOne({ code })).toMatchObject({ status: "open", reportedAt: null });
    const sent: string[] = [];
    const retry = await updateStatusIncidents(db, [issue], { async send(value) { sent.push(value.code); } });
    expect(retry.newlyReported).toEqual([code]);
    expect(sent).toEqual([code]);
  });
});
