import { describe, it, expect } from "vitest";
import { analyticsQuerySchema, bangkokRange, previousRange, bangkokKey, withDerived } from "../src/analytics/query";
import { verifyAnswerNumbers } from "../src/analytics/verify";
import { parseQuestion, renderAnswer } from "../src/analytics/ask";
import type { AnalyticsResult } from "../src/analytics/query";
import type { LlmProvider } from "../src/ai/llm/provider";
import type { ZodType } from "zod";

const result = (over: Partial<AnalyticsResult> = {}): AnalyticsResult => ({
  metric: "revenue",
  rows: [
    { key: "INNER", label: "Inner Makeover", value: 19710, share: 0.6, delta: 1000 },
    { key: "COMMU", label: "Communication", value: 13140, share: 0.4, delta: -500 },
  ],
  total: 32850,
  meta: {
    from: "2026-08-01", to: "2026-08-31", timezone: "Asia/Bangkok",
    sourcesUsed: ["legacy", "partner"], containsSynthetic: false, isEstimate: false,
    rowsScanned: 2, warnings: [], generatedAt: "2026-08-28T00:00:00.000Z",
  },
  ...over,
});

describe("bangkokRange — ขอบเขตเวลาไทย (D38)", () => {
  it("⭐ ต้นเดือนไทยเริ่มก่อนเที่ยงคืน UTC 7 ชั่วโมง", () => {
    expect(bangkokRange("2026-08-01", "2026-08-31").start.toISOString()).toBe("2026-07-31T17:00:00.000Z");
  });
  it("วันสุดท้ายรวมทั้งวัน", () => {
    expect(bangkokRange("2026-08-01", "2026-08-31").end.toISOString()).toBe("2026-08-31T16:59:59.999Z");
  });
  it("⭐ การซื้อ 1 ส.ค. 00:30 เวลาไทย ต้องอยู่ในเดือน ส.ค. ไม่ใช่ ก.ค.", () => {
    const purchase = new Date("2026-07-31T17:30:00.000Z"); // = 2026-08-01 00:30 +07:00
    const aug = bangkokRange("2026-08-01", "2026-08-31");
    expect(purchase >= aug.start && purchase <= aug.end).toBe(true);
    expect(bangkokKey(purchase, "month")).toBe("2026-08");
  });
  it("ช่วงก่อนหน้ายาวเท่ากันและไม่ทับกัน", () => {
    const cur = bangkokRange("2026-08-01", "2026-08-31");
    const prev = previousRange("2026-08-01", "2026-08-31");
    expect(prev.end.getTime()).toBe(cur.start.getTime() - 1);
    expect(prev.end.getTime() - prev.start.getTime()).toBe(cur.end.getTime() - cur.start.getTime());
  });
  it("bangkokKey แบ่งสัปดาห์เริ่มวันจันทร์", () => {
    expect(bangkokKey(new Date("2026-08-27T05:00:00Z"), "week")).toBe(bangkokKey(new Date("2026-08-25T05:00:00Z"), "week"));
  });
});

describe("analyticsQuerySchema", () => {
  const base = { metric: "revenue", from: "2026-08-01", to: "2026-08-31" };
  it("ค่าเริ่มต้นไม่รวมข้อมูลจำลอง (D37)", () => {
    expect(analyticsQuerySchema.parse(base).includeSynthetic).toBe(false);
  });
  it("from > to ไม่ผ่าน", () => {
    expect(analyticsQuerySchema.safeParse({ ...base, from: "2026-09-01" }).success).toBe(false);
  });
  it("metric / groupBy ที่ไม่รู้จักไม่ผ่าน", () => {
    expect(analyticsQuerySchema.safeParse({ ...base, metric: "profit" }).success).toBe(false);
    expect(analyticsQuerySchema.safeParse({ ...base, groupBy: "หมวด" }).success).toBe(false);
  });
  it("confidence นอกช่วง 0–1 ไม่ผ่าน", () => {
    expect(analyticsQuerySchema.safeParse({ ...base, minConfidence: 1.5 }).success).toBe(false);
  });
});

describe("withDerived", () => {
  it("คำนวณ share ให้ทุกแถว รวมกันได้ 1", () => {
    const rows = withDerived([
      { key: "a", label: "a", value: 30 },
      { key: "b", label: "b", value: 70 },
    ]);
    expect(rows.map((r) => r.share)).toEqual([0.3, 0.7]);
  });
  it("ผลรวมเป็น 0 ไม่หารด้วยศูนย์", () => {
    expect(withDerived([{ key: "a", label: "a", value: 0 }])[0]!.share).toBe(0);
  });
});

