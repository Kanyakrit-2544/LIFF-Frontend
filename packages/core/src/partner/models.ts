import type { EnrollmentKind } from "../legacy/courseCell";

export const PARTNER_SCHEMA_VERSION = 1;

export type PartnerEventType = "purchase" | "purchase.void" | "intent" | "intent.void" | "erase" | "tag";
export type PartnerEventStatus = "accepted" | "quarantined" | "pending_identity" | "voided";
export type PartnerResultStatus = PartnerEventStatus | "duplicate" | "rejected";

export interface PartnerSubject {
  lineUserId: string | null;
  phone: string | null;
  email: string | null;
  fullName: string | null;
}

export interface PartnerEventDoc {
  _id: string;
  partnerId: string;
  eventId: string;
  revision: number;
  type: PartnerEventType;
  occurredAt: Date;
  receivedAt: Date;
  status: PartnerEventStatus;
  reason: string | null;
  customerId: string | null;
  purchaseId: string | null;
  raw: Record<string, unknown>;
  schemaVersion: number;
}

export interface PartnerAttribution {
  source: string | null;
  adOrOrganic: string | null;
  campaignId: string | null;
  contentRef: string | null;
}

export interface PartnerAiSyncState {
  dirty: boolean;
  syncedAt: Date | null;
  lockedAt: Date | null;
  attempts: number;
  claimId?: string;
}

export interface PurchaseDoc {
  _id: string;
  customerId: string | null;
  partnerId: string;
  externalPaymentId: string | null;
  amount: number | null;
  currency: string;
  paidAt: Date | null;
  year: number;
  month: number | null;
  saleRep: string | null;
  attribution: PartnerAttribution | null;
  status: "active" | "voided";
  sourceEventId: string;
  aiSync: PartnerAiSyncState;
  createdAt: Date;
  updatedAt: Date;
  schemaVersion: number;
}

export type IntentStatus = "interested" | "not_interested" | "hesitant" | "unknown";
export type HesitationReason = "budget" | "not_needed" | "timing_conflict" | "not_ready" | "needs_approval" | "unknown";

export interface CustomerIntentDoc {
  _id: string;
  customerId: string | null;
  courseCode: string | null;
  status: IntentStatus;
  hesitationReason: HesitationReason | null;
  confidence: number;
  belowThreshold: boolean;
  source: "ai" | "staff";
  lock: "soft" | "sticky";
  model: string | null;
  observedAt: Date;
  supersededAt: Date | null;
  voidedAt: Date | null;
  partnerId: string;
  sourceEventId: string;
  aiSync: PartnerAiSyncState;
  createdAt: Date;
  updatedAt: Date;
  schemaVersion: number;
}

export interface PurchaseItemDoc {
  _id: string;
  purchaseId: string;
  customerId: string | null;
  courseCode: string;
  courseLabel: string;
  kind: EnrollmentKind;
  countsAsSeat: boolean;
  sessionLabel: string | null;
  sessionStart: Date | null;
  sessionYear: number | null;
  createdAt: Date;
  schemaVersion: number;
}

export interface PartnerQuarantineDoc {
  _id: string;
  partnerId: string;
  eventId: string;
  revision: number;
  reason: string;
  raw: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  schemaVersion: number;
}

export interface PartnerEventResult {
  eventId: string;
  status: PartnerResultStatus;
  reason?: string;
}

