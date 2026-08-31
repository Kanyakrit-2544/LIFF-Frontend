import { z } from "zod";
import type { EnrollmentKind } from "../legacy/courseCell";
import type { HesitationReason, IntentStatus, PartnerAttribution, PartnerEventType, PartnerSubject } from "./models";

const FORBIDDEN_KEYS = new Set(["quote", "evidence", "snippet", "summary", "customerId"]);
const HAS_TIMEZONE = /(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const PARTNER_KINDS = new Set<EnrollmentKind>(["enrolled", "relearn", "free", "waitlist", "transfer", "refund", "merchandise"]);
const INTENT_STATUSES = new Set<IntentStatus>(["interested", "not_interested", "hesitant", "unknown"]);
const HESITATION_REASONS = new Set<HesitationReason>(["budget", "not_needed", "timing_conflict", "not_ready", "needs_approval", "unknown"]);

function hasForbiddenKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasForbiddenKey);
  return Object.entries(value as Record<string, unknown>).some(([key, child]) => FORBIDDEN_KEYS.has(key) || hasForbiddenKey(child));
}

function validDateOnly(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const text = (max = 300) => z.string().trim().min(1).max(max);
const nullableText = (max = 300) => text(max).nullable().optional();

const subjectSchema = z.object({
  lineUserId: nullableText(200),
  phone: nullableText(100),
  email: nullableText(320),
  fullName: nullableText(300),
}).strict().refine((value) => Boolean(value.lineUserId || value.phone || value.email || value.fullName), "subject ต้องมีข้อมูลอย่างน้อย 1 อย่าง");

const lineSchema = z.object({
  courseLabel: text(200),
  courseCode: nullableText(50),
  sessionLabel: nullableText(300),
  sessionStart: z.string().refine(validDateOnly, "sessionStart ต้องเป็น YYYY-MM-DD").nullable().optional(),
  kind: text(40),
  /** Accepted only to prove that the receiver ignores this partner-controlled value. */
  countsAsSeat: z.boolean().optional(),
}).strict();

const paymentSchema = z.object({
  externalPaymentId: nullableText(200),
  amount: z.number().finite().nonnegative().nullable(),
  currency: z.string().trim().regex(/^[A-Z]{3}$/),
  paidAt: z.string().refine(validDateOnly, "paidAt ต้องเป็น YYYY-MM-DD").nullable(),
  saleRep: nullableText(100),
  lines: z.array(lineSchema).min(1).max(100),
}).strict();

const intentSchema = z.object({
  courseCode: nullableText(50),
  status: text(60),
  hesitationReason: nullableText(80),
  confidence: z.number().finite().min(0).max(1),
  source: z.enum(["ai", "staff"]),
  model: nullableText(200),
  lock: z.enum(["soft", "sticky"]).optional(),
}).strict();

const attributionSchema = z.object({
  source: nullableText(80),
  adOrOrganic: nullableText(40),
  campaignId: nullableText(200),
  contentRef: nullableText(300),
}).strict();

/** คำขอลบข้อมูลส่วนบุคคล (PDPA) — ดู partner/erase.ts */
const eraseSchema = z.object({
  reason: z.enum(["customer_request", "legal_request", "other"]).default("customer_request"),
  requestedAt: z.string().optional(),
}).strict();

const eventSchema = z.object({
  eventId: text(240),
  type: text(40),
  occurredAt: z.string().refine((value) => HAS_TIMEZONE.test(value) && !Number.isNaN(new Date(value).getTime()), "occurredAt ต้องเป็น ISO 8601 พร้อม timezone"),
  revision: z.number().int().positive().default(1),
  subject: subjectSchema.optional(),
  payment: paymentSchema.optional(),
  intent: intentSchema.optional(),
  voids: text(240).optional(),
  tags: z.array(text(100)).max(100).optional(),
  attribution: attributionSchema.optional(),
  erase: eraseSchema.optional(),
}).strict();

export interface ParsedPurchaseLine {
  courseLabel: string;
  courseCode: string | null;
  sessionLabel: string | null;
  sessionStart: string | null;
  kind: EnrollmentKind;
}

export interface ParsedPartnerEvent {
  eventId: string;
  type: PartnerEventType;
  occurredAt: Date;
  revision: number;
  subject: PartnerSubject | null;
  payment: {
    externalPaymentId: string | null;
    amount: number | null;
    currency: string;
    paidAt: string | null;
    saleRep: string | null;
    lines: ParsedPurchaseLine[];
  } | null;
  intent: {
    courseCode: string | null;
    status: IntentStatus;
    hesitationReason: HesitationReason | null;
    confidence: number;
    source: "ai" | "staff";
    model: string | null;
    lock: "soft" | "sticky";
  } | null;
  voids: string | null;
  erase: { reason: string; requestedAt: string | null } | null;
  attribution: PartnerAttribution | null;
  raw: Record<string, unknown>;
}

export type PartnerParseResult =
  | { ok: true; event: ParsedPartnerEvent }
  | { ok: false; eventId: string; status: "rejected"; reason: string }
  | { ok: false; eventId: string; status: "quarantined"; reason: string; raw: Record<string, unknown>; meta: { type: PartnerEventType; occurredAt: Date; revision: number } };

function nullish(value: string | null | undefined): string | null {
  return value ?? null;
}

export function parsePartnerEvent(input: unknown): PartnerParseResult {
  const eventId = input && typeof input === "object" && typeof (input as Record<string, unknown>).eventId === "string"
    ? (input as Record<string, unknown>).eventId as string
    : "unknown";
  if (hasForbiddenKey(input)) return { ok: false, eventId, status: "rejected", reason: "forbidden_chat_field" };

  const parsed = eventSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, eventId, status: "rejected", reason: `invalid_schema:${parsed.error.issues[0]?.path.join(".") || "event"}` };
  }

  const value = parsed.data;
  const raw = input as Record<string, unknown>;
  const occurredAt = new Date(value.occurredAt);
  const meta = { type: value.type as PartnerEventType, occurredAt, revision: value.revision };

  if (value.type === "tag" || value.tags !== undefined) {
    return { ok: false, eventId: value.eventId, status: "quarantined", reason: "unsupported_type:tag", raw, meta: { ...meta, type: "tag" } };
  }
  if (value.type === "erase" && !value.subject) {
    return { ok: false, eventId: value.eventId, status: "rejected", reason: "erase_requires_subject" };
  }
  if (!["purchase", "purchase.void", "intent", "intent.void", "erase"].includes(value.type)) {
    return { ok: false, eventId: value.eventId, status: "rejected", reason: `unsupported_type:${value.type}` };
  }

  if ((value.type === "purchase" || value.type === "intent") && !value.subject) {
    return { ok: false, eventId: value.eventId, status: "rejected", reason: "subject_required" };
  }
  if (value.type === "purchase" && !value.payment) {
    return { ok: false, eventId: value.eventId, status: "rejected", reason: "payment_required" };
  }
  if (value.type === "intent" && !value.intent) {
    return { ok: false, eventId: value.eventId, status: "rejected", reason: "intent_required" };
  }
  if ((value.type === "purchase.void" || value.type === "intent.void") && !value.voids) {
    return { ok: false, eventId: value.eventId, status: "rejected", reason: "voids_required" };
  }

  if (value.intent) {
    if (!INTENT_STATUSES.has(value.intent.status as IntentStatus)) {
      return { ok: false, eventId: value.eventId, status: "quarantined", reason: `unknown_intent_status:${value.intent.status}`, raw, meta };
    }
    if (value.intent.hesitationReason && !HESITATION_REASONS.has(value.intent.hesitationReason as HesitationReason)) {
      return { ok: false, eventId: value.eventId, status: "quarantined", reason: `unknown_hesitation_reason:${value.intent.hesitationReason}`, raw, meta };
    }
    if (value.intent.status !== "hesitant" && value.intent.hesitationReason) {
      return { ok: false, eventId: value.eventId, status: "rejected", reason: "hesitation_reason_without_hesitant" };
    }
    if (value.intent.source === "ai" && !value.intent.model) {
      return { ok: false, eventId: value.eventId, status: "rejected", reason: "ai_model_required" };
    }
    if (value.intent.source === "ai" && value.intent.lock !== undefined) {
      return { ok: false, eventId: value.eventId, status: "rejected", reason: "ai_lock_forbidden" };
    }
  }

  if (value.payment) {
    const badKind = value.payment.lines.find((line) => !PARTNER_KINDS.has(line.kind as EnrollmentKind));
    if (badKind) return { ok: false, eventId: value.eventId, status: "rejected", reason: `unsupported_kind:${badKind.kind}` };
  }

  return {
    ok: true,
    event: {
      eventId: value.eventId,
      type: value.type as ParsedPartnerEvent["type"],
      occurredAt,
      revision: value.revision,
      subject: value.subject ? {
        lineUserId: nullish(value.subject.lineUserId),
        phone: nullish(value.subject.phone),
        email: nullish(value.subject.email),
        fullName: nullish(value.subject.fullName),
      } : null,
      payment: value.payment ? {
        externalPaymentId: nullish(value.payment.externalPaymentId),
        amount: value.payment.amount,
        currency: value.payment.currency,
        paidAt: value.payment.paidAt,
        saleRep: nullish(value.payment.saleRep),
        lines: value.payment.lines.map((line) => ({
          courseLabel: line.courseLabel,
          courseCode: nullish(line.courseCode),
          sessionLabel: nullish(line.sessionLabel),
          sessionStart: nullish(line.sessionStart),
          kind: line.kind as EnrollmentKind,
        })),
      } : null,
      intent: value.intent ? {
        courseCode: nullish(value.intent.courseCode),
        status: value.intent.status as IntentStatus,
        hesitationReason: value.intent.status === "hesitant"
          ? (value.intent.hesitationReason as HesitationReason | null | undefined) ?? "unknown"
          : null,
        confidence: value.intent.source === "staff" ? 1 : value.intent.confidence,
        source: value.intent.source,
        model: value.intent.source === "staff" ? null : nullish(value.intent.model),
        lock: value.intent.source === "staff" ? value.intent.lock ?? "soft" : "soft",
      } : null,
      voids: value.voids ?? null,
      erase: value.erase ? { reason: value.erase.reason, requestedAt: value.erase.requestedAt ?? null } : null,
      attribution: value.attribution ? {
        source: nullish(value.attribution.source),
        adOrOrganic: nullish(value.attribution.adOrOrganic),
        campaignId: nullish(value.attribution.campaignId),
        contentRef: nullish(value.attribution.contentRef),
      } : null,
      raw,
    },
  };
}
