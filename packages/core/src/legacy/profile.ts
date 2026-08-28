import { z } from "zod";

/**
 * รูปทรงสถิติที่ดึงจากชีตขายจริง (scripts/legacy/profile_xlsx.py)
 * ใช้ปั้นข้อมูล synthetic ให้หน้าตาเหมือนของจริงพอที่จะทดสอบทั้งเส้นทางได้
 *
 * ไฟล์ profile.json ถูก commit ลง repo — จึงต้องไม่มี PII แม้แต่ตัวเดียว
 * ป้ายรอบเรียนที่มีชื่อคนถูกแทนด้วย «ข้อความอื่น» ตั้งแต่ตอนดึง
 */

const quantiles = z.object({
  min: z.number(), p25: z.number(), median: z.number(), p75: z.number(), max: z.number(), mean: z.number(),
}).nullable();

const sheetProfile = z.object({
  sheet: z.string(),
  headerRow: z.number().int(),
  columns: z.record(z.number().int()),
  courseColumns: z.array(z.object({ index: z.number().int(), label: z.string() })),
  rows: z.number().int().positive(),
  fillRate: z.record(z.number()),
  age: quantiles,
  amount: quantiles,
  amountBuckets: z.record(z.number().int()),
  monthWeights: z.record(z.number().int()),
  coursesPerRow: z.record(z.number().int()),
  courseHits: z.record(z.number().int()),
  courseSessions: z.record(z.record(z.number().int())),
  saleReps: z.record(z.number().int()),
  repeatByPhone: z.record(z.number().int()),
  distinctPhones: z.number().int(),
  slipReuse: z.record(z.number().int()),
});

export const legacyProfileSchema = z.object({
  generatedAt: z.string(),
  source: z.string(),
  note: z.string().optional(),
  sheets: z.array(sheetProfile).min(1),
});

export type LegacyProfile = z.infer<typeof legacyProfileSchema>;
export type LegacySheetProfile = z.infer<typeof sheetProfile>;

/** ปีจากชื่อชีต "Inner2025" → 2025 */
export function sheetYear(sheet: string): number {
  const m = sheet.match(/(20\d{2})/);
  if (!m) throw new Error(`แกะปีจากชื่อชีตไม่ได้: ${sheet}`);
  return Number(m[1]);
}
