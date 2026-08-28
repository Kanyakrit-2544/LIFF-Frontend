import type { CustomerIntentDoc, PartnerAttribution, PurchaseDoc, PurchaseItemDoc } from "../partner/models";
import { safeSessionLabel } from "./scrubLegacy";
import { slipGroupId } from "./tokens";

const date = (value: Date | null | undefined) => value ? value.toISOString().slice(0, 10) : null;
const iso = (value: Date | null | undefined) => value ? value.toISOString() : null;

export interface ScrubbedPurchase {
  _id: string;
  customerId: string | null;
  partnerId: string;
  paymentGroupId: string | null;
  amount: number | null;
  currency: string;
  paidAt: string | null;
  year: number;
  month: number | null;
  saleRep: string | null;
  attribution: PartnerAttribution | null;
  status: PurchaseDoc["status"];
  syncedAt: string;
}

export interface ScrubbedPurchaseItem {
  _id: string;
  purchaseId: string;
  customerId: string | null;
  courseCode: string;
  kind: PurchaseItemDoc["kind"];
  countsAsSeat: boolean;
  sessionLabel: string | null;
  sessionStart: string | null;
  sessionYear: number | null;
  syncedAt: string;
}

export interface ScrubbedCustomerIntent {
  _id: string;
  customerId: string | null;
  courseCode: string | null;
  status: CustomerIntentDoc["status"];
  hesitationReason: CustomerIntentDoc["hesitationReason"];
  confidence: number;
  belowThreshold: boolean;
  source: CustomerIntentDoc["source"];
  lock: CustomerIntentDoc["lock"];
  model: string | null;
  observedAt: string;
  supersededAt: string | null;
  voidedAt: string | null;
  partnerId: string;
  syncedAt: string;
}

export function scrubPurchase(purchase: PurchaseDoc, now = new Date()): ScrubbedPurchase {
  return {
    _id: purchase._id,
    customerId: purchase.customerId,
    partnerId: purchase.partnerId,
    paymentGroupId: slipGroupId(purchase.externalPaymentId),
    amount: purchase.amount,
    currency: purchase.currency,
    paidAt: date(purchase.paidAt),
    year: purchase.year,
    month: purchase.month,
    saleRep: purchase.saleRep,
    attribution: purchase.attribution,
    status: purchase.status,
    syncedAt: now.toISOString(),
  };
}

export function scrubPurchaseItem(item: PurchaseItemDoc, now = new Date()): ScrubbedPurchaseItem {
  return {
    _id: item._id,
    purchaseId: item.purchaseId,
    customerId: item.customerId,
    courseCode: item.courseCode,
    kind: item.kind,
    countsAsSeat: item.countsAsSeat,
    sessionLabel: safeSessionLabel(item.sessionLabel),
    sessionStart: date(item.sessionStart),
    sessionYear: item.sessionYear,
    syncedAt: now.toISOString(),
  };
}

export function scrubCustomerIntent(intent: CustomerIntentDoc, now = new Date()): ScrubbedCustomerIntent {
  return {
    _id: intent._id,
    customerId: intent.customerId,
    courseCode: intent.courseCode,
    status: intent.status,
    hesitationReason: intent.hesitationReason,
    confidence: intent.confidence,
    belowThreshold: intent.belowThreshold,
    source: intent.source,
    lock: intent.lock,
    model: intent.model,
    observedAt: intent.observedAt.toISOString(),
    supersededAt: iso(intent.supersededAt),
    voidedAt: iso(intent.voidedAt),
    partnerId: intent.partnerId,
    syncedAt: now.toISOString(),
  };
}

