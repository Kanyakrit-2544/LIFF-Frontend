import type { ObjectId } from "mongodb";

/** ชื่อ collection รวมไว้ที่เดียว — พิมพ์ผิดจะพังตอน compile ไม่ใช่ตอน runtime */
export const COLLECTIONS = {
  customers: "customers",
  identities: "identities",
  customerProfiles: "customer_profiles",
  formSchemas: "form_schemas",
  interactions: "interactions",
  inboundEvents: "inbound_events",
  auditLogs: "audit_logs",
  partnerEvents: "partner_events",
  purchases: "purchases",
  purchaseItems: "purchase_items",
  customerIntents: "customer_intents",
  partnerQuarantine: "partner_quarantine",
} as const;

export const AI_COLLECTIONS = {
  customersScrubbed: "customers_scrubbed",
  legacyPersonsScrubbed: "legacy_persons_scrubbed",
  legacyPaymentsScrubbed: "legacy_payments_scrubbed",
  legacyEnrollmentsScrubbed: "legacy_enrollments_scrubbed",
  customerLinks: "customer_links",
  purchasesScrubbed: "purchases_scrubbed",
  purchaseItemsScrubbed: "purchase_items_scrubbed",
  customerIntentsScrubbed: "customer_intents_scrubbed",
} as const;

export type IdentityProvider =
  | "line"
  | "line_login"
  | "facebook"
  | "instagram"
  | "lead_ads"
  | "email"
  | "phone"
  | "legacy_import";

export type CustomerStatus = "lead" | "prospect" | "customer" | "inactive";
export type RecordStatus = "active" | "merged" | "archived";

export interface CustomerLinkDoc {
  _id: string;
  customerId: string;
  legacyPersonId: string;
  method: "phone_hash" | "email_hash" | "llm_features";
  confidence: "high" | "medium" | "low";
  score: number;
  status: "auto" | "needs_review" | "confirmed" | "rejected";
  evidence: {
    phoneHashMatch: boolean;
    emailHashMatch: boolean;
    nameKeyOverlap: number;
    nicknameMatch: boolean;
    ageBandMatch: boolean | null;
    llmReason?: string;
    llmModel?: string;
    competingCandidates: number;
  };
  decidedBy: "rule" | "llm" | "staff";
  decidedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  schemaVersion: number;
}

export interface CustomerDoc {
  _id: string; // cus_<ULID>
  status: RecordStatus;
  mergedInto: string | null;

  /** คำนำหน้า: นาย · นาง · นางสาว · ไม่ระบุ */
  title: string | null;
  /** ลูกค้าเห็นเราจากช่องทางไหน */
  heardFrom: string | null;
  displayName: string | null;
  nickname: string | null;
  fullNameEn: string | null;
  birthYear: number | null; // พ.ศ. (D16)
  lineDisplayName: string | null;
  pictureUrl: string | null;
  facebook: string | null;
  instagram: string | null;

  /** S9: DB หลักเป็น plaintext normalized — จำกัดสิทธิ์ด้วย Mongo user แทน encryption ใน field */
  phone: string | null;
  email: string | null;

  customerStatus: CustomerStatus;
  tags: string[];
  source: { channel: string; campaign: string | null };
  sources: string[];

  consent: {
    dataProcessing: boolean;
    marketing: boolean;
    version: string;
    grantedAt: Date;
    ip: string | null;
    userAgent: string | null;
  } | null;

  profileRef: { revision: number; formId: string; formVersion: string; updatedAt: Date } | null;

  /**
   * เบอร์/อีเมลที่กรอกมาตรงกับลูกค้าอีกคน แต่ยังไม่ยืนยันว่าเป็นคนเดียวกัน
   * ไม่ merge อัตโนมัติ เพราะเบอร์ที่พิมพ์เองเป็นการอ้างที่ยังไม่ได้ตรวจสอบ
   * ใครก็พิมพ์เบอร์ของคนอื่นได้ → merge อัตโนมัติ = ยึดบัญชีคนอื่นได้
   */
  pendingMerge: { candidateId: string; reason: string; at: Date } | null;

  /** ที่มาจากโฆษณา/คอนเทนต์ — เติมเมื่อลูกค้ามาจาก Facebook Lead (docs/28) */
  leadAttribution?: {
    pageId: string | null;
    formId: string | null;
    adId: string | null;
    courseCode: string | null;
    campaignName: string | null;
    adOrOrganic: "ad" | "organic" | "unknown";
    /** true = ยังไม่มี mapping ต้องมีคนเติมแล้วรันย้อนหลัง (D34) */
    attributionPending: boolean;
    capturedAt: Date;
  } | null;

  sheetSync: {
    dirty: boolean;
    rowKey: string;
    syncedAt: Date | null;
    lockedAt: Date | null;
    attempts: number;
    /** ตีตราตอนจองงาน — กัน worker สองตัวหยิบแถวเดียวกัน */
    claimId?: string;
  };

  aiSync: {
    dirty: boolean;
    syncedAt: Date | null;
    lockedAt: Date | null;
    attempts: number;
    /** ตีตราตอนจองงาน — กัน worker สองตัวหยิบแถวเดียวกัน */
    claimId?: string;
  };

  counters: { milestones: number; formSubmits: number };

  firstInteractionAt: Date | null; // วันแอดเพื่อน
  firstMessageAt?: Date | null; // วันทักครั้งแรก — ไม่มี field = ยังไม่เคยทัก (docs/02)
  lastInteractionAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  schemaVersion: number;
}

export interface IdentityDoc {
  _id: string; // idn_<ULID>
  customerId: string;
  provider: IdentityProvider;
  channelId: string;
  externalId: string;
  verified: boolean;
  meta: Record<string, unknown>;
  linkedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerProfileDoc {
  _id: string; // prf_<ULID>
  customerId: string;
  revision: number;
  formId: string;
  formVersion: string;
  answers: Record<string, unknown>;
  submittedVia: "liff" | "manual" | "import";
  idempotencyKey: string;
  clientMeta: Record<string, unknown>;
  createdAt: Date;
}

export type InteractionType =
  | "follow"
  | "unfollow"
  | "first_message"
  | "form_submit"
  | "profile_update"
  | "merge";

export interface InteractionDoc {
  _id: ObjectId;
  customerId: string;
  type: InteractionType;
  channel: string;
  occurredAt: Date;
  sourceEventId: string | null;
  payload: Record<string, unknown>; // ⚠️ ห้ามใส่ข้อความลูกค้า (D4)
  createdAt: Date;
}

export type InboundEventStatus = "pending" | "processing" | "done" | "failed" | "dead";

export interface InboundEventDoc {
  _id: ObjectId;
  eventId: string;
  provider: string;
  /** LINE: webhook body.destination — เป็นส่วนหนึ่งของ identity key (D22) */
  channelId: string | null;
  status: InboundEventStatus;
  attempts: number;
  nextAttemptAt: Date;
  raw: Record<string, unknown>; // redact ข้อความก่อน insert แล้ว (D4)
  lastError: string | null;
  receivedAt: Date;
  processedAt: Date | null;
  /** ตีตราตอนจองงาน — กัน worker สองตัวหยิบชิ้นเดียวกัน */
  claimId?: string;
  claimedAt?: Date;
}

export interface AuditLogDoc {
  _id: ObjectId;
  actor: string;
  action: string;
  customerId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  at: Date;
}
