import type { ObjectId } from "mongodb";

/** ชื่อ collection รวมไว้ที่เดียว — พิมพ์ผิดจะพังตอน compile ไม่ใช่ตอน runtime */
export const COLLECTIONS = {
  customers: "customers",
  identities: "identities",
  customerProfiles: "customer_profiles",
  formSchemas: "form_schemas",
  interactions: "interactions",
  inboundEvents: "inbound_events",
  integrations: "integrations",
  piiTokens: "pii_tokens",
  auditLogs: "audit_logs",
} as const;

export type EncryptedField = { hash: string; enc: string; masked: string };

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

export interface CustomerDoc {
  _id: string; // cus_<ULID>
  status: RecordStatus;
  mergedInto: string | null;

  displayName: string | null;
  nickname: string | null;
  fullNameEn: string | null;
  birthYear: number | null; // พ.ศ. (D16)
  lineDisplayName: string | null;
  pictureUrl: string | null;
  facebook: string | null;
  instagram: string | null;

  phone: EncryptedField | null;
  email: EncryptedField | null;
  phoneHash: string | null; // ยกออกมาระดับบนสุดเพื่อทำ index (sparse)
  emailHash: string | null;

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

  sheetSync: {
    dirty: boolean;
    rowKey: string;
    syncedAt: Date | null;
    lockedAt: Date | null;
    attempts: number;
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

export interface PiiTokenDoc {
  _id: string; // "<TH_PHONE_a3f9>"
  jobId: string;
  type: string;
  category: string;
  valueEnc: string; // ⚠️ ไม่เก็บ plaintext (docs/09 §9.4)
  customerId: string | null;
  createdAt: Date;
  expiresAt: Date;
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
