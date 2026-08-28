import type { AnyBulkWriteOperation, Db, Filter } from "mongodb";
import { AI_COLLECTIONS, type CustomerLinkDoc } from "../db/models";
import { newId } from "../ids";
import { evaluateLlmPairs, llmDecisionToRule } from "../ai/llm/match";
import type { LlmProvider } from "../ai/llm/provider";
import { buildMatchCandidates, type MatchCustomerRow, type MatchLegacyRow } from "./candidates";
import { decideByRules, type RuleDecision } from "./rules";

export interface MatchBuildOptions {
  llmProvider?: LlmProvider | null;
  dryRun?: boolean;
  maxFuzzyCandidates?: number;
  now?: Date;
}

export interface MatchBuildReport {
  customers: number;
  legacyPersons: number;
  phoneAuto: number;
  phoneReview: number;
  emailAuto: number;
  emailReview: number;
  featureRuleReview: number;
  llmAsked: number;
  llmSame: number;
  llmDifferent: number;
  llmUnsure: number;
  llmSkipped: number;
  inserted: number;
  updated: number;
  preservedStaff: number;
  removed: number;
  elapsedMs: number;
}

interface PlannedLink {
  pair: ReturnType<typeof buildMatchCandidates>[number];
  decision: RuleDecision;
  decidedBy: "rule" | "llm";
  llmReason?: string;
  llmModel?: string;
}

const pairKey = (customerId: string, legacyPersonId: string) => `${customerId}\u0000${legacyPersonId}`;

export async function buildCustomerLinks(db: Db, options: MatchBuildOptions = {}): Promise<MatchBuildReport> {
  const started = Date.now();
  const now = options.now ?? new Date();
  const customers = await db.collection<MatchCustomerRow>(AI_COLLECTIONS.customersScrubbed).find({}, {
    projection: {
      _id: 1, customerId: 1, status: 1, phone: 1, email: 1, phoneHash: 1, emailHash: 1,
      nameKeys: 1, nicknameKey: 1, birthYear: 1, firstInteractionAt: 1, formSubmittedAt: 1, courseCodes: 1,
    },
  }).toArray();
  const legacyPeople = await db.collection<MatchLegacyRow>(AI_COLLECTIONS.legacyPersonsScrubbed).find({}, {
    projection: {
      _id: 1, phone: 1, email: 1, phoneHash: 1, emailHash: 1, nameKeys: 1, nicknameKey: 1,
      ageBand: 1, firstPaidAt: 1, courseCodes: 1,
    },
  }).toArray();
  const pairs = buildMatchCandidates(customers, legacyPeople, options.maxFuzzyCandidates ?? 5, now);
  const planned = new Map<string, PlannedLink>();
  const unresolved: typeof pairs = [];
  const report: MatchBuildReport = {
    customers: customers.length, legacyPersons: legacyPeople.length,
    phoneAuto: 0, phoneReview: 0, emailAuto: 0, emailReview: 0, featureRuleReview: 0,
    llmAsked: 0, llmSame: 0, llmDifferent: 0, llmUnsure: 0, llmSkipped: 0,
    inserted: 0, updated: 0, preservedStaff: 0, removed: 0, elapsedMs: 0,
  };
  const allCandidateKeys = new Set(pairs.map((pair) => pairKey(pair.customerId, pair.legacyPersonId)));
  const rejectedLlmKeys = new Set<string>();

  for (const pair of pairs) {
    const decision = decideByRules(pair);
    if (!decision) {
      unresolved.push(pair);
      continue;
    }
    if (decision.method === "phone_hash") decision.status === "auto" ? report.phoneAuto++ : report.phoneReview++;
    else if (decision.method === "email_hash") decision.status === "auto" ? report.emailAuto++ : report.emailReview++;
    else report.featureRuleReview++;
    planned.set(pairKey(pair.customerId, pair.legacyPersonId), { pair, decision, decidedBy: "rule" });
  }

  if (options.llmProvider) {
    report.llmAsked = unresolved.length;
    const llmResults = await evaluateLlmPairs(options.llmProvider, unresolved);
    for (const result of llmResults) {
      if (result.decision.decision === "different") {
        report.llmDifferent++;
        rejectedLlmKeys.add(pairKey(result.pair.customerId, result.pair.legacyPersonId));
        continue;
      }
      if (result.decision.decision === "unsure") {
        report.llmUnsure++;
        if (!result.fallback) rejectedLlmKeys.add(pairKey(result.pair.customerId, result.pair.legacyPersonId));
        continue;
      }
      report.llmSame++;
      const decision = llmDecisionToRule(result.decision)!;
      planned.set(pairKey(result.pair.customerId, result.pair.legacyPersonId), {
        pair: result.pair,
        decision,
        decidedBy: "llm",
        llmReason: result.decision.reason,
        llmModel: options.llmProvider.name,
      });
    }
  } else {
    report.llmSkipped = unresolved.length;
  }

  const linkCollection = db.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks);
  const existing = await linkCollection.find({}).toArray();
  const existingByPair = new Map(existing.map((link) => [pairKey(link.customerId, link.legacyPersonId), link]));
  const operations: AnyBulkWriteOperation<CustomerLinkDoc>[] = [];

  for (const [key, item] of planned) {
    const previous = existingByPair.get(key);
    if (previous?.status === "confirmed" || previous?.status === "rejected") {
      report.preservedStaff++;
      continue;
    }
    const evidence: CustomerLinkDoc["evidence"] = {
      ...item.pair.evidence,
      ...(item.llmReason ? { llmReason: item.llmReason } : {}),
      ...(item.llmModel ? { llmModel: item.llmModel } : {}),
    };
    const mutable = {
      method: item.decision.method,
      confidence: item.decision.confidence,
      score: Math.max(0, Math.min(1, item.decision.score)),
      status: item.decision.status,
      evidence,
      decidedBy: item.decidedBy,
      decidedAt: now,
      updatedAt: now,
      schemaVersion: 1,
    } as const;
    if (previous) report.updated++;
    else report.inserted++;
    operations.push({
      updateOne: {
        filter: { customerId: item.pair.customerId, legacyPersonId: item.pair.legacyPersonId },
        update: {
          $set: mutable,
          $setOnInsert: {
            _id: previous?._id ?? newId("link"),
            customerId: item.pair.customerId,
            legacyPersonId: item.pair.legacyPersonId,
            createdAt: now,
          },
        },
        upsert: true,
      },
    });
  }
  for (const previous of existing) {
    if (previous.status === "confirmed" || previous.status === "rejected") {
      // นับด้วย — เคสที่คนกังวลที่สุดคือ "ของที่พนักงานตัดสินแล้วถูกเครื่องลบทิ้ง"
      // ถ้าไม่นับตรงนี้ รายงานจะขึ้น 0 ทั้งที่เพิ่งป้องกันไปจริง ๆ
      if (!planned.has(pairKey(previous.customerId, previous.legacyPersonId))) report.preservedStaff++;
      continue;
    }
    const key = pairKey(previous.customerId, previous.legacyPersonId);
    if (planned.has(key)) continue;
    const staleRule = previous.decidedBy === "rule";
    const staleLlm = previous.decidedBy === "llm"
      && (!allCandidateKeys.has(key) || rejectedLlmKeys.has(key));
    if (!staleRule && !staleLlm) continue;
    report.removed++;
    operations.push({
      deleteOne: {
        filter: {
          _id: previous._id,
          status: { $nin: ["confirmed", "rejected"] },
        } as Filter<CustomerLinkDoc>,
      },
    });
  }
  if (!options.dryRun && operations.length > 0) await linkCollection.bulkWrite(operations, { ordered: false });
  report.elapsedMs = Date.now() - started;
  return report;
}

