import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { generateLegacy } from "../src/legacy/generate";
import { legacyProfileSchema } from "../src/legacy/profile";
import { courseByCode } from "../src/legacy/courses";
import { normalizePhone } from "../src/identity/normalize";

const profile = legacyProfileSchema.parse(
  JSON.parse(readFileSync(new URL("../src/legacy/profile.json", import.meta.url), "utf8"))
);
const gen = (seed = 1, scale = 1) =>
  generateLegacy({ profile, importRunId: "job_TEST", seed, scale, now: new Date("2026-08-28T00:00:00Z") });

const data = gen();
const profileRows = profile.sheets.reduce((n, s) => n + s.rows, 0);

describe("profile.json", () => {
  it("ผ่าน schema และมีชีต 2025–2026", () => {
    expect(profile.sheets.map((s) => s.sheet)).toEqual(["Inner2025", "Inner2026"]);
  });

  it("⭐ ห้ามมี PII หลุดเข้าไฟล์ที่ commit — ป้ายรอบเรียนที่มีชื่อคนต้องถูกแทนแล้ว", () => {
    const raw = readFileSync(new URL("../src/legacy/profile.json", import.meta.url), "utf8");
    expect(raw).not.toMatch(/เรียนแทน/);
    expect(raw).not.toMatch(/คุณ[ก-๙]/);
    expect(raw).not.toMatch(/@/); // ไม่มีอีเมล
    expect(raw).not.toMatch(/0[689]\d{8}/); // ไม่มีเบอร์
  });
});

describe("generateLegacy — ความถูกต้องของโครง", () => {
  it("จำนวนการชำระใกล้เคียงจำนวนแถวจริง", () => {
    expect(data.payments.length).toBeGreaterThanOrEqual(profileRows - 10);
    expect(data.payments.length).toBeLessThanOrEqual(profileRows + 10);
  });

  it("หัวคอลัมน์คอร์สแปลได้ครบ ไม่มีตัวที่พจนานุกรมไม่รู้จัก", () => {
    expect(data.unknownCourseHeaders).toEqual([]);
  });

  it("⭐ ยอดเงินอยู่ที่ payments เท่านั้น — totalPaid ของคนต้องตรงกับผลรวม payments ของคนนั้น", () => {
    const sum = new Map<string, number>();
    for (const p of data.payments) sum.set(p.personId, (sum.get(p.personId) ?? 0) + (p.amount ?? 0));
    for (const person of data.persons) {
      expect(Math.round(person.totalPaid), person._id).toBe(Math.round(sum.get(person._id) ?? 0));
    }
  });

  it("⭐ enrollment ทุกตัวชี้ payment ที่มีอยู่จริงและเป็นของคนเดียวกัน", () => {
    const byId = new Map(data.payments.map((p) => [p._id, p]));
    for (const e of data.enrollments) {
      const pay = byId.get(e.paymentId);
      expect(pay, e._id).toBeDefined();
      expect(pay!.personId).toBe(e.personId);
    }
  });

  it("countsAsSeat เป็น true ได้เฉพาะ kind = enrolled", () => {
    for (const e of data.enrollments) {
      if (e.countsAsSeat) expect(e.kind, e.raw).toBe("enrolled");
    }
  });

  it("รหัสคอร์สทุกตัวอยู่ในพจนานุกรม", () => {
    for (const e of data.enrollments) expect(courseByCode(e.courseCode), e.courseCode).not.toBeNull();
  });

  it("เบอร์ที่ปั้นถูกรูปแบบและไม่ซ้ำกัน", () => {
    const phones = data.persons.map((p) => p.phone).filter((p): p is string => p !== null);
    expect(new Set(phones).size).toBe(phones.length);
    for (const p of phones) expect(normalizePhone(p)).toBe(p);
  });

  it("ทุก doc ติดธง synthetic — กันคนหยิบตัวเลขไปใช้จริง", () => {
    expect(data.persons.every((p) => p.synthetic)).toBe(true);
    expect(data.payments.every((p) => p.synthetic)).toBe(true);
    expect(data.enrollments.every((e) => e.synthetic)).toBe(true);
  });
});

describe("generateLegacy — เหมือนของจริงพอที่จะทดสอบได้", () => {
  it("สัดส่วนที่นั่งที่ขายได้ใกล้ของจริง (~82%) ไม่ใช่ 100%", () => {
    const seats = data.enrollments.filter((e) => e.countsAsSeat).length;
    const ratio = seats / data.enrollments.length;
    expect(ratio).toBeGreaterThan(0.7);
    expect(ratio).toBeLessThan(0.92);
  });

  it("มีลูกค้าซื้อซ้ำ — ไม่ใช่ทุกคนจ่ายครั้งเดียว", () => {
    const repeat = data.persons.filter((p) => p.paymentCount > 1).length;
    expect(repeat / data.persons.length).toBeGreaterThan(0.1);
  });

  it("⭐ มีเคสสลิปเดียวจ่ายหลายคน — ถ้าไม่มี analytics จะไม่เคยเจอปัญหายอดซ้อน", () => {
    expect(data.payments.filter((p) => p.slipShared).length).toBeGreaterThan(0);
  });

  it("seed เดิมได้ข้อมูลชุดเดิม (ไม่นับ id ที่อิงเวลา)", () => {
    const a = gen(7, 0.1);
    const b = gen(7, 0.1);
    const shape = (d: ReturnType<typeof gen>) =>
      d.payments.map((p) => `${p.slipNo}|${p.amount}|${p.paidAt?.toISOString()}|${p.saleRep}`).join("\n");
    expect(shape(a)).toBe(shape(b));
  });

  it("scale ย่อขนาดได้จริง", () => {
    expect(gen(1, 0.1).payments.length).toBeLessThan(data.payments.length / 5);
  });
});
