import { z } from "zod";
import type { LlmProvider } from "../ai/llm/provider";
import { COURSES } from "../legacy/courses";
import { analyticsQuerySchema, GROUP_BY, METRICS, type AnalyticsQuery, type AnalyticsResult } from "./query";
import { verifyAnswerNumbers } from "./verify";

/**
 * ชั้น LLM — ทำได้แค่ 2 อย่าง (D36)
 *   1. แปลงคำถามภาษาไทย → พารามิเตอร์
 *   2. เขียนสรุปจากตัวเลขที่คำนวณเสร็จแล้ว
 *
 * ห้ามส่งข้อมูลลูกค้ารายคนออกไปเด็ดขาด — ส่งได้แค่คำถาม วันที่ รายการคอร์ส และผลรวม
 */

export const PROMPT_VERSION = "m4-2026-08-28";

const parseSchema = z.object({
  understood: z.boolean(),
  clarify: z.string().max(300).nullable(),
  query: z
    .object({
      metric: z.enum(METRICS),
      from: z.string(),
      to: z.string(),
      courseCodes: z.array(z.string()).nullable().optional(),
      groupBy: z.enum(GROUP_BY).nullable().optional(),
    })
    .nullable(),
});

export type ParseOutcome =
  | { ok: true; query: AnalyticsQuery }
  | { ok: false; clarify: string };

const COURSE_LIST = COURSES.map((c) => `${c.code}=${c.nameTh}`).join(" · ");

export async function parseQuestion(
  provider: LlmProvider,
  question: string,
  today: string
): Promise<ParseOutcome> {
  const system = [
    "แปลงคำถามภาษาไทยเกี่ยวกับยอดขายคอร์สให้เป็น JSON พารามิเตอร์",
    `วันนี้คือ ${today} (เขตเวลา Asia/Bangkok)`,
    `คอร์สที่มี: ${COURSE_LIST}`,
    `metric ที่ใช้ได้: ${METRICS.join(", ")}`,
    `groupBy ที่ใช้ได้: ${GROUP_BY.join(", ")}`,
    "ตอบ JSON เท่านั้น: {understood, clarify, query}",
    "ถ้าคำถามไม่ระบุช่วงเวลา ห้ามเดา ให้ understood=false แล้วถามกลับใน clarify",
    "ห้ามคำนวณตัวเลขใด ๆ หน้าที่ของคุณคือแปลงคำถามอย่างเดียว",
  ].join("\n");

  let parsed: z.infer<typeof parseSchema> | null = null;
  try {
    parsed = await provider.complete({ system, user: question, schema: parseSchema, maxTokens: 400 });
  } catch {
    return { ok: false, clarify: "ตอนนี้แปลงคำถามไม่สำเร็จ ลองพิมพ์ใหม่โดยระบุช่วงเวลาให้ชัด เช่น \"เดือนสิงหาคม 2026\"" };
  }

  if (!parsed.understood || !parsed.query) {
    return { ok: false, clarify: parsed.clarify ?? "ช่วยระบุช่วงเวลาที่ต้องการดูด้วยครับ" };
  }

  const candidate = {
    ...parsed.query,
    courseCodes: parsed.query.courseCodes ?? undefined,
    groupBy: parsed.query.groupBy ?? undefined,
  };
  const validated = analyticsQuerySchema.safeParse(candidate);
  if (!validated.success) {
    return { ok: false, clarify: `พารามิเตอร์ที่แปลงได้ไม่ถูกต้อง (${validated.error.issues[0]?.message ?? "ไม่ทราบสาเหตุ"}) ช่วยถามใหม่ให้ชัดขึ้นครับ` };
  }
  return { ok: true, query: validated.data };
}

export interface RenderOutcome {
  answer: string;
  verified: boolean;
  invented: string[];
}

export async function renderAnswer(
  provider: LlmProvider,
  query: AnalyticsQuery,
  result: AnalyticsResult
): Promise<RenderOutcome> {
  const system = [
    "เขียนสรุปสั้น ๆ เป็นภาษาไทยจากตัวเลขที่ให้มา",
    "⭐ ห้ามคำนวณตัวเลขใหม่เด็ดขาด ใช้เฉพาะตัวเลขที่ปรากฏใน JSON นี้เท่านั้น",
    "ถ้าจะพูดถึงสัดส่วนให้ใช้ค่า share ที่ให้มา (คูณ 100 ได้) ห้ามคิดเปอร์เซ็นต์เอง",
    result.meta.containsSynthetic ? "ต้องเตือนว่าข้อมูลนี้มีข้อมูลจำลองปน ห้ามใช้ตัดสินใจจริง" : "",
    result.meta.isEstimate ? "ต้องบอกว่านี่เป็นค่าประเมินจาก AI ไม่ใช่ข้อเท็จจริง" : "",
    "ไม่เกิน 4 ประโยค",
  ].filter(Boolean).join("\n");

  let text: string;
  try {
    const out = await provider.complete({
      system,
      user: JSON.stringify({ query, result }),
      schema: z.object({ answer: z.string().max(1200) }),
      maxTokens: 500,
    });
    text = out.answer;
  } catch {
    return { answer: "", verified: false, invented: [] };
  }

  const check = verifyAnswerNumbers(text, result);
  return { answer: text, verified: check.ok, invented: check.invented };
}
