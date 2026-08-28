import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { legacyProfileSchema } from "../src/legacy/profile";
import { generateLegacy } from "../src/legacy/generate";
import { safeSessionLabel, scrubLegacyEnrollment, scrubLegacyPayment, scrubLegacyPerson } from "../src/ai/scrubLegacy";

const profile = legacyProfileSchema.parse(JSON.parse(readFileSync(new URL("../src/legacy/profile.json", import.meta.url), "utf8")));
const generated = generateLegacy({ profile, importRunId: "job_scrub_test", seed: 42, scale: 0.05, now: new Date("2026-08-28T00:00:00Z") });

describe("safeSessionLabel", () => {
  it("ซ่อนชื่อไทยที่ยังหลงเหลือในป้ายรอบเรียน", () => {
    expect(safeSessionLabel("13-14 Jun คุณสมชาย ใจดี เรียนแทน")).toBe("«ข้อความอื่น»");
  });

  it("คงป้ายที่เหลือเพียงศัพท์ธุรกิจหรือภาษาอังกฤษ", () => {
    expect(safeSessionLabel("ย้ายเรียน Camp")).toBe("ย้ายเรียน Camp");
    expect(safeSessionLabel("27-28 Jun")).toBe("27-28 Jun");
    expect(safeSessionLabel(null)).toBeNull();
  });
});

describe("scrubLegacy", () => {
  it("ส่งเฉพาะ field ที่กำหนดและไม่ส่ง PII ดิบ", () => {
    const person = generated.persons[0]!;
    const payments = generated.payments.filter((payment) => payment.personId === person._id);
    const scrubbed = scrubLegacyPerson(person, payments, new Date("2026-08-28T01:00:00Z"));
    const text = JSON.stringify(scrubbed);

    for (const key of ["raw", "socialHandle", "sourceRefs", "slipNo", "ageAtImport", "courseLabel"]) {
      expect(scrubbed).not.toHaveProperty(key);
    }
    expect(text).not.toContain(person.fullNameTh!);
    expect(text).not.toMatch(/0[689]\d{8}/);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(scrubbed.fullNameTh).toMatch(/^<PERSON_[0-9a-f]{8}>$/);
    expect(scrubbed.nameKeys.length).toBeGreaterThanOrEqual(2);
    expect(scrubbed.nameKeys.every((key) => /^[0-9a-f]{12}$/.test(key))).toBe(true);
    expect(scrubbed.phone).toMatch(/^0[689]x-xxx-\d{4}$/);
    expect(scrubbed.email === null || scrubbed.email.includes("***")).toBe(true);
    expect(scrubbed.phone).not.toMatch(/0[689]\d{8}/);
    expect(scrubbed.email).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(scrubbed.synthetic).toBe(true);
    expect(scrubbed.yearsActive).toEqual([...new Set(payments.map((payment) => payment.year))].sort((a, b) => a - b));
  });

  it("payment/enrollment scrub ไม่เปิดเผย slip, raw หรือ courseLabel", () => {
    const payment = generated.payments[0]!;
    const enrollment = generated.enrollments.find((item) => item.paymentId === payment._id);
    expect(enrollment).toBeDefined();
    const scrubbedPayment = scrubLegacyPayment(payment, new Date("2026-08-28T01:00:00Z"));
    const scrubbedEnrollment = scrubLegacyEnrollment(enrollment!, new Date("2026-08-28T01:00:00Z"));
    expect(JSON.stringify(scrubbedPayment)).not.toContain(payment.slipNo!);
    expect(Object.keys(scrubbedEnrollment)).not.toEqual(expect.arrayContaining(["raw", "courseLabel", "refSlip"]));
    expect(scrubbedPayment.synthetic).toBe(true);
    expect(scrubbedEnrollment.synthetic).toBe(true);
  });

  it("scrub ทั้งชุด scale 0.05 แล้วไม่มีชื่อ/เบอร์/อีเมลเดิม", () => {
    const scrubbed = [
      ...generated.persons.map((person) => scrubLegacyPerson(person, generated.payments.filter((payment) => payment.personId === person._id))),
      ...generated.payments.map((payment) => scrubLegacyPayment(payment)),
      ...generated.enrollments.map((enrollment) => scrubLegacyEnrollment(enrollment)),
    ];
    const text = scrubbed.map((doc) => {
      const visible = { ...(doc as unknown as Record<string, unknown>) };
      delete visible.phoneHash;
      delete visible.emailHash;
      return JSON.stringify(visible);
    }).join("\n");
    expect(text).not.toMatch(/0[689]\d{8}/);
    expect(text).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(text).not.toMatch(/\bIN-\d{4}-\d{5}\b/);
    expect(scrubbed.every((doc) => doc.synthetic)).toBe(true);
  });
});