describe("⭐ verifyAnswerNumbers — ตัวกันโกหก (§6.3)", () => {
  it("จับได้เมื่อ LLM แต่งเปอร์เซ็นต์ที่ไม่มีในข้อมูล", () => {
    const v = verifyAnswerNumbers("เดือนนี้ยอด 32,850 บาท เติบโต 23% จากเดือนก่อน", result());
    expect(v.ok).toBe(false);
    expect(v.invented).toContain("23");
  });
  it("ผ่านเมื่อใช้เฉพาะตัวเลขที่มีจริง", () => {
    const v = verifyAnswerNumbers("ยอดรวม 32,850 บาท · Inner 19,710 · Communication 13,140", result());
    expect(v.ok).toBe(true);
  });
  it("ยอมรับ share ที่เขียนเป็นเปอร์เซ็นต์ (0.6 → 60%)", () => {
    expect(verifyAnswerNumbers("Inner คิดเป็น 60% ของยอดทั้งหมด", result()).ok).toBe(true);
  });
  it("ยอมรับตัวเลขที่มีคอมมาและที่ไม่มี", () => {
    expect(verifyAnswerNumbers("ยอด 32850 บาท", result()).ok).toBe(true);
    expect(verifyAnswerNumbers("ยอด 32,850 บาท", result()).ok).toBe(true);
  });
  it("ยอมรับปีและวันที่ในช่วงที่ถาม ไม่นับเป็นตัวเลขแต่ง", () => {
    expect(verifyAnswerNumbers("ช่วง 2026-08-01 ถึง 2026-08-31 ยอด 32,850", result()).ok).toBe(true);
  });
  it("⭐ จับได้เมื่อ LLM แต่งยอดขายเกินจริง", () => {
    const v = verifyAnswerNumbers("ยอดรวม 99,999 บาท", result());
    expect(v.ok).toBe(false);
    expect(v.invented).toContain("99,999");
  });
  it("delta ติดลบถูกนับว่ามีอยู่จริง", () => {
    expect(verifyAnswerNumbers("Communication ลดลง 500", result()).ok).toBe(true);
  });
});

function fakeLlm(reply: unknown): LlmProvider {
  return {
    name: "fake",
    async complete<T>(input: { schema: ZodType<T> }): Promise<T> {
      return input.schema.parse(reply);
    },
  };
}
function brokenLlm(): LlmProvider {
  return { name: "broken", complete: async () => { throw new Error("timeout"); } };
}

describe("parseQuestion", () => {
  it("แปลงคำถามที่ระบุช่วงเวลาชัดเจนได้", async () => {
    const p = fakeLlm({ understood: true, clarify: null, query: { metric: "revenue", from: "2026-08-01", to: "2026-08-31", groupBy: "month" } });
    const r = await parseQuestion(p, "เดือนสิงหาคมขายได้เท่าไร", "2026-08-28");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.query.metric).toBe("revenue");
  });
  it("⭐ คำถามที่ไม่ระบุช่วงเวลา ต้องถามกลับ ไม่ใช่เดา", async () => {
    const p = fakeLlm({ understood: false, clarify: "อยากดูช่วงไหนครับ", query: null });
    const r = await parseQuestion(p, "ขายดีไหม", "2026-08-28");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.clarify).toContain("ช่วงไหน");
  });
  it("พารามิเตอร์ที่ LLM ให้มาไม่ผ่าน schema → ถามกลับ ไม่ throw", async () => {
    const p = fakeLlm({ understood: true, clarify: null, query: { metric: "revenue", from: "2026-09-30", to: "2026-08-01" } });
    const r = await parseQuestion(p, "x", "2026-08-28");
    expect(r.ok).toBe(false);
  });
  it("LLM ล่ม → ถามกลับ ไม่ throw", async () => {
    const r = await parseQuestion(brokenLlm(), "x", "2026-08-28");
    expect(r.ok).toBe(false);
  });
});

describe("renderAnswer", () => {
  it("คำตอบที่ใช้ตัวเลขจริง ผ่านการตรวจ", async () => {
    const p = fakeLlm({ answer: "ยอดรวม 32,850 บาท จาก Inner 19,710 และ Communication 13,140" });
    const r = await renderAnswer(p, analyticsQuerySchema.parse({ metric: "revenue", from: "2026-08-01", to: "2026-08-31" }), result());
    expect(r.verified).toBe(true);
  });
  it("⭐ คำตอบที่แต่งตัวเลข ต้องไม่ผ่านการตรวจ", async () => {
    const p = fakeLlm({ answer: "ยอดรวม 32,850 บาท เติบโตขึ้น 45% เมื่อเทียบกับปีก่อน" });
    const r = await renderAnswer(p, analyticsQuerySchema.parse({ metric: "revenue", from: "2026-08-01", to: "2026-08-31" }), result());
    expect(r.verified).toBe(false);
    expect(r.invented).toContain("45");
  });
  it("LLM ล่ม → คืนคำตอบว่าง ไม่ throw", async () => {
    const r = await renderAnswer(brokenLlm(), analyticsQuerySchema.parse({ metric: "revenue", from: "2026-08-01", to: "2026-08-31" }), result());
    expect(r.answer).toBe("");
    expect(r.verified).toBe(false);
  });
});
