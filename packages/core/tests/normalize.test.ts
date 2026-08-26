import { describe, it, expect } from "vitest";
import {
  normalizePhone,
  normalizeEmail,
  normalizeName,
  normalizeBirthYearBE,
  ageFromBirthYearBE,
  toLocalPhone,
} from "../src/identity/normalize";

describe("normalizePhone", () => {
  it("รูปแบบเดียวกันทุกแบบต้องได้ค่าเดียวกัน", () => {
    const expected = "+66812345678";
    for (const input of [
      "0812345678",
      "081-234-5678",
      "081 234 5678",
      "+66812345678",
      "+66 81 234 5678",
      "66812345678",
      "812345678",
      "  0812345678  ",
      "(081) 234-5678",
    ]) {
      expect(normalizePhone(input), `input=${input}`).toBe(expected);
    }
  });

  it("รับตัวเลขจาก Excel ได้ (ไม่ใช่ string)", () => {
    expect(normalizePhone(812345678)).toBe("+66812345678");
  });

  it("เบอร์บ้าน 9 หลัก", () => {
    expect(normalizePhone("021234567")).toBe("+6621234567");
  });

  it("เบอร์ 066 ที่ตกเลข 0 ต้องไม่ถูกอ่านเป็น country code", () => {
    expect(normalizePhone("0661234567")).toBe("+66661234567");
    // 661234567 = 9 หลัก ไม่ใช่ 11 → ถือเป็นเบอร์ที่ตกเลข 0
    expect(normalizePhone("661234567")).toBe("+66661234567");
  });

  it("input ขยะต้องได้ null ไม่ใช่ hash มั่ว", () => {
    for (const bad of ["", "  ", "abc", "123", "0", "12345", null, undefined, "+1 415 555 0100", "08123456789012"]) {
      expect(normalizePhone(bad), `input=${String(bad)}`).toBeNull();
    }
  });

  it("toLocalPhone แปลงกลับเป็นรูปแบบไทย", () => {
    expect(toLocalPhone("+66812345678")).toBe("0812345678");
  });
});

describe("normalizeEmail", () => {
  it("ตัดช่องว่างและแปลงเป็นตัวพิมพ์เล็ก", () => {
    expect(normalizeEmail("  Somchai@GMAIL.com ")).toBe("somchai@gmail.com");
  });
  it("ปฏิเสธค่าที่ใช้ไม่ได้", () => {
    for (const bad of ["", "somchai", "somchai@", "@gmail.com", "a@b", "a b@c.com", null, undefined]) {
      expect(normalizeEmail(bad), `input=${String(bad)}`).toBeNull();
    }
  });
});

describe("normalizeName", () => {
  it("ตัดคำนำหน้าไทย/อังกฤษ", () => {
    expect(normalizeName("นาย สมชาย ใจดี")).toBe("สมชาย ใจดี");
    expect(normalizeName("นางสาวสมหญิง ใจดี")).toBe("สมหญิง ใจดี");
    expect(normalizeName("Mr. Somchai Jaidee")).toBe("Somchai Jaidee");
  });
  it("ยุบช่องว่างซ้ำ", () => {
    expect(normalizeName("  สมชาย   ใจดี  ")).toBe("สมชาย ใจดี");
  });
  it("ไม่ตัดคำนำหน้าถ้าตัดแล้วเหลือสั้นเกิน", () => {
    expect(normalizeName("คุณ ก")).toBe("คุณ ก");
  });
  it("ปฏิเสธค่าสั้น/ว่าง", () => {
    expect(normalizeName("")).toBeNull();
    expect(normalizeName("ก")).toBeNull();
  });
});

describe("normalizeBirthYearBE", () => {
  const currentBE = new Date().getFullYear() + 543;
  it("รับปี พ.ศ.", () => {
    expect(normalizeBirthYearBE(2535)).toBe(2535);
    expect(normalizeBirthYearBE("2535")).toBe(2535);
  });
  it("แปลง ค.ศ. เป็น พ.ศ. ให้อัตโนมัติ", () => {
    expect(normalizeBirthYearBE(1992)).toBe(2535);
  });
  it("ปฏิเสธค่านอกช่วง", () => {
    expect(normalizeBirthYearBE(2449)).toBeNull();
    expect(normalizeBirthYearBE(currentBE)).toBeNull();
    expect(normalizeBirthYearBE(currentBE - 4)).toBeNull();
    expect(normalizeBirthYearBE("")).toBeNull();
    expect(normalizeBirthYearBE("abc")).toBeNull();
    expect(normalizeBirthYearBE(2535.5)).toBeNull();
  });
  it("คำนวณอายุจากปีเกิดได้ — ไม่ต้องแก้ข้อมูลทุกปี", () => {
    expect(ageFromBirthYearBE(2535, new Date("2026-08-26"))).toBe(34);
    expect(ageFromBirthYearBE(2535, new Date("2027-08-26"))).toBe(35);
  });
});
