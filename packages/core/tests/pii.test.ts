import { describe, it, expect } from "vitest";
import { encrypt, decrypt, hashValue, maskPhone, maskEmail, packPhone, packEmail, forSheet } from "../src/security/pii";
import { normalizePhone } from "../src/identity/normalize";

describe("encrypt / decrypt", () => {
  it("round-trip ได้ค่าเดิม", () => {
    for (const v of ["+66812345678", "somchai@gmail.com", "สมชาย ใจดี", ""]) {
      expect(decrypt(encrypt(v))).toBe(v);
    }
  });

  it("ciphertext ต่างกันทุกครั้ง (IV สุ่ม)", () => {
    const a = encrypt("+66812345678");
    const b = encrypt("+66812345678");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(decrypt(b));
  });

  it("มี version prefix เพื่อให้หมุน key ได้", () => {
    expect(encrypt("x").startsWith("v1:")).toBe(true);
  });

  it("ciphertext ที่ถูกแก้ต้อง throw ไม่ใช่คืนค่าขยะ", () => {
    const c = encrypt("+66812345678");
    const parts = c.split(":");
    const tampered = [parts[0], parts[1], Buffer.from("evil").toString("base64"), parts[3]].join(":");
    expect(() => decrypt(tampered)).toThrow();
  });

  it("รูปแบบผิดต้อง throw", () => {
    expect(() => decrypt("not-a-ciphertext")).toThrow();
    expect(() => decrypt("v2:a:b:c")).toThrow();
  });
});

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
});

describe("pack", () => {
  it("packPhone ให้ครบสามส่วน และ enc ถอดกลับได้", () => {
    const e164 = normalizePhone("081-234-5678")!;
    const p = packPhone(e164);
    expect(p.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.masked).toBe("08x-xxx-5678");
    expect(decrypt(p.enc)).toBe("+66812345678");
  });

  it("เบอร์เดียวกันคนละรูปแบบ ต้องได้ hash เดียวกัน — นี่คือหัวใจของการ dedupe", () => {
    const a = packPhone(normalizePhone("0812345678")!);
    const b = packPhone(normalizePhone("+66 81 234 5678")!);
    expect(a.hash).toBe(b.hash);
  });

  it("packEmail", () => {
    const p = packEmail("somchai@gmail.com");
    expect(decrypt(p.enc)).toBe("somchai@gmail.com");
    expect(p.masked).toBe("so***@gmail.com");
  });
});

describe("forSheet", () => {
  it("โหมด full คืนค่าจริง (D15)", () => {
    process.env.SHEETS_PII_MODE = "full";
    expect(forSheet(packPhone("+66812345678"))).toBe("+66812345678");
  });
  it("ค่าว่างคืนสตริงว่าง", () => {
    expect(forSheet(null)).toBe("");
  });
});
