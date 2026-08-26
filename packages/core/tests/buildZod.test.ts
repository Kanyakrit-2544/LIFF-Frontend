import { describe, it, expect } from "vitest";
import { buildZodFromSchema, normalizeAnswers } from "../src/forms/buildZod";
import type { FormSchemaDoc } from "../src/forms/types";

const schema = (fields: FormSchemaDoc["sections"][0]["fields"]): FormSchemaDoc => ({
  _id: "t@v1", formId: "t", version: "v1", status: "published",
  title: { th: "ทดสอบ" }, sections: [{ id: "s", title: { th: "s" }, fields }],
  createdAt: new Date(), publishedAt: new Date(),
});

describe("buildZodFromSchema", () => {
  it("บังคับกรอก field ที่ required", () => {
    const z = buildZodFromSchema(schema([{ id: "name", type: "text", label: { th: "ชื่อ" }, validate: { required: true } }]));
    expect(z.safeParse({ name: "สมชาย" }).success).toBe(true);
    expect(z.safeParse({ name: "" }).success).toBe(false);
    expect(z.safeParse({ name: "   " }).success).toBe(false);
    expect(z.safeParse({}).success).toBe(false);
  });

  it("field ที่ไม่ required ว่างได้", () => {
    const z = buildZodFromSchema(schema([{ id: "nick", type: "text", label: { th: "ชื่อเล่น" } }]));
    expect(z.safeParse({}).success).toBe(true);
    expect(z.safeParse({ nick: "" }).success).toBe(true);
  });

  it("⭐ field แปลกปลอมถูกปฏิเสธ (กัน mass assignment)", () => {
    const z = buildZodFromSchema(schema([{ id: "name", type: "text", label: { th: "ชื่อ" } }]));
    for (const evil of [{ name: "x", customerStatus: "vip" }, { name: "x", isAdmin: true }, { name: "x", _id: "cus_อื่น" }]) {
      const r = z.safeParse(evil);
      expect(r.success, JSON.stringify(evil)).toBe(false);
    }
  });

  it("ตรวจเบอร์โทรตามกฎ normalize จริง", () => {
    const z = buildZodFromSchema(schema([{ id: "phone", type: "tel", label: { th: "เบอร์" }, validate: { required: true } }]));
    for (const good of ["0812345678", "081-234-5678", "+66812345678"]) expect(z.safeParse({ phone: good }).success, good).toBe(true);
    for (const bad of ["123", "abc", "08123456789012"]) expect(z.safeParse({ phone: bad }).success, bad).toBe(false);
  });

  it("ตรวจอีเมล", () => {
    const z = buildZodFromSchema(schema([{ id: "email", type: "email", label: { th: "อีเมล" } }]));
    expect(z.safeParse({ email: "a@b.com" }).success).toBe(true);
    expect(z.safeParse({ email: "a@b" }).success).toBe(false);
  });

  it("select รับเฉพาะค่าที่อยู่ในตัวเลือก", () => {
    const z = buildZodFromSchema(schema([{
      id: "y", type: "select", label: { th: "ปี" },
      options: [{ value: "2535", label: { th: "2535" } }, { value: "2536", label: { th: "2536" } }],
    }]));
    expect(z.safeParse({ y: "2535" }).success).toBe(true);
    expect(z.safeParse({ y: "9999" }).success).toBe(false);
  });

  it("checkbox ตรวจจำนวนขั้นต่ำและค่าที่อนุญาต", () => {
    const z = buildZodFromSchema(schema([{
      id: "c", type: "checkbox", label: { th: "สนใจ" }, validate: { minItems: 1 },
      options: [{ value: "a", label: { th: "a" } }, { value: "b", label: { th: "b" } }],
    }]));
    expect(z.safeParse({ c: ["a"] }).success).toBe(true);
    expect(z.safeParse({ c: [] }).success).toBe(false);
    expect(z.safeParse({ c: ["z"] }).success).toBe(false);
  });

  it("consent ที่ required ต้องเป็น true เท่านั้น — ติ๊กไม่ครบส่งไม่ได้", () => {
    const z = buildZodFromSchema(schema([{ id: "ok", type: "consent", label: { th: "ยินยอม" }, validate: { required: true } }]));
    expect(z.safeParse({ ok: true }).success).toBe(true);
    expect(z.safeParse({ ok: false }).success).toBe(false);
    expect(z.safeParse({}).success).toBe(false);
  });

  it("readonly / image ไม่รับค่าจาก client", () => {
    const z = buildZodFromSchema(schema([{ id: "pic", type: "image", label: { th: "รูป" } }]));
    expect(z.safeParse({}).success).toBe(true);
    expect(z.safeParse({ pic: "https://evil/x.jpg" }).success).toBe(false);
  });

  it("maxLength / pattern ทำงาน", () => {
    const z = buildZodFromSchema(schema([{ id: "en", type: "text", label: { th: "อังกฤษ" }, validate: { maxLength: 5, pattern: "^[A-Za-z]*$" } }]));
    expect(z.safeParse({ en: "Somch" }).success).toBe(true);
    expect(z.safeParse({ en: "Somchai" }).success).toBe(false);
    expect(z.safeParse({ en: "สมชาย" }).success).toBe(false);
  });

  it("visibleIf: ถ้าไม่แสดง ก็ไม่บังคับกรอก", () => {
    const fields = schema([
      { id: "type", type: "select", label: { th: "ประเภท" }, options: [{ value: "a", label: { th: "a" } }, { value: "b", label: { th: "b" } }] },
      { id: "detail", type: "text", label: { th: "รายละเอียด" }, validate: { required: true }, visibleIf: { field: "type", op: "eq", value: "a" } },
    ]);
    expect(buildZodFromSchema(fields, { answers: { type: "b" } }).safeParse({ type: "b" }).success).toBe(true);
    expect(buildZodFromSchema(fields, { answers: { type: "a" } }).safeParse({ type: "a" }).success).toBe(false);
    expect(buildZodFromSchema(fields, { answers: { type: "a" } }).safeParse({ type: "a", detail: "x" }).success).toBe(true);
  });

  it("ข้อความ error เป็นภาษาไทยและบอกชื่อ field", () => {
    const z = buildZodFromSchema(schema([{ id: "phone", type: "tel", label: { th: "เบอร์โทรศัพท์" }, validate: { required: true } }]));
    const r = z.safeParse({ phone: "abc" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0]!.message).toContain("เบอร์โทรศัพท์");
  });
});

describe("normalizeAnswers", () => {
  it("แปลงเบอร์เป็น E.164 และอีเมลเป็นตัวพิมพ์เล็ก", () => {
    const s = schema([
      { id: "phone", type: "tel", label: { th: "เบอร์" } },
      { id: "email", type: "email", label: { th: "อีเมล" } },
      { id: "birthYear", type: "select", label: { th: "ปีเกิด" } },
      { id: "nick", type: "text", label: { th: "ชื่อเล่น" } },
    ]);
    const out = normalizeAnswers(s, { phone: "081-234-5678", email: " A@B.COM ", birthYear: "2535", nick: "  ชาย  " });
    expect(out.phone).toBe("+66812345678");
    expect(out.email).toBe("a@b.com");
    expect(out.birthYear).toBe(2535);
    expect(out.nick).toBe("ชาย");
  });
  it("ข้ามค่าที่ว่างหรือไม่มี", () => {
    const s = schema([{ id: "nick", type: "text", label: { th: "ชื่อเล่น" } }]);
    expect(normalizeAnswers(s, { nick: "" })).toEqual({});
    expect(normalizeAnswers(s, {})).toEqual({});
  });
});
