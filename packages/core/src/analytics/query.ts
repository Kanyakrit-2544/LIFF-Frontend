import { z } from "zod";

/**
 * พารามิเตอร์ของคำถาม — ทุกคำถามต้องผ่าน schema นี้ก่อนถูกนำไปรัน
 * ชั้น LLM แปลงภาษาไทยมาเป็นโครงนี้ แล้ว validate ที่นี่ (D36)
 */

export const METRICS = ["revenue", "seats", "people", "new_vs_returning", "channel_mix", "intent_funnel"] as const;
export const GROUP_BY = ["course", "month", "week", "day", "saleRep", "channel", "adOrOrganic"] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "ต้องเป็นรูปแบบ YYYY-MM-DD");

export const analyticsQuerySchema = z
  .object({
    metric: z.enum(METRICS),
    from: isoDate,
    to: isoDate,
    courseCodes: z.array(z.string()).optional(),
    groupBy: z.enum(GROUP_BY).optional(),
    sources: z.array(z.enum(["legacy", "partner"])).default(["legacy", "partner"]),
    /** D37: ข้อมูลปลอมต้องไม่โผล่โดยไม่ได้ขอ */
    includeSynthetic: z.boolean().default(false),
    minConfidence: z.number().min(0).max(1).default(0.6),
    hesitationReason: z.string().optional(),
  })
  .refine((q) => q.from <= q.to, { message: "from ต้องไม่มากกว่า to" });

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;

export interface AnalyticsRow {
  key: string;
  label: string;
  value: number;
  /** สัดส่วนต่อผลรวม 0–1 — คำนวณที่นี่ ห้ามให้ LLM คิดเอง (§6.3) */
  share?: number;
  /** เทียบช่วงก่อนหน้าที่ยาวเท่ากัน */
  delta?: number;
}

export interface AnalyticsResult {
  metric: string;
  rows: AnalyticsRow[];
  total: number;
  meta: {
    from: string;
    to: string;
    timezone: "Asia/Bangkok";
    sourcesUsed: string[];
    /** true = มีข้อมูลปลอมปนอยู่ ต้องกำกับป้ายในคำตอบ */
    containsSynthetic: boolean;
    /** true = มาจากค่าประเมินของ AI ไม่ใช่ข้อเท็จจริง (D39) */
    isEstimate: boolean;
    rowsScanned: number;
    warnings: string[];
    generatedAt: string;
  };
}

/**
 * ขอบเขตเวลาแบบไทย (D38)
 *
 * Mongo เก็บเป็น UTC แต่คนถามคิดเป็นเวลาไทย — "เดือนสิงหาคม" ของคนไทย
 * เริ่ม 2026-07-31T17:00Z ไม่ใช่ 2026-08-01T00:00Z ถ้าคำนวณผิด
 * การซื้อตอนเที่ยงคืนครึ่งวันที่ 1 จะตกไปอยู่เดือนก่อนหน้า
 *
 * ไทยเป็น +07:00 คงที่ ไม่มี DST จึงบวกลบตรง ๆ ได้ ไม่ต้องใช้ library
 */
const TZ_OFFSET_MS = 7 * 60 * 60 * 1000;

export function bangkokRange(from: string, to: string): { start: Date; end: Date } {
  const start = new Date(Date.parse(`${from}T00:00:00.000Z`) - TZ_OFFSET_MS);
  // to รวมวันสุดท้ายทั้งวัน
  const end = new Date(Date.parse(`${to}T23:59:59.999Z`) - TZ_OFFSET_MS);
  return { start, end };
}

/** ช่วงก่อนหน้าที่ยาวเท่ากัน — ใช้คำนวณ delta */
export function previousRange(from: string, to: string): { start: Date; end: Date } {
  const cur = bangkokRange(from, to);
  const span = cur.end.getTime() - cur.start.getTime() + 1;
  return { start: new Date(cur.start.getTime() - span), end: new Date(cur.start.getTime() - 1) };
}

/** แปลงเวลา UTC → คีย์ตามเวลาไทย เช่น "2026-08" หรือ "2026-08-28" */
export function bangkokKey(d: Date, unit: "day" | "week" | "month"): string {
  const local = new Date(d.getTime() + TZ_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = String(local.getUTCMonth() + 1).padStart(2, "0");
  if (unit === "month") return `${y}-${m}`;
  if (unit === "day") return `${y}-${m}-${String(local.getUTCDate()).padStart(2, "0")}`;
  // สัปดาห์เริ่มวันจันทร์
  const monday = new Date(local);
  monday.setUTCDate(local.getUTCDate() - ((local.getUTCDay() + 6) % 7));
  return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, "0")}-${String(monday.getUTCDate()).padStart(2, "0")}`;
}

/** เติม share/delta ให้ทุกแถว — LLM ต้องไม่คำนวณเปอร์เซ็นต์เอง */
export function withDerived(rows: AnalyticsRow[], previous?: Map<string, number>): AnalyticsRow[] {
  const total = rows.reduce((s, r) => s + r.value, 0);
  return rows.map((r) => ({
    ...r,
    share: total > 0 ? Math.round((r.value / total) * 10000) / 10000 : 0,
    ...(previous ? { delta: r.value - (previous.get(r.key) ?? 0) } : {}),
  }));
}
