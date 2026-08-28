import { describe, expect, it } from "vitest";
import { buildMatchCandidates, type MatchCustomerRow, type MatchLegacyRow } from "../src/match/candidates";

const customer: MatchCustomerRow = {
  customerId: "cus_candidates",
  status: "active",
  nameKeys: ["name-a", "name-b"],
  nicknameKey: "nick-a",
};

describe("buildMatchCandidates", () => {
  it("ไม่ตัด deterministic name rule แม้มีเกินเพดาน LLM", () => {
    const legacy: MatchLegacyRow[] = Array.from({ length: 7 }, (_, index) => ({
      _id: `lgp_rule_${index}`,
      nameKeys: ["name-a", "name-b"],
      nicknameKey: "nick-a",
    }));
    expect(buildMatchCandidates([customer], legacy, 5)).toHaveLength(7);
  });

  it("จำกัดเฉพาะคู่ที่ยังต้องส่ง LLM เหลือ 5 คู่", () => {
    const legacy: MatchLegacyRow[] = Array.from({ length: 8 }, (_, index) => ({
      _id: `lgp_llm_${index}`,
      nameKeys: ["name-a", `other-${index}`],
      nicknameKey: null,
    }));
    expect(buildMatchCandidates([customer], legacy, 5)).toHaveLength(5);
  });
});
