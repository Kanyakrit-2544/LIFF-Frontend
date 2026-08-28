import { describe, expect, it } from "vitest";
import { parsePartnerEvent } from "../src/partner/schema";

function intent(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "evt-intent",
    type: "intent",
    occurredAt: "2026-08-28T10:00:00+07:00",
    revision: 1,
    subject: { lineUserId: "U-test" },
    intent: {
      courseCode: "INNER",
      status: "interested",
      hesitationReason: null,
      confidence: 0.8,
      source: "ai",
      model: "test-model",
    },
    ...overrides,
  };
}

describe("partner event contract", () => {
  it("ปฏิเสธ occurredAt ที่ไม่มี timezone", () => {
    const result = parsePartnerEvent(intent({ occurredAt: "2026-08-28T10:00:00" }));
    expect(result).toMatchObject({ ok: false, status: "rejected" });
  });

  it.each(["quote", "evidence", "snippet", "summary"])("ปฏิเสธ field ข้อความ %s ทุกระดับ", (key) => {
    const result = parsePartnerEvent(intent({ subject: { lineUserId: "U-test", [key]: "ข้อความลูกค้า" } }));
    expect(result).toMatchObject({ ok: false, status: "rejected", reason: "forbidden_chat_field" });
  });

  it("ส่ง tag เข้า quarantine ไม่เขียนเป็น intent", () => {
    const result = parsePartnerEvent({
      eventId: "evt-tag", type: "tag", occurredAt: "2026-08-28T10:00:00Z", revision: 1,
      subject: { lineUserId: "U-test" }, tags: ["hot"],
    });
    expect(result).toMatchObject({ ok: false, status: "quarantined", reason: "unsupported_type:tag" });
  });

  it("ค่า intent นอก enum เข้า quarantine", () => {
    const result = parsePartnerEvent(intent({
      intent: { courseCode: "INNER", status: "maybe", hesitationReason: null, confidence: 0.8, source: "ai", model: "test" },
    }));
    expect(result).toMatchObject({ ok: false, status: "quarantined", reason: "unknown_intent_status:maybe" });
  });

  it("AI ต้องมี model และห้ามส่ง lock", () => {
    const missing = parsePartnerEvent(intent({
      intent: { courseCode: "INNER", status: "interested", hesitationReason: null, confidence: 0.8, source: "ai", model: null },
    }));
    expect(missing).toMatchObject({ ok: false, status: "rejected", reason: "ai_model_required" });
    const locked = parsePartnerEvent(intent({
      intent: { courseCode: "INNER", status: "interested", hesitationReason: null, confidence: 0.8, source: "ai", model: "test", lock: "sticky" },
    }));
    expect(locked).toMatchObject({ ok: false, status: "rejected", reason: "ai_lock_forbidden" });
  });

  it("staff ถูกบังคับ confidence=1 และ model=null", () => {
    const result = parsePartnerEvent(intent({
      intent: { courseCode: "INNER", status: "interested", hesitationReason: null, confidence: 0.4, source: "staff", model: "ignored" },
    }));
    expect(result.ok && result.event.intent).toMatchObject({ confidence: 1, model: null, lock: "soft" });
  });

  it("hesitationReason ใช้ได้เฉพาะ hesitant", () => {
    const result = parsePartnerEvent(intent({
      intent: { courseCode: "INNER", status: "interested", hesitationReason: "budget", confidence: 0.8, source: "ai", model: "test" },
    }));
    expect(result).toMatchObject({ ok: false, status: "rejected", reason: "hesitation_reason_without_hesitant" });
  });
});
