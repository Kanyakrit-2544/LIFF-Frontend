import { describe, it, expect } from "vitest";
import { newCustomerId, isId } from "../src/ids";

describe("ids", () => {
  it("รูปแบบถูกต้องและตรวจสอบได้", () => {
    const id = newCustomerId();
    expect(id).toMatch(/^cus_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isId("customer", id)).toBe(true);
    expect(isId("identity", id)).toBe(false);
  });
  it("ไม่ซ้ำกัน", () => {
    const set = new Set(Array.from({ length: 2000 }, () => newCustomerId()));
    expect(set.size).toBe(2000);
  });
  it("เรียงตามเวลาได้เสมอ แม้สร้างรัวใน ms เดียวกัน (monotonic)", () => {
    // ulid() เปล่า ๆ จะ fail เคสนี้แบบสุ่ม — จึงต้องใช้ monotonicFactory
    const ids = Array.from({ length: 1000 }, () => newCustomerId().slice(4));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });
  it("ปฏิเสธค่าที่ไม่ใช่ id", () => {
    expect(isId("customer", "cus_short")).toBe(false);
    expect(isId("customer", 123)).toBe(false);
    expect(isId("customer", null)).toBe(false);
  });
});
