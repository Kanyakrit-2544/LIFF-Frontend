import { getDb } from "../db/client";
import { COLLECTIONS, type CustomerDoc } from "../db/models";
import { log } from "../logger";
import { newId } from "../ids";
import { toSheetRow } from "./toSheetRow";

/**
 * คิวซิงก์ Google Sheets (docs/00 RISK-4)
 *
 * ไม่ sync ทุกครั้งที่ข้อมูลเปลี่ยน เพราะ:
 *   - Sheets API จำกัดราว 60 write/นาที ชนเพดานง่ายตอนคนกรอกพร้อมกัน
 *   - read-then-write ของ Sheets ไม่ atomic → สอง worker พร้อมกัน = แถวซ้ำ
 *
 * จึงตั้งธง sheetSync.dirty แล้วให้ n8n มากวาดเป็นชุดทุก 2 นาที
 */

const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

async function col() {
  return (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers);
}

export interface SheetPendingRow {
  customerId: string;
  rowKey: string;
  values: string[];
  attempts: number;
}

/**
 * จองงานแบบกันสองคนหยิบชิ้นเดียวกัน — วิธีเดียวกับ inbox
 * หา id ก่อน (limit) แล้ว updateMany เฉพาะตัวที่ยัง dirty และไม่ถูกจอง → worker ที่มาทีหลัง match 0
 */
export async function claimDirtyCustomers(limit = 200): Promise<{ claimId: string; rows: SheetPendingRow[] }> {
  const c = await col();
  const now = new Date();
  const staleBefore = new Date(now.getTime() - LEASE_MS);

  // ปลดงานที่ค้างเพราะ worker ตายกลางคัน
  const released = await c.updateMany(
    { "sheetSync.dirty": true, "sheetSync.lockedAt": { $ne: null, $lte: staleBefore } },
    { $set: { "sheetSync.lockedAt": null } }
  );
  if (released.modifiedCount > 0) log.warn("ปลด lock ซิงก์ชีตที่ค้าง", { count: released.modifiedCount });

  const filter = {
    "sheetSync.dirty": true,
    "sheetSync.lockedAt": null,
    "sheetSync.attempts": { $lt: MAX_ATTEMPTS },
  };
  const candidates = await c.find(filter, { projection: { _id: 1 }, limit, sort: { updatedAt: 1 } }).toArray();
  if (candidates.length === 0) return { claimId: "", rows: [] };

  const claimId = newId("job");
  const r = await c.updateMany(
    { _id: { $in: candidates.map((x) => x._id) }, "sheetSync.lockedAt": null },
    { $set: { "sheetSync.lockedAt": now, "sheetSync.claimId": claimId } }
  );
  if (r.modifiedCount === 0) return { claimId: "", rows: [] };

  const docs = await c.find({ "sheetSync.claimId": claimId }).toArray();
  return {
    claimId,
    rows: docs.map((doc) => ({
      customerId: doc._id,
      rowKey: doc.sheetSync?.rowKey ?? doc._id,
      values: toSheetRow(doc),
      attempts: doc.sheetSync?.attempts ?? 0,
    })),
  };
}

export interface SheetAckItem {
  customerId: string;
  status: "ok" | "error";
  error?: string;
}

export async function ackSheetSync(items: SheetAckItem[]): Promise<{ ok: number; failed: number; dead: number }> {
  if (items.length === 0) return { ok: 0, failed: 0, dead: 0 };
  const c = await col();
  const now = new Date();

  const okIds = items.filter((i) => i.status === "ok").map((i) => i.customerId);
  let ok = 0;
  if (okIds.length > 0) {
    const r = await c.updateMany(
      { _id: { $in: okIds } },
      { $set: { "sheetSync.dirty": false, "sheetSync.syncedAt": now, "sheetSync.lockedAt": null, "sheetSync.attempts": 0 },
        $unset: { "sheetSync.claimId": "" } }
    );
    ok = r.modifiedCount;
  }

  let failed = 0;
  let dead = 0;
  for (const item of items.filter((i) => i.status === "error")) {
    const doc = await c.findOne({ _id: item.customerId }, { projection: { sheetSync: 1 } });
    const attempts = (doc?.sheetSync?.attempts ?? 0) + 1;
    await c.updateOne(
      { _id: item.customerId },
      { $set: { "sheetSync.attempts": attempts, "sheetSync.lockedAt": null }, $unset: { "sheetSync.claimId": "" } }
    );
    failed++;
    if (attempts >= MAX_ATTEMPTS) {
      dead++;
      // ยังคง dirty ไว้เพื่อให้เห็นว่าค้าง แต่ไม่ถูกหยิบซ้ำเพราะ filter กรอง attempts ออก
      log.error("ซิงก์ชีตล้มเหลวครบเพดาน", { customerId: item.customerId, attempts, error: item.error?.slice(0, 120) });
    }
  }

  return { ok, failed, dead };
}

export async function sheetSyncStats(): Promise<{ dirty: number; locked: number; stuck: number }> {
  const c = await col();
  const [dirty, locked, stuck] = await Promise.all([
    c.countDocuments({ "sheetSync.dirty": true }),
    c.countDocuments({ "sheetSync.dirty": true, "sheetSync.lockedAt": { $ne: null } }),
    c.countDocuments({ "sheetSync.dirty": true, "sheetSync.attempts": { $gte: MAX_ATTEMPTS } }),
  ]);
  return { dirty, locked, stuck };
}
