import type { CustomerDoc } from "../db/models";
import { courseByCode } from "../legacy/courses";
import type { CustomerIntentDoc, HesitationReason } from "../partner/models";

export type RecommendationCustomer = Pick<
  CustomerDoc,
  "_id" | "status" | "displayName" | "lineDisplayName" | "consent"
> & { synthetic?: boolean };

export type FollowUpIntent = Pick<
  CustomerIntentDoc,
  | "customerId"
  | "courseCode"
  | "status"
  | "hesitationReason"
  | "confidence"
  | "observedAt"
  | "supersededAt"
  | "voidedAt"
> & { synthetic?: boolean };

export interface FollowUpReco {
  recoId: string;
  type: "follow_up";
  customerId: string;
  customerName: string;
  courseCode: string;
  courseName: string;
  hesitationReason: HesitationReason | null;
  confidence: number;
  suggestedAction: string;
  observedAt: Date;
  synthetic: boolean;
}

export type PurchasedByCustomer = ReadonlyMap<string, ReadonlySet<string>>;

export function followUpAction(reason: HesitationReason | null): string {
  if (reason === "budget") return "เสนอผ่อน / ส่วนลด";
  if (reason === "timing_conflict" || reason === "not_ready") return "เตือนรอบถัดไป";
  return "ตามผลทั่วไป";
}

function courseName(code: string): string {
  return courseByCode(code)?.nameTh ?? code;
}

export function buildFollowUpRecommendations(
  intents: readonly FollowUpIntent[],
  customersById: ReadonlyMap<string, RecommendationCustomer>,
  purchasedByCustomer: PurchasedByCustomer
): FollowUpReco[] {
  const byRecoId = new Map<string, FollowUpReco>();

  for (const intent of intents) {
    if (
      intent.status !== "hesitant"
      || intent.voidedAt !== null
      || intent.supersededAt !== null
      || !intent.customerId
      || !intent.courseCode
    ) continue;

    const customer = customersById.get(intent.customerId);
    if (!customer || customer.status !== "active" || customer.consent?.marketing !== true) continue;
    const code = intent.courseCode.trim().toUpperCase();
    if (!code || purchasedByCustomer.get(customer._id)?.has(code)) continue;

    const recoId = `follow_up:${customer._id}:${code}`;
    const candidate: FollowUpReco = {
      recoId,
      type: "follow_up",
      customerId: customer._id,
      customerName: customer.displayName ?? customer.lineDisplayName ?? customer._id,
      courseCode: code,
      courseName: courseName(code),
      hesitationReason: intent.hesitationReason,
      confidence: intent.confidence,
      suggestedAction: followUpAction(intent.hesitationReason),
      observedAt: intent.observedAt,
      synthetic: customer.synthetic === true || intent.synthetic === true,
    };
    const existing = byRecoId.get(recoId);
    if (!existing || candidate.observedAt > existing.observedAt) byRecoId.set(recoId, candidate);
  }

  return [...byRecoId.values()].sort((left, right) =>
    right.observedAt.getTime() - left.observedAt.getTime() || left.recoId.localeCompare(right.recoId)
  );
}
