import { afterEach, describe, expect, it } from "vitest";
import { __resetEnvCache } from "../src/env";
import { scrubCustomer } from "../src/ai/scrubCustomer";
import type { CustomerDoc } from "../src/db/models";

const savedPepper = process.env.AI_HASH_PEPPER;

afterEach(() => {
  if (savedPepper === undefined) delete process.env.AI_HASH_PEPPER;
  else process.env.AI_HASH_PEPPER = savedPepper;
  __resetEnvCache();
});

function customer(over: Partial<CustomerDoc> = {}): CustomerDoc {
  return {
    _id: "cus_scrub",
    status: "active",
    mergedInto: null,
    displayName: "สมชาย ใจดี",
    nickname: "ชาย",
    fullNameEn: "Somchai Jaidee",
    birthYear: 2535,
    lineDisplayName: "LINE Somchai",
    pictureUrl: "https://profile.line-scdn.net/raw",
    facebook: "fb.somchai",
    instagram: "ig.somchai",
    phone: "+66812345678",
    email: "somchai@gmail.com",
    customerStatus: "lead",
    tags: ["line-follower", "form-completed"],
    source: { channel: "line", campaign: null },
    sources: ["line"],
    consent: {
      dataProcessing: true,
      marketing: true,
      version: "v1",
      grantedAt: new Date("2026-08-01T00:00:00Z"),
      ip: "203.0.113.10",
      userAgent: "Mozilla test",
    },
    profileRef: { revision: 1, formId: "customer_onboarding", formVersion: "v1", updatedAt: new Date("2026-08-02T10:00:00Z") },
    pendingMerge: { candidateId: "cus_other", reason: "phone_match", at: new Date("2026-08-02T10:01:00Z") },
    sheetSync: { dirty: true, rowKey: "cus_scrub", syncedAt: null, lockedAt: null, attempts: 0 },
    aiSync: { dirty: true, syncedAt: null, lockedAt: null, attempts: 0 },
    counters: { milestones: 1, formSubmits: 1 },
    firstInteractionAt: new Date("2026-07-01T00:00:00Z"),
    firstMessageAt: new Date("2026-07-02T00:00:00Z"),
    lastInteractionAt: new Date("2026-08-02T10:00:00Z"),
    createdAt: new Date("2026-07-01T00:00:00Z"),
    updatedAt: new Date("2026-08-03T10:20:00Z"),
    schemaVersion: 1,
    ...over,
  };
}

describe("scrubCustomer", () => {
  it("ส่งเฉพาะข้อมูล scrubbed ไป AI DB และไม่หลุดชื่อ/เบอร์/อีเมลดิบ", () => {
    const s = scrubCustomer(customer(), new Date("2026-08-27T04:00:00Z"));
    const text = JSON.stringify(s);

    expect(s._id).toBe("cus_scrub");
    expect(s.displayName).toMatch(/^<PERSON_[0-9a-f]{8}>$/);
    expect(s.nickname).toMatch(/^<PERSON_[0-9a-f]{8}>$/);
    expect(s.phone).toBe("08x-xxx-5678");
    expect(s.email).toBe("so***@gmail.com");
    expect(s.phoneHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.birthYear).toBe(2535);
    expect(s.consentMarketing).toBe(true);
    expect(s.syncedAt).toBe("2026-08-27T04:00:00.000Z");
    for (const raw of ["สมชาย", "Somchai", "+66812345678", "somchai@gmail.com", "fb.somchai", "203.0.113.10", "Mozilla"]) {
      expect(text, raw).not.toContain(raw);
    }
  });

  it("person token และ hash deterministic เมื่อใช้ pepper เดิม", () => {
    const a = scrubCustomer(customer());
    const b = scrubCustomer(customer());
    expect(b.displayName).toBe(a.displayName);
    expect(b.phoneHash).toBe(a.phoneHash);
  });

  it("AI_HASH_PEPPER คนละตัวทำให้ hash คนละชุด", () => {
    process.env.AI_HASH_PEPPER = "test-ai-pepper-one-must-be-at-least-32";
    __resetEnvCache();
    const a = scrubCustomer(customer());

    process.env.AI_HASH_PEPPER = "test-ai-pepper-two-must-be-at-least-32";
    __resetEnvCache();
    const b = scrubCustomer(customer());

    expect(b.phoneHash).not.toBe(a.phoneHash);
    expect(b.emailHash).not.toBe(a.emailHash);
  });

  it("ส่ง tombstone ของลูกค้าที่ถูก merge ไปด้วย", () => {
    const s = scrubCustomer(customer({ status: "merged", mergedInto: "cus_winner" }));
    expect(s.status).toBe("merged");
    expect(s.mergedInto).toBe("cus_winner");
  });
});
