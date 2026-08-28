import { describe, expect, it } from "vitest";
import { scrubCustomerIntent, scrubPurchase, scrubPurchaseItem } from "../src/ai/scrubPartner";
import type { CustomerIntentDoc, PurchaseDoc, PurchaseItemDoc } from "../src/partner/models";

const now = new Date("2026-08-28T00:00:00Z");

describe("partner AI scrub", () => {
  it("ไม่ส่ง external payment id หรือชื่อคอร์สดิบเข้า AI DB", () => {
    const purchase = scrubPurchase({
      _id: "pur_test", customerId: "cus_test", partnerId: "tagger", externalPaymentId: "SLIP-SECRET",
      amount: 12000, currency: "THB", paidAt: now, year: 2026, month: 8, saleRep: "A",
      attribution: null, status: "active", sourceEventId: "evt-secret",
      aiSync: { dirty: true, syncedAt: null, lockedAt: null, attempts: 0 }, createdAt: now, updatedAt: now, schemaVersion: 1,
    } satisfies PurchaseDoc, now);
    const item = scrubPurchaseItem({
      _id: "pit_test", purchaseId: "pur_test", customerId: "cus_test", courseCode: "INNER",
      courseLabel: "ชื่อดิบ", kind: "enrolled", countsAsSeat: true, sessionLabel: "รุ่น 1 สมชาย",
      sessionStart: now, sessionYear: 2026, createdAt: now, schemaVersion: 1,
    } satisfies PurchaseItemDoc, now);
    expect(purchase).not.toHaveProperty("externalPaymentId");
    expect(purchase).not.toHaveProperty("sourceEventId");
    expect(purchase.paymentGroupId).not.toBe("SLIP-SECRET");
    expect(item).not.toHaveProperty("courseLabel");
    expect(item.sessionLabel).toBe("«ข้อความอื่น»");
  });

  it("intent scrub ไม่มี raw หรือข้อความสนทนา", () => {
    const scrubbed = scrubCustomerIntent({
      _id: "int_test", customerId: "cus_test", courseCode: "INNER", status: "hesitant",
      hesitationReason: "budget", confidence: 0.4, belowThreshold: true, source: "ai", lock: "soft",
      model: "model", observedAt: now, supersededAt: null, voidedAt: null, partnerId: "tagger",
      sourceEventId: "evt-secret", aiSync: { dirty: true, syncedAt: null, lockedAt: null, attempts: 0 },
      createdAt: now, updatedAt: now, schemaVersion: 1,
    } satisfies CustomerIntentDoc, now);
    expect(scrubbed).not.toHaveProperty("raw");
    expect(scrubbed).not.toHaveProperty("sourceEventId");
    expect(JSON.stringify(scrubbed)).not.toContain("evt-secret");
  });
});
