import { describe, it, expect } from "vitest";
import { hashValue, maskPhone, maskEmail } from "../src/security/pii";

describe("hashValue", () => {
  it("deterministic — ค่าเดิมได้ hash เดิม", () => {
    expect(hashValue("+66812345678")).toBe(hashValue("+66812345678"));
  });
  it("ค่าต่างกันได้ hash ต่างกัน", () => {
    expect(hashValue("+66812345678")).not.toBe(hashValue("+66812345679"));
  });
  it("ความยาวคงที่ 64 hex", () => {
    expect(hashValue("x")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("เปลี่ยน pepper แล้ว hash ต้องเปลี่ยน — AI DB ใช้ pepper แยก", () => {
    const value = "PHONE|+66812345678";
    expect(hashValue(value, "pepper-a-must-be-long-enough-123")).not.toBe(
      hashValue(value, "pepper-b-must-be-long-enough-456")
    );
  });
});

describe("mask", () => {
  it("maskPhone", () => {
    expect(maskPhone("+66812345678")).toBe("08x-xxx-5678");
    expect(maskPhone("0812345678")).toBe("08x-xxx-5678");
    expect(maskPhone(null)).toBe("");
  });
  it("maskEmail", () => {
    expect(maskEmail("somchai@gmail.com")).toBe("so***@gmail.com");
    expect(maskEmail("ab@x.com")).toBe("a***@x.com");
    expect(maskEmail(null)).toBe("");
  });

  it("maskEmail ไม่ปล่อยอีเมลที่สองจากเซลล์เดียวกัน", () => {
    const masked = maskEmail("first@example.com, second@example.com");
    expect(masked).toBe("fi***@example.com");
    expect(masked).not.toContain("second");
  });
});
