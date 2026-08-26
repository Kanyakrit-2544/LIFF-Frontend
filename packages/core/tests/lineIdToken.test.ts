import { describe, it, expect, vi } from "vitest";
import { verifyLineIdToken } from "../src/security/lineIdToken";

const CLIENT = "2011262829";
const payload = (over: Record<string, unknown> = {}) => ({
  iss: "https://access.line.me",
  sub: "U4af4980629",
  aud: CLIENT,
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  name: "Somchai",
  picture: "https://profile.line-scdn.net/x",
  ...over,
});

const mockFetch = (body: unknown, ok = true) =>
  vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response) as unknown as typeof fetch;

describe("verifyLineIdToken", () => {
  it("token ถูกต้อง → คืน sub", async () => {
    const r = await verifyLineIdToken("tok", { clientId: CLIENT, fetchImpl: mockFetch(payload()) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.sub).toBe("U4af4980629");
  });

  it("⭐ token ของ channel อื่น → WRONG_AUDIENCE", async () => {
    const r = await verifyLineIdToken("tok", { clientId: CLIENT, fetchImpl: mockFetch(payload({ aud: "9999999999" })) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("WRONG_AUDIENCE");
  });

  it("issuer ไม่ใช่ LINE → INVALID", async () => {
    const r = await verifyLineIdToken("tok", { clientId: CLIENT, fetchImpl: mockFetch(payload({ iss: "https://evil.example" })) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID");
  });

  it("หมดอายุ → EXPIRED", async () => {
    const r = await verifyLineIdToken("tok", { clientId: CLIENT, fetchImpl: mockFetch(payload({ exp: Math.floor(Date.now() / 1000) - 10 })) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("EXPIRED");
  });

  it("LINE ตอบ 400 → INVALID และไม่บอกรายละเอียด", async () => {
    const r = await verifyLineIdToken("tok", { clientId: CLIENT, fetchImpl: mockFetch({ error: "invalid_request" }, false) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("INVALID");
      expect(r.message).not.toContain("invalid_request");
    }
  });

  it("ไม่มี sub → INVALID", async () => {
    const r = await verifyLineIdToken("tok", { clientId: CLIENT, fetchImpl: mockFetch(payload({ sub: undefined })) });
    expect(r.ok).toBe(false);
  });

  it("token ว่าง → INVALID โดยไม่ยิงไปหา LINE", async () => {
    const f = mockFetch(payload());
    const r = await verifyLineIdToken("", { clientId: CLIENT, fetchImpl: f });
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("ติดต่อ LINE ไม่ได้ → UPSTREAM (ไม่ใช่ INVALID)", async () => {
    const f = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const r = await verifyLineIdToken("tok", { clientId: CLIENT, fetchImpl: f });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("UPSTREAM");
  });

  it("email มาด้วยเมื่อได้รับอนุมัติ permission", async () => {
    const r = await verifyLineIdToken("tok", { clientId: CLIENT, fetchImpl: mockFetch(payload({ email: "a@b.com" })) });
    expect(r.ok && r.payload.email).toBe("a@b.com");
  });
});
