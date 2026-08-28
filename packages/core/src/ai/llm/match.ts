import { z } from "zod";
import type { CandidatePair, LlmPairFeatures } from "../../match/candidates";
import { toLlmFeatures } from "../../match/candidates";
import type { LlmProvider } from "./provider";
import type { RuleDecision } from "../../match/rules";

const decisionSchema = z.object({
  pairId: z.string(),
  decision: z.enum(["same", "different", "unsure"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(200),
});

const batchSchema = z.object({ matches: z.array(decisionSchema) });
export type LlmMatchDecision = z.infer<typeof decisionSchema>;

export interface LlmPairResult {
  pair: CandidatePair;
  decision: LlmMatchDecision;
  /** true เมื่อ provider ล้ม/ตอบไม่ครบ/ตอบ reason ที่ไม่ปลอดภัย ไม่ใช่ unsure จากโมเดลจริง */
  fallback: boolean;
}

/** D28/D29: even a highly confident LLM result can only request staff review. */
export function llmDecisionToRule(decision: LlmMatchDecision): RuleDecision | null {
  if (decision.decision !== "same") return null;
  return {
    method: "llm_features",
    confidence: decision.confidence >= 0.7 ? "medium" : "low",
    score: decision.confidence,
    status: "needs_review",
  };
}

export function serializeLlmBatch(features: readonly LlmPairFeatures[]): string {
  return JSON.stringify({ pairs: features });
}

function reasonIsSafe(reason: string): boolean {
  return !/[\u0E00-\u0E7F]|@|<PERSON_|\d{9,}/i.test(reason);
}

export async function evaluateLlmPairs(
  provider: LlmProvider,
  pairs: readonly CandidatePair[],
  batchSize = 20
): Promise<LlmPairResult[]> {
  const results: LlmPairResult[] = [];
  for (let offset = 0; offset < pairs.length; offset += batchSize) {
    const batch = pairs.slice(offset, offset + batchSize);
    const features = batch.map((pair, index) => toLlmFeatures(pair, `p${index + 1}`));
    let response: z.infer<typeof batchSchema> | null = null;
    try {
      response = await provider.complete({
        system: "Decide whether each anonymous feature pair represents the same person. Return JSON only: {matches:[{pairId,decision,confidence,reason}]}. Use only the supplied numeric and boolean features.",
        user: serializeLlmBatch(features),
        schema: batchSchema,
        maxTokens: Math.max(500, batch.length * 80),
      });
    } catch {
      response = null;
    }

    const byId = new Map(response?.matches.map((item) => [item.pairId, item]) ?? []);
    for (let index = 0; index < batch.length; index++) {
      const pair = batch[index]!;
      const found = byId.get(`p${index + 1}`);
      const safe = found && reasonIsSafe(found.reason) ? found : null;
      results.push({
        pair,
        decision: safe ?? { pairId: `p${index + 1}`, decision: "unsure", confidence: 0, reason: "Feature assessment unavailable." },
        fallback: !safe,
      });
    }
  }
  return results;
}
