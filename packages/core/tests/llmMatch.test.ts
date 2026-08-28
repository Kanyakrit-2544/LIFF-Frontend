import { afterEach, describe, expect, it, vi } from "vitest";
import { __resetEnvCache } from "../src/env";
import { createLlmProvider, type LlmProvider } from "../src/ai/llm/provider";
import { evaluateLlmPairs, llmDecisionToRule, serializeLlmBatch } from "../src/ai/llm/match";
import type { CandidatePair } from "../src/match/candidates";
import { toLlmFeatures } from "../src/match/candidates";

const saved = {
  base: process.env.LLM_BASE_URL,
  model: process.env.LLM_MODEL,
  retries: process.env.LLM_MAX_RETRIES,
  timeout: process.env.LLM_TIMEOUT_MS,
};

afterEach(() => {
  for (const [key, value] of Object.entries({
    LLM_BASE_URL: saved.base,
    LLM_MODEL: saved.model,
    LLM_MAX_RETRIES: saved.retries,
    LLM_TIMEOUT_MS: saved.timeout,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  __resetEnvCache();
  vi.restoreAllMocks();
});

function pair(): CandidatePair {
  return {
    customerId: "cus_secret",
    legacyPersonId: "lgp_secret",
    customer: {
      customerId: "cus_secret", phone: "08x-xxx-5678", email: "so***@gmail.com",
      nameKeys: ["aaaaaaaaaaaa", "bbbbbbbbbbbb"], nicknameKey: "cccccccccccc", birthYear: 2535,
      firstInteractionAt: "2026-01-01",
    },
    legacy: {
      _id: "lgp_secret", phone: "08x-xxx-5678", email: "xx***@gmail.com",
      nameKeys: ["aaaaaaaaaaaa", "dddddddddddd"], nicknameKey: "eeeeeeeeeeee", ageBand: "30-39",
      firstPaidAt: "2025-01-01", courseCodes: ["INNER"],
    },
    evidence: {
      phoneHashMatch: false, emailHashMatch: false, nameKeyOverlap: 1,
      nicknameMatch: false, ageBandMatch: true, competingCandidates: 0,
    },
  };
}

describe("LLM match safety", () => {
  it("payload มีเฉพาะ feature และไม่มี PII/id/token", () => {
    const payload = serializeLlmBatch([toLlmFeatures(pair(), "p1")]);
    expect(payload).not.toMatch(/customerId|legacyPersonId|cus_secret|lgp_secret|<PERSON_|[\u0E00-\u0E7F]|@|\d{9,}/i);
  });

  it("provider ตอบ JSON เพี้ยนจนครบ retry แล้วคืน unsure โดยไม่ throw", async () => {
    process.env.LLM_BASE_URL = "http://llm.test/v1";
    process.env.LLM_MODEL = "fake-model";
    process.env.LLM_MAX_RETRIES = "1";
    __resetEnvCache();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: "not json" } }] }), { status: 200 }));
    const results = await evaluateLlmPairs(createLlmProvider()!, [pair()]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(results[0]?.decision.decision).toBe("unsure");
  });

  it("LLM ตอบ same 0.99 ก็ยังเป็น needs_review", () => {
    expect(llmDecisionToRule({ pairId: "p1", decision: "same", confidence: 0.99, reason: "Strong feature overlap." })).toMatchObject({ status: "needs_review", confidence: "medium" });
  });

  it("LLM timeout ไม่ทำให้ batch ล้ม", async () => {
    const provider: LlmProvider = { name: "timeout", complete: async () => { throw new Error("timeout"); } };
    await expect(evaluateLlmPairs(provider, [pair()])).resolves.toMatchObject([{ decision: { decision: "unsure" } }]);
  });

  it("ไม่ตั้ง env แล้ว provider เป็น null", () => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_MODEL;
    __resetEnvCache();
    expect(createLlmProvider()).toBeNull();
  });
});
