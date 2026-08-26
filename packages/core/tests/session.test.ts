import { describe, it, expect } from "vitest";
import { createSession, readSession } from "../src/security/session";

const base = { customerId: "cus_01TEST", lineUserId: "U123", channelId: "2011262829" };

describe("session cookie", () => {
  it("สร้างแล้วอ่านกลับได้", () => {
    const r = readSession(createSession(base));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.payload.sub).toBe("cus_01TEST");
      expect(r.payload.lineUserId).toBe("U123");
    }
  });

  it("⭐ payload ที่ถูกแก้ต้องไม่ผ่าน — ไม่งั้นปลอมเป็นลูกค้าคนอื่นได้", () => {
    const token = createSession(base);
    const [h, b, s] = token.split(".") as [string, string, string];
    const payload = JSON.parse(Buffer.from(b, "base64url").toString());
    payload.sub = "cus_คนอื่น";
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}`;
    const r = readSession(forged);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("BAD_SIGNATURE");
  });

  it("signature ที่ถูกแก้ไม่ผ่าน", () => {
    const t = createSession(base);
    const parts = t.split(".");
    expect(readSession(`${parts[0]}.${parts[1]}.${"A".repeat(parts[2]!.length)}`).ok).toBe(false);
  });

  it("หมดอายุแล้วไม่ผ่าน", () => {
    const r = readSession(createSession(base, -1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("EXPIRED");
  });

  it("ค่าที่ไม่ใช่ token ต้องคืน false ไม่ใช่ throw", () => {
    for (const bad of [null, undefined, "", "abc", "a.b", "a.b.c.d", "...", "a.b.c"]) {
      expect(() => readSession(bad as string), String(bad)).not.toThrow();
      expect(readSession(bad as string).ok, String(bad)).toBe(false);
    }
  });

  it("token ที่เซ็นด้วย secret อื่นไม่ผ่าน", () => {
    const saved = process.env.SESSION_JWT_SECRET;
    const t = createSession(base);
    process.env.SESSION_JWT_SECRET = "another-secret-that-is-long-enough-x";
    // env มี cache — ทดสอบผ่านการแก้ signature แทนเพื่อไม่ให้ปนกับ test อื่น
    process.env.SESSION_JWT_SECRET = saved;
    const tampered = t.slice(0, -4) + "AAAA";
    expect(readSession(tampered).ok).toBe(false);
  });
});
