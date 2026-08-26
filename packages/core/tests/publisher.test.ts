import { describe, it, expect } from "vitest";
import { signInternal, verifyInternal } from "../src/events/publisher";

const SECRET = "internal-hmac-secret-at-least-32-chars-long";
const BODY = JSON.stringify({ eventIds: ["E1"] });

describe("internal HMAC", () => {
  it("signature ที่ถูกต้องและอยู่ในช่วงเวลาผ่าน", () => {
    const ts = Math.floor(Date.now() / 1000);
    expect(verifyInternal(BODY, signInternal(BODY, ts, SECRET), String(ts), SECRET)).toBe(true);
  });

  it("timestamp เก่ากว่า 5 นาที = ไม่ผ่าน (กัน replay)", () => {
    const old = Math.floor(Date.now() / 1000) - 600;
    expect(verifyInternal(BODY, signInternal(BODY, old, SECRET), String(old), SECRET)).toBe(false);
  });

  it("timestamp อนาคตไกลเกิน = ไม่ผ่าน", () => {
    const future = Math.floor(Date.now() / 1000) + 600;
    expect(verifyInternal(BODY, signInternal(BODY, future, SECRET), String(future), SECRET)).toBe(false);
  });

  it("body ถูกแก้ = ไม่ผ่าน", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = signInternal(BODY, ts, SECRET);
    expect(verifyInternal(BODY + "x", sig, String(ts), SECRET)).toBe(false);
  });

  it("ใช้ timestamp อื่นกับ signature เดิม = ไม่ผ่าน", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = signInternal(BODY, ts, SECRET);
    expect(verifyInternal(BODY, sig, String(ts - 1), SECRET)).toBe(false);
  });

  it("ค่าที่หายไปหรือไม่ใช่ตัวเลข = ไม่ผ่าน ไม่ throw", () => {
    expect(verifyInternal(BODY, null, "123", SECRET)).toBe(false);
    expect(verifyInternal(BODY, "sha256=x", null, SECRET)).toBe(false);
    expect(verifyInternal(BODY, "sha256=x", "abc", SECRET)).toBe(false);
  });
});
