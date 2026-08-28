import { describe, expect, it } from "vitest";
import { scrubCustomer } from "../src/ai/scrubCustomer";
import { ageBand, emailHash, phoneHash, slipGroupId } from "../src/ai/tokens";
import { normalizePhone } from "../src/identity/normalize";
import type { CustomerDoc } from "../src/db/models";

function customer(phone: string): CustomerDoc {
  const now = new Date("2026-08-28T00:00:00Z");
  return {
    _id: "cus_token_test",
    status: "active",
    mergedInto: null,
    title: null,
    heardFrom: null,
    displayName: "สมชาย ใจดี",
    nickname: null,
    fullNameEn: null,
    birthYear: null,
    lineDisplayName: "token-test",
    pictureUrl: null,
    facebook: null,
    instagram: null,
    phone,
    email: null,
    customerStatus: "lead",
    tags: [],
    source: { channel: "line", campaign: null },
    sources: ["line"],
    consent: null,
    profileRef: null,
    pendingMerge: null,
    sheetSync: { dirty: false, rowKey: "cus_token_test", syncedAt: null, lockedAt: null, attempts: 0 },
    aiSync: { dirty: false, syncedAt: null, lockedAt: null, attempts: 0 },
    counters: { milestones: 0, formSubmits: 0 },
    firstInteractionAt: now,
    firstMessageAt: null,
    lastInteractionAt: now,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
}

describe("AI tokens", () => {
  it("phoneHash คงค่าเดิมกับ scrubCustomer และใช้ phoneHash เป็น parity key", () => {
    const e164 = normalizePhone("081-234-5678")!;
    const scrubbed = scrubCustomer(customer(e164));
    expect(phoneHash(e164)).toBe(scrubbed.phoneHash);
    expect(phoneHash(normalizePhone("0812345678")!)).toBe(phoneHash("+66812345678"));
    expect(phoneHash("+66812345678")).toBe("87907b4dc20ecfae8875989376e25c98c3e3574cc4272487f27f0593a78a2c1c");
  });

  it("emailHash ไม่แยกคนเพราะตัวพิมพ์ใหญ่/เล็ก", () => {
    expect(emailHash("Somchai@GMAIL.com")).toBe(emailHash("somchai@gmail.com"));
  });

  it("ageBand ใช้ช่วงสิบปีและคืน null เมื่ออายุไม่สมเหตุผล", () => {
    expect(ageBand(34)).toBe("30-39");
    expect(ageBand(null)).toBeNull();
    expect(ageBand(9)).toBeNull();
    expect(ageBand(120)).toBeNull();
  });

  it("slipGroupId deterministic และไม่เปิดเผยเลขสลิป", () => {
    const id = slipGroupId(" in-6806-00164 ")!;
    expect(id).toBe(slipGroupId("IN-6806-00164"));
    expect(id).toMatch(/^[0-9a-f]{12}$/);
    expect(id).not.toContain("6806");
  });
});
