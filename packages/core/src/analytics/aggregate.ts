import type { Db } from "mongodb";
import { AI_COLLECTIONS, type CustomerLinkDoc } from "../db/models";
import { courseByCode } from "../legacy/courses";
import {
  bangkokKey,
  bangkokRange,
  previousRange,
  withDerived,
  type AnalyticsQuery,
  type AnalyticsResult,
  type AnalyticsRow,
} from "./query";

/**
 * ตัวเลขทั้งหมดของระบบออกจากที่นี่ที่เดียว (D36)
 *
 * ⭐ กฎที่พลาดแล้วเงียบ:
 * - เงินอยู่ที่ payment เท่านั้น 1 การชำระมีได้หลายคอร์ส (docs/21 §21.4)
 *   เอา amount ไปบวกที่ระดับคอร์ส = ยอดเกินจริง 14.5%
 * - ที่นั่งนับเฉพาะ countsAsSeat — relearn/free/refund ไม่ใช่การขาย
 * - ใหม่/เก่า ตัดสินที่ "เคยซื้อก่อนหน้าไหม" ไม่ใช่ "มี link ไหม"
 */

interface PaymentRow {
  personKey: string;
  source: "legacy" | "partner";
  amount: number | null;
  paidAt: Date | null;
  saleRep: string | null;
  synthetic: boolean;
  customerId: string | null;
}

interface SeatRow {
  personKey: string;
  source: "legacy" | "partner";
  courseCode: string;
  at: Date | null;
  synthetic: boolean;
}

const label = (code: string) => courseByCode(code)?.nameTh ?? code;

/** ยุบคนที่เป็นคนเดียวกันข้ามสองแหล่ง — ใช้เฉพาะ link ที่ยืนยันแล้ว (§5.3) */
async function personKeyMap(db: Db): Promise<Map<string, string>> {
  const links = await db
    .collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks)
    .find({ status: { $in: ["auto", "confirmed"] } }, { projection: { customerId: 1, legacyPersonId: 1 } })
    .toArray();
  const map = new Map<string, string>();
  for (const l of links) map.set(`lgp:${l.legacyPersonId}`, `cus:${l.customerId}`);
  return map;
}

async function loadPayments(db: Db, q: AnalyticsQuery, start: Date, end: Date): Promise<PaymentRow[]> {
  const keyMap = await personKeyMap(db);
  const rows: PaymentRow[] = [];

  if (q.sources.includes("legacy")) {
    const filter: Record<string, unknown> = { paidAt: { $gte: start.toISOString().slice(0, 10), $lte: end.toISOString().slice(0, 10) } };
    if (!q.includeSynthetic) filter.synthetic = { $ne: true };
    for (const p of await db.collection(AI_COLLECTIONS.legacyPaymentsScrubbed).find(filter).toArray()) {
      const raw = `lgp:${p.personId}`;
      rows.push({
        personKey: keyMap.get(raw) ?? raw,
        source: "legacy",
        amount: typeof p.amount === "number" ? p.amount : null,
        paidAt: p.paidAt ? new Date(`${p.paidAt}T00:00:00+07:00`) : null,
        saleRep: p.saleRep ?? null,
        synthetic: p.synthetic === true,
        customerId: null,
      });
    }
  }

  if (q.sources.includes("partner")) {
    const filter: Record<string, unknown> = {
      paidAt: { $gte: start.toISOString().slice(0, 10), $lte: end.toISOString().slice(0, 10) },
      status: { $ne: "voided" }, // การชำระที่ถูกยกเลิกไม่นับ
    };
    for (const p of await db.collection(AI_COLLECTIONS.purchasesScrubbed).find(filter).toArray()) {
      rows.push({
        personKey: p.customerId ? `cus:${p.customerId}` : `pur:${p._id}`,
        source: "partner",
        amount: typeof p.amount === "number" ? p.amount : null,
        paidAt: p.paidAt ? new Date(`${p.paidAt}T00:00:00+07:00`) : null,
        saleRep: p.saleRep ?? null,
        synthetic: p.synthetic === true,
        customerId: p.customerId ?? null,
      });
    }
  }
  return rows;
}

async function loadSeats(db: Db, q: AnalyticsQuery, start: Date, end: Date): Promise<SeatRow[]> {
  const keyMap = await personKeyMap(db);
  const rows: SeatRow[] = [];
  const inRange = (d: string | null | undefined) =>
    Boolean(d) && d! >= start.toISOString().slice(0, 10) && d! <= end.toISOString().slice(0, 10);

  if (q.sources.includes("legacy")) {
    const filter: Record<string, unknown> = { countsAsSeat: true };
    if (!q.includeSynthetic) filter.synthetic = { $ne: true };
    if (q.courseCodes?.length) filter.courseCode = { $in: q.courseCodes };
    for (const e of await db.collection(AI_COLLECTIONS.legacyEnrollmentsScrubbed).find(filter).toArray()) {
      if (!inRange(e.sessionStart)) continue;
      const raw = `lgp:${e.personId}`;
      rows.push({
        personKey: keyMap.get(raw) ?? raw,
        source: "legacy",
        courseCode: e.courseCode,
        at: e.sessionStart ? new Date(`${e.sessionStart}T00:00:00+07:00`) : null,
        synthetic: e.synthetic === true,
      });
    }
  }

  if (q.sources.includes("partner")) {
    const filter: Record<string, unknown> = { countsAsSeat: true };
    if (q.courseCodes?.length) filter.courseCode = { $in: q.courseCodes };
    for (const e of await db.collection(AI_COLLECTIONS.purchaseItemsScrubbed).find(filter).toArray()) {
      if (!inRange(e.sessionStart)) continue;
      rows.push({
        personKey: e.customerId ? `cus:${e.customerId}` : `pit:${e._id}`,
        source: "partner",
        courseCode: e.courseCode,
        at: e.sessionStart ? new Date(`${e.sessionStart}T00:00:00+07:00`) : null,
        synthetic: e.synthetic === true,
      });
    }
  }
  return rows;
}

