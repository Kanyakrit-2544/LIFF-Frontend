import { describe, it, expect } from "vitest";
import { redact } from "../src/logger";

describe("redact", () => {
  it("ลบเบอร์โทรออกจากข้อความ", () => {
    expect(redact("โทรหา 081-234-5678 นะ")).toBe("โทรหา [PHONE] นะ");
    expect(redact("+66812345678")).toBe("[PHONE]");
  });
  it("ลบอีเมล", () => {
    expect(redact("ส่งไป somchai@gmail.com")).toBe("ส่งไป [EMAIL]");
  });
  it("ลบ JWT", () => {
    expect(redact("token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJVMTIzIn0.abc-_123")).toContain("[JWT]");
  });
  it("ลบเลขบัตรประชาชน", () => {
    expect(redact("1-2345-67890-12-3")).toBe("[NATIONAL_ID]");
  });
  it("ตัด field ที่ชื่อบ่งบอกว่าเป็นความลับ", () => {
    const out = redact({ INTERNAL_HMAC_SECRET: "abc", phoneEnc: "v1:x:y:z", idToken: "t", ok: 1 }) as Record<string, unknown>;
    expect(out.INTERNAL_HMAC_SECRET).toBe("[REDACTED]");
    expect(out.phoneEnc).toBe("[REDACTED]");
    expect(out.idToken).toBe("[REDACTED]");
    expect(out.ok).toBe(1);
  });
  it("ลงลึกใน object และ array", () => {
    const out = redact({ users: [{ note: "โทร 0812345678" }] }) as { users: { note: string }[] };
    expect(out.users[0]!.note).toBe("โทร [PHONE]");
  });
});
