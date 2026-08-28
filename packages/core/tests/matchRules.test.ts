import { describe, expect, it } from "vitest";
import { decideByRules, type MatchCandidate } from "../src/match/rules";

function candidate(over: Partial<MatchCandidate["evidence"]> = {}): MatchCandidate {
  return {
    customerId: "cus_test",
    legacyPersonId: "lgp_test",
    evidence: {
      phoneHashMatch: false,
      emailHashMatch: false,
      nameKeyOverlap: 0,
      nicknameMatch: false,
      ageBandMatch: null,
      competingCandidates: 0,
      ...over,
    },
  };
}

describe("decideByRules", () => {
  it("phoneHash ตรง 1:1 เป็น auto/high", () => {
    expect(decideByRules(candidate({ phoneHashMatch: true }))).toMatchObject({ method: "phone_hash", status: "auto", confidence: "high" });
  });

  it("phoneHash ตรงแต่มีคู่แข่งต้อง needs_review", () => {
    expect(decideByRules(candidate({ phoneHashMatch: true, competingCandidates: 2 }))).toMatchObject({ status: "needs_review", confidence: "medium" });
  });

  it("emailHash 1:1 auto แต่แบบมีคู่แข่ง needs_review", () => {
    expect(decideByRules(candidate({ emailHashMatch: true }))).toMatchObject({ method: "email_hash", status: "auto" });
    expect(decideByRules(candidate({ emailHashMatch: true, competingCandidates: 1 }))).toMatchObject({ status: "needs_review" });
  });

  it("ชื่ออย่างเดียวไม่มีทางเป็น auto", () => {
    const decision = decideByRules(candidate({ nameKeyOverlap: 3, nicknameMatch: true }));
    expect(decision).toMatchObject({ method: "llm_features", status: "needs_review" });
  });

  it("ชื่อทับกันไม่เกินหนึ่งคำและไม่มี hash ส่งต่อ LLM", () => {
    expect(decideByRules(candidate({ nameKeyOverlap: 1 }))).toBeNull();
  });

  it("score ทุกผลอยู่ในช่วง 0 ถึง 1", () => {
    const decisions = [
      decideByRules(candidate({ phoneHashMatch: true })),
      decideByRules(candidate({ emailHashMatch: true })),
      decideByRules(candidate({ nameKeyOverlap: 2, nicknameMatch: true })),
    ];
    expect(decisions.every((decision) => decision && decision.score >= 0 && decision.score <= 1)).toBe(true);
  });
});
