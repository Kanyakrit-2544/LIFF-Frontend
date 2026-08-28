import type { CustomerLinkDoc } from "../db/models";

export interface MatchCandidate {
  customerId: string;
  legacyPersonId: string;
  evidence: CustomerLinkDoc["evidence"];
}

export interface RuleDecision {
  method: CustomerLinkDoc["method"];
  confidence: CustomerLinkDoc["confidence"];
  score: number;
  status: "auto" | "needs_review";
}

/** D29: hashes may auto-link only when the pair is unambiguous on both sides. */
export function decideByRules(candidate: MatchCandidate): RuleDecision | null {
  const { evidence } = candidate;
  if (evidence.phoneHashMatch) {
    return evidence.competingCandidates > 0
      ? { method: "phone_hash", confidence: "medium", score: 0.75, status: "needs_review" }
      : { method: "phone_hash", confidence: "high", score: 0.95, status: "auto" };
  }
  if (evidence.emailHashMatch) {
    return evidence.competingCandidates > 0
      ? { method: "email_hash", confidence: "medium", score: 0.7, status: "needs_review" }
      : { method: "email_hash", confidence: "high", score: 0.9, status: "auto" };
  }
  if (evidence.nameKeyOverlap >= 2 && evidence.nicknameMatch) {
    return { method: "llm_features", confidence: "medium", score: 0.6, status: "needs_review" };
  }
  return null;
}