function groupKey(q: AnalyticsQuery, opts: { courseCode?: string; at?: Date | null; saleRep?: string | null }): { key: string; label: string } {
  switch (q.groupBy) {
    case "course":
      return { key: opts.courseCode ?? "UNKNOWN", label: label(opts.courseCode ?? "UNKNOWN") };
    case "saleRep":
      return { key: opts.saleRep ?? "ไม่ระบุ", label: opts.saleRep ?? "ไม่ระบุ" };
    case "month":
    case "week":
    case "day": {
      const k = opts.at ? bangkokKey(opts.at, q.groupBy) : "ไม่ทราบวันที่";
      return { key: k, label: k };
    }
    default:
      return { key: "รวม", label: "รวม" };
  }
}

function tally(entries: { key: string; label: string; value: number }[]): AnalyticsRow[] {
  const m = new Map<string, AnalyticsRow>();
  for (const e of entries) {
    const cur = m.get(e.key);
    if (cur) cur.value += e.value;
    else m.set(e.key, { key: e.key, label: e.label, value: e.value });
  }
  return [...m.values()].sort((a, b) => b.value - a.value);
}

export interface RunOptions {
  /** ใช้ภายในตอนคำนวณ delta — กันเรียกตัวเองซ้ำไม่รู้จบ */
  skipDelta?: boolean;
}

