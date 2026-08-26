import { describe, it, expect } from "vitest";
import { verifyLineSignature, signLineBody } from "../src/security/lineSignature";

const SECRET = "test-channel-secret";
const BODY = JSON.stringify({ destination: "U206d", events: [{ type: "follow", webhookEventId: "E1" }] });

describe("verifyLineSignature", () => {
  it("signature ที่ถูกต้องผ่าน", () => {
    expect(verifyLineSignature(BODY, signLineBody(BODY, SECRET), SECRET)).toBe(true);
  });

  it("ไม่มี signature = ไม่ผ่าน", () => {
    expect(verifyLineSignature(BODY, null, SECRET)).toBe(false);
    expect(verifyLineSignature(BODY, "", SECRET)).toBe(false);
  });

  it("body ถูกแก้หลังเซ็น = ไม่ผ่าน", () => {
    const sig = signLineBody(BODY, SECRET);
    expect(verifyLineSignature(BODY + " ", sig, SECRET)).toBe(false);
    expect(verifyLineSignature(BODY.replace("follow", "unfollo"), sig, SECRET)).toBe(false);
  });

  it("channel secret ผิด = ไม่ผ่าน", () => {
    expect(verifyLineSignature(BODY, signLineBody(BODY, "other-secret"), SECRET)).toBe(false);
  });

  it("signature ความยาวไม่เท่ากันต้องคืน false ไม่ใช่ throw", () => {
    expect(() => verifyLineSignature(BODY, "c2hvcnQ=", SECRET)).not.toThrow();
    expect(verifyLineSignature(BODY, "c2hvcnQ=", SECRET)).toBe(false);
  });

  it("signature ที่ไม่ใช่ base64 ต้องคืน false ไม่ใช่ throw", () => {
    expect(verifyLineSignature(BODY, "!!!not-base64!!!", SECRET)).toBe(false);
  });

  it("แก้ signature ทีละไบต์ต้องไม่ผ่าน", () => {
    const sig = signLineBody(BODY, SECRET);
    const buf = Buffer.from(sig, "base64");
    buf[0] = buf[0]! ^ 0x01;
    expect(verifyLineSignature(BODY, buf.toString("base64"), SECRET)).toBe(false);
  });
});