export interface MatchVerifyReport {
  ok: boolean;
  plantCustomers: number;
  plantLinks: number;
  /** เฉพาะ link ที่กฎ deterministic สร้าง — ตัวนี้เท่านั้นที่เทียบกับจำนวนที่ปลูกไว้ได้ */
  plantRuleLinks: number;
  expectedPlantLinks: number;
  duplicatePairs: number;
  unsafeAuto: number;
  familyAuto: number;
}

export async function verifyCustomerLinks(db: Db): Promise<MatchVerifyReport> {
  const customers = db.collection<MatchCustomerRow>(AI_COLLECTIONS.customersScrubbed);
  const links = db.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks);
  const plantFilter = { customerId: { $regex: "^cus_PLANT_" } } as Filter<CustomerLinkDoc>;
  const [plantCustomers, plantLinks, plantRuleLinks, noMatchCustomers, duplicates, unsafeAuto, familyAuto] = await Promise.all([
    customers.countDocuments({ $or: [{ _id: { $regex: "^cus_PLANT_" } }, { customerId: { $regex: "^cus_PLANT_" } }] } as Filter<MatchCustomerRow>),
    links.countDocuments(plantFilter),
    // ชั้น LLM สร้าง link needs_review เพิ่มได้เสมอ ซึ่งเป็นพฤติกรรมที่ถูกต้อง
    // ถ้าเอายอดรวมไปเทียบกับจำนวน fixture verify จะตกทุกครั้งที่เปิด LLM
    links.countDocuments({ ...plantFilter, decidedBy: "rule" } as Filter<CustomerLinkDoc>),
    customers.countDocuments({ $or: [{ _id: { $regex: "^cus_PLANT_NOMATCH_" } }, { customerId: { $regex: "^cus_PLANT_NOMATCH_" } }] } as Filter<MatchCustomerRow>),
    links.aggregate<{ count: number }>([
      { $group: { _id: { customerId: "$customerId", legacyPersonId: "$legacyPersonId" }, count: { $sum: 1 } } },
      { $match: { count: { $gt: 1 } } },
    ]).toArray(),
    links.countDocuments({ status: "auto", $or: [{ method: "llm_features" }, { "evidence.competingCandidates": { $gt: 0 } }] }),
    links.countDocuments({ customerId: { $regex: "^cus_PLANT_FAMILY_" }, status: "auto" }),
  ]);
  const expectedPlantLinks = plantCustomers - noMatchCustomers;
  const duplicatePairs = duplicates.length;
  const fixtureOk = plantCustomers === 0
    ? plantLinks === 0
    : plantRuleLinks === expectedPlantLinks;
  return {
    ok: fixtureOk && duplicatePairs === 0 && unsafeAuto === 0 && familyAuto === 0,
    plantCustomers,
    plantLinks,
    plantRuleLinks,
    expectedPlantLinks,
    duplicatePairs,
    unsafeAuto,
    familyAuto,
  };
}