export async function runAnalytics(db: Db, q: AnalyticsQuery, opts: RunOptions = {}): Promise<AnalyticsResult> {
  const { start, end } = bangkokRange(q.from, q.to);
  const warnings: string[] = [];
  let containsSynthetic = false;
  let isEstimate = false;
  let rowsScanned = 0;
  let rows: AnalyticsRow[] = [];

  const note = (list: { synthetic: boolean }[]) => {
    if (list.some((x) => x.synthetic)) containsSynthetic = true;
  };

  if (q.metric === "revenue") {
    const payments = await loadPayments(db, q, start, end);
    rowsScanned = payments.length;
    note(payments);
    rows = tally(
      payments.map((p) => ({ ...groupKey(q, { at: p.paidAt, saleRep: p.saleRep }), value: p.amount ?? 0 }))
    );
    if (q.groupBy === "course") {
      warnings.push("จัดกลุ่มยอดเงินตามคอร์สไม่ได้ — หนึ่งการชำระมีได้หลายคอร์ส ใช้ metric seats แทนถ้าอยากดูรายคอร์ส");
      rows = tally(payments.map((p) => ({ key: "รวม", label: "รวม", value: p.amount ?? 0 })));
    }
    if (payments.some((p) => p.amount === null)) warnings.push("มีการชำระที่ไม่มียอดเงินบันทึกไว้ ไม่ถูกนับ");
  } else if (q.metric === "seats") {
    const seats = await loadSeats(db, q, start, end);
    rowsScanned = seats.length;
    note(seats);
    rows = tally(seats.map((s) => ({ ...groupKey(q, { courseCode: s.courseCode, at: s.at }), value: 1 })));
  } else if (q.metric === "people") {
    const seats = await loadSeats(db, q, start, end);
    const payments = await loadPayments(db, q, start, end);
    rowsScanned = seats.length + payments.length;
    note([...seats, ...payments]);
    const seen = new Map<string, Set<string>>();
    for (const s of seats) {
      const g = groupKey(q, { courseCode: s.courseCode, at: s.at });
      if (!seen.has(g.key)) seen.set(g.key, new Set());
      seen.get(g.key)!.add(s.personKey);
    }
    if (!q.groupBy) {
      const all = new Set([...seats.map((s) => s.personKey), ...payments.map((p) => p.personKey)]);
      rows = [{ key: "รวม", label: "รวม", value: all.size }];
    } else {
      rows = [...seen.entries()]
        .map(([key, set]) => ({ key, label: q.groupBy === "course" ? label(key) : key, value: set.size }))
        .sort((a, b) => b.value - a.value);
    }
  } else if (q.metric === "new_vs_returning") {
    const inRange = await loadPayments(db, q, start, end);
    // ประวัติทั้งหมดก่อนหน้า — ตัดสินที่ "เคยซื้อก่อนหน้าไหม" ไม่ใช่ "มี link ไหม" (§5.4)
    const historyQuery: AnalyticsQuery = { ...q, from: "1970-01-01", to: q.from };
    const history = await loadPayments(db, historyQuery, new Date(0), new Date(start.getTime() - 1));
    rowsScanned = inRange.length + history.length;
    note([...inRange, ...history]);
    const boughtBefore = new Set(history.filter((h) => h.paidAt && h.paidAt < start).map((h) => h.personKey));
    const firstSeen = new Map<string, boolean>();
    for (const p of inRange) {
      if (firstSeen.has(p.personKey)) continue;
      firstSeen.set(p.personKey, boughtBefore.has(p.personKey));
    }
    const returning = [...firstSeen.values()].filter(Boolean).length;
    rows = [
      { key: "new", label: "ลูกค้าใหม่", value: firstSeen.size - returning },
      { key: "returning", label: "เคยซื้อมาก่อน", value: returning },
    ];
  } else if (q.metric === "channel_mix") {
    const field = q.groupBy === "adOrOrganic" ? "adOrOrganic" : "heardFrom";
    const customers = await db.collection(AI_COLLECTIONS.customersScrubbed).find({ status: "active" }).toArray();
    rowsScanned = customers.length;
    const entries = customers.map((c) => {
      if (field === "heardFrom") {
        const v = (c.heardFrom as string | null) ?? "ไม่ระบุ";
        return { key: v, label: v, value: 1 };
      }
      const a = c.leadAttribution as { adOrOrganic?: string; attributionPending?: boolean } | null | undefined;
      if (!a) return { key: "ไม่ได้มาจากโฆษณา", label: "ไม่ได้มาจากโฆษณา", value: 1 };
      // "ยังไม่รู้" ต่างจาก "รู้แล้วว่าไม่ทราบ" — ห้ามยุบรวมกัน (§5.5)
      if (a.attributionPending) return { key: "ยังไม่รู้ (รอเติม mapping)", label: "ยังไม่รู้ (รอเติม mapping)", value: 1 };
      return { key: a.adOrOrganic ?? "unknown", label: a.adOrOrganic ?? "unknown", value: 1 };
    });
    rows = tally(entries);
    if (customers.some((c) => (c.leadAttribution as { attributionPending?: boolean } | null)?.attributionPending)) {
      warnings.push("มีลูกค้าที่ยังไม่รู้ว่ามาจากแคมเปญไหน — เติม lead_form_mappings แล้วรันใหม่");
    }
  } else if (q.metric === "intent_funnel") {
    isEstimate = true;
    const filter: Record<string, unknown> = {
      supersededAt: null,
      voidedAt: null,
      belowThreshold: { $ne: true },
      confidence: { $gte: q.minConfidence },
    };
    if (q.courseCodes?.length) filter.courseCode = { $in: q.courseCodes };
    if (q.hesitationReason) filter.hesitationReason = q.hesitationReason;
    const intents = await db.collection(AI_COLLECTIONS.customerIntentsScrubbed).find(filter).toArray();
    rowsScanned = intents.length;
    rows = tally(intents.map((i) => {
      const k = (i.status as string) + (i.hesitationReason ? `/${i.hesitationReason}` : "");
      return { key: k, label: k, value: 1 };
    }));
    const models = [...new Set(intents.map((i) => i.model).filter(Boolean))];
    warnings.push(
      `ตัวเลขนี้เป็นค่าประเมินจาก AI ไม่ใช่ข้อเท็จจริง (เกณฑ์ confidence ≥ ${q.minConfidence}${models.length ? ` · โมเดล: ${models.join(", ")}` : ""})`
    );
  }

  if (containsSynthetic) warnings.push("⚠️ ผลนี้มีข้อมูลจำลองปนอยู่ ห้ามนำไปใช้ตัดสินใจทางธุรกิจ");
  if (!q.includeSynthetic) warnings.push("ไม่รวมข้อมูลจำลอง (includeSynthetic: false)");

  // delta เทียบช่วงก่อนหน้าเฉพาะ metric ที่เทียบได้
  let previous: Map<string, number> | undefined;
  if (!opts.skipDelta && q.groupBy && ["revenue", "seats"].includes(q.metric)) {
    const prev = previousRange(q.from, q.to);
    const prevQ: AnalyticsQuery = {
      ...q,
      from: prev.start.toISOString().slice(0, 10),
      to: prev.end.toISOString().slice(0, 10),
    };
    const prevResult = await runAnalytics(db, { ...prevQ, groupBy: q.groupBy }, { skipDelta: true });
    previous = new Map(prevResult.rows.map((r) => [r.key, r.value]));
  }

  const withShare = withDerived(rows, previous);
  return {
    metric: q.metric,
    rows: withShare,
    total: withShare.reduce((s, r) => s + r.value, 0),
    meta: {
      from: q.from,
      to: q.to,
      timezone: "Asia/Bangkok",
      sourcesUsed: q.sources,
      containsSynthetic,
      isEstimate,
      rowsScanned,
      warnings,
      generatedAt: new Date().toISOString(),
    },
  };
}
