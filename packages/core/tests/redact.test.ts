import { describe, it, expect } from "vitest";
import { redactLineEvent, redactLineEvents } from "../src/events/redact";
import type { LineEvent } from "../src/events/lineTypes";

const msg = (extra: Record<string, unknown> = {}): LineEvent => ({
  type: "message",
  webhookEventId: "E1",
  timestamp: 1756180260000,
  source: { type: "user", userId: "U123" },
  message: { id: "M1", type: "text", text: "สวัสดีครับ เบอร์ผม 0812345678", ...extra },
});

describe("redactLineEvent (D4 — ไม่เก็บบทสนทนา)", () => {
  it("ตัดข้อความลูกค้าทิ้ง เหลือแค่ id กับ type", () => {
    const out = redactLineEvent(msg());
    expect(out.message).toEqual({ id: "M1", type: "text" });
    expect(JSON.stringify(out)).not.toContain("สวัสดี");
    expect(JSON.stringify(out)).not.toContain("0812345678");
  });

  it("ตัด sticker id / ชื่อไฟล์ / พิกัดออกด้วย", () => {
    const out = redactLineEvent(msg({ packageId: "446", stickerId: "1988", fileName: "ใบเสร็จ.pdf", latitude: 13.7 }));
    expect(out.message).toEqual({ id: "M1", type: "text" });
    const s = JSON.stringify(out);
    for (const leak of ["1988", "ใบเสร็จ", "13.7", "446"]) expect(s).not.toContain(leak);
  });

  it("ยังเก็บสิ่งที่จำเป็นต่อการประมวลผลไว้ครบ", () => {
    const out = redactLineEvent(msg());
    expect(out.webhookEventId).toBe("E1");
    expect(out.source?.userId).toBe("U123");
    expect(out.timestamp).toBe(1756180260000);
  });

  it("event ที่ไม่ใช่ message ไม่ถูกแตะ", () => {
    const follow: LineEvent = { type: "follow", webhookEventId: "E2", source: { type: "user", userId: "U1" }, replyToken: "rt" };
    expect(redactLineEvent(follow)).toEqual(follow);
  });

  it("message ที่ไม่มี field message ไม่พัง", () => {
    const e: LineEvent = { type: "message", webhookEventId: "E3" };
    expect(() => redactLineEvent(e)).not.toThrow();
  });

  it("redactLineEvents ทำทั้ง array", () => {
    const out = redactLineEvents([msg(), { type: "follow", webhookEventId: "E9" }]);
    expect(JSON.stringify(out)).not.toContain("สวัสดี");
    expect(out).toHaveLength(2);
  });
});
