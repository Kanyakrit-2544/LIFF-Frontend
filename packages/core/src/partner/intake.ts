import type { ClientSession, Db } from "mongodb";
import { getClient, getDb } from "../db/client";
import { COLLECTIONS } from "../db/models";
import { newId } from "../ids";
import { courseByCode, courseByHeader, type CourseDef } from "../legacy/courses";
import { enrollmentCountsAsSeat } from "../legacy/courseCell";
import { log } from "../logger";
import { resolvePartnerSubject, type PartnerIdentityResult } from "./identity";
import { intentRejectionReason, recomputeIntentCurrent } from "./intents";
import {
  PARTNER_SCHEMA_VERSION,
  type CustomerIntentDoc,
  type PartnerEventDoc,
  type PartnerEventResult,
  type PartnerQuarantineDoc,
  type PurchaseDoc,
  type PurchaseItemDoc,
} from "./models";
import { parsePartnerEvent, type ParsedPartnerEvent, type ParsedPurchaseLine } from "./schema";
import { reconcilePartnerIdentities } from "./reconcile";

const MAX_WRITE_RETRIES = 4;

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number }).code === 11000;
}

function eventStatus(identity: PartnerIdentityResult): { status: "accepted" | "pending_identity"; reason: string | null } {
  if (identity.customerId) return { status: "accepted", reason: identity.evidence };
  return { status: "pending_identity", reason: identity.ambiguous ? "ambiguous_identity" : "identity_not_found" };
}

function canonicalCourse(line: ParsedPurchaseLine): { course: CourseDef; line: ParsedPurchaseLine } | { reason: string } {
  const byCode = line.courseCode ? courseByCode(line.courseCode.trim().toUpperCase()) : null;
  if (line.courseCode && !byCode) return { reason: `unknown_course_code:${line.courseCode}` };
  const byLabel = courseByHeader(line.courseLabel);
  if (byCode && byLabel && byCode.code !== byLabel.code) return { reason: `course_mismatch:${line.courseCode}:${line.courseLabel}` };
  const course = byCode ?? byLabel;
  if (!course) return { reason: `unknown_course:${line.courseLabel}` };
  return { course, line: { ...line, courseCode: course.code } };
}

function canonicalIntentCourse(code: string | null): CourseDef | null | "unknown" {
  if (code === null) return null;
  return courseByCode(code.trim().toUpperCase()) ?? "unknown";
}

function dateOnly(value: string | null): Date | null {
  return value ? new Date(`${value}T00:00:00.000Z`) : null;
}

function sourceYearMonth(event: ParsedPartnerEvent): { year: number; month: number | null } {
  if (event.payment?.paidAt) {
    return { year: Number(event.payment.paidAt.slice(0, 4)), month: Number(event.payment.paidAt.slice(5, 7)) };
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "numeric",
  }).formatToParts(event.occurredAt);
  const part = (type: string) => Number(parts.find((item) => item.type === type)?.value);
  return { year: part("year"), month: part("month") || null };
}

function partnerEventDoc(
  existing: PartnerEventDoc | null,
  partnerId: string,
  event: Pick<ParsedPartnerEvent, "eventId" | "revision" | "type" | "occurredAt" | "raw">,
  state: { status: PartnerEventDoc["status"]; reason: string | null; customerId: string | null; purchaseId: string | null },
  now: Date
): PartnerEventDoc {
  return {
    _id: existing?._id ?? newId("partnerEvent"),
    partnerId,
    eventId: event.eventId,
    revision: event.revision,
    type: event.type,
    occurredAt: event.occurredAt,
    receivedAt: existing?.receivedAt ?? now,
    ...state,
    raw: event.raw,
    schemaVersion: PARTNER_SCHEMA_VERSION,
  };
}

async function replacePartnerEvent(db: Db, doc: PartnerEventDoc, session: ClientSession): Promise<void> {
  await db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).replaceOne(
    { partnerId: doc.partnerId, eventId: doc.eventId },
    doc,
    { upsert: true, session }
  );
}

async function storeQuarantine(
  db: Db,
  partnerId: string,
  parsed: Extract<ReturnType<typeof parsePartnerEvent>, { ok: false; status: "quarantined" }>
): Promise<PartnerEventResult> {
  if (!parsed.raw || !parsed.meta) return { eventId: parsed.eventId, status: "rejected", reason: "invalid_quarantine_payload" };
  const client = await getClient();
  for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
    const session = client.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const events = db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents);
        const existing = await events.findOne({ partnerId, eventId: parsed.eventId }, { session });
        if (existing && existing.revision >= parsed.meta!.revision) {
          return { eventId: parsed.eventId, status: "duplicate" as const };
        }
        if (existing && existing.type !== parsed.meta!.type) {
          return { eventId: parsed.eventId, status: "rejected" as const, reason: "revision_type_change" };
        }
        const now = new Date();
        await replacePartnerEvent(db, partnerEventDoc(existing, partnerId, {
          eventId: parsed.eventId,
          revision: parsed.meta!.revision,
          type: parsed.meta!.type,
          occurredAt: parsed.meta!.occurredAt,
          raw: parsed.raw!,
        }, {
          status: "quarantined", reason: parsed.reason,
          customerId: existing?.customerId ?? null, purchaseId: existing?.purchaseId ?? null,
        }, now), session);
        const existingQuarantine = await db.collection<PartnerQuarantineDoc>(COLLECTIONS.partnerQuarantine)
          .findOne({ partnerId, eventId: parsed.eventId }, { session });
        const quarantine: PartnerQuarantineDoc = {
          _id: existingQuarantine?._id ?? newId("quarantine"),
          partnerId,
          eventId: parsed.eventId,
          revision: parsed.meta!.revision,
          reason: parsed.reason,
          raw: parsed.raw!,
          createdAt: existingQuarantine?.createdAt ?? now,
          updatedAt: now,
          schemaVersion: PARTNER_SCHEMA_VERSION,
        };
        await db.collection<PartnerQuarantineDoc>(COLLECTIONS.partnerQuarantine).replaceOne(
          { partnerId, eventId: parsed.eventId },
          quarantine,
          { upsert: true, session }
        );
        return { eventId: parsed.eventId, status: "quarantined" as const, reason: parsed.reason };
      });
      return result!;
    } catch (error) {
      if (!isDuplicateKey(error) || attempt === MAX_WRITE_RETRIES - 1) throw error;
    } finally {
      await session.endSession();
    }
  }
  throw new Error("quarantine retry เกินกำหนด");
}

async function processPurchase(
  db: Db,
  partnerId: string,
  event: ParsedPartnerEvent,
  identity: PartnerIdentityResult,
  lines: { course: CourseDef; line: ParsedPurchaseLine }[],
  session: ClientSession,
  existingEvent: PartnerEventDoc | null,
  now: Date
): Promise<PartnerEventResult> {
  const purchases = db.collection<PurchaseDoc>(COLLECTIONS.purchases);
  const purchaseItems = db.collection<PurchaseItemDoc>(COLLECTIONS.purchaseItems);
  const existingPurchase = existingEvent?.purchaseId
    ? await purchases.findOne({ _id: existingEvent.purchaseId }, { session })
    : await purchases.findOne({ partnerId, sourceEventId: event.eventId }, { session });
  if (existingPurchase && identity.customerId !== null && existingPurchase.customerId !== identity.customerId) {
    return { eventId: event.eventId, status: "rejected", reason: "revision_identity_change" };
  }

  const purchaseId = existingPurchase?._id ?? newId("purchase");
  const customerId = existingPurchase?.customerId ?? identity.customerId;
  const ym = sourceYearMonth(event);
  const payment = event.payment!;
  const purchase: PurchaseDoc = {
    _id: purchaseId,
    customerId,
    partnerId,
    externalPaymentId: payment.externalPaymentId,
    amount: payment.amount,
    currency: payment.currency,
    paidAt: dateOnly(payment.paidAt),
    year: ym.year,
    month: ym.month,
    saleRep: payment.saleRep,
    attribution: event.attribution,
    status: existingPurchase?.status ?? "active",
    sourceEventId: event.eventId,
    aiSync: { dirty: true, syncedAt: existingPurchase?.aiSync.syncedAt ?? null, lockedAt: null, attempts: 0 },
    createdAt: existingPurchase?.createdAt ?? now,
    updatedAt: now,
    schemaVersion: PARTNER_SCHEMA_VERSION,
  };
  await purchases.replaceOne({ _id: purchaseId }, purchase, { upsert: true, session });
  await purchaseItems.deleteMany({ purchaseId }, { session });
  const items: PurchaseItemDoc[] = lines.map(({ course, line }) => ({
    _id: newId("purchaseItem"), purchaseId, customerId,
    courseCode: course.code, courseLabel: line.courseLabel, kind: line.kind,
    countsAsSeat: enrollmentCountsAsSeat(line.kind) && !course.nonCourse,
    sessionLabel: line.sessionLabel, sessionStart: dateOnly(line.sessionStart),
    sessionYear: line.sessionStart ? Number(line.sessionStart.slice(0, 4)) : null,
    createdAt: now, schemaVersion: PARTNER_SCHEMA_VERSION,
  }));
  if (items.length > 0) await purchaseItems.insertMany(items, { session });

  const state = eventStatus({ ...identity, customerId });
  await replacePartnerEvent(db, partnerEventDoc(existingEvent, partnerId, event, {
    ...state, customerId, purchaseId,
  }, now), session);
  await db.collection(COLLECTIONS.partnerQuarantine).deleteOne({ partnerId, eventId: event.eventId }, { session });
  return { eventId: event.eventId, status: state.status, ...(state.reason ? { reason: state.reason } : {}) };
}

async function processIntent(
  db: Db,
  partnerId: string,
  event: ParsedPartnerEvent,
  identity: PartnerIdentityResult,
  courseCode: string | null,
  session: ClientSession,
  existingEvent: PartnerEventDoc | null,
  now: Date
): Promise<PartnerEventResult> {
  const intents = db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents);
  const existing = await intents.findOne({ partnerId, sourceEventId: event.eventId }, { session });
  const customerId = existing?.customerId ?? identity.customerId;
  if (existing && identity.customerId !== null && existing.customerId !== identity.customerId) {
    return { eventId: event.eventId, status: "rejected", reason: "revision_identity_change" };
  }
  if (existing && existing.courseCode !== courseCode) {
    return { eventId: event.eventId, status: "rejected", reason: "revision_course_change" };
  }

  const value = event.intent!;
  const draft: CustomerIntentDoc = {
    _id: existing?._id ?? newId("intent"), customerId, courseCode,
    status: value.status, hesitationReason: value.hesitationReason,
    confidence: value.confidence, belowThreshold: value.source === "ai" && value.confidence < 0.6,
    source: value.source, lock: value.lock, model: value.model,
    observedAt: event.occurredAt, supersededAt: existing?.supersededAt ?? null,
    voidedAt: existing?.voidedAt ?? null,
    partnerId, sourceEventId: event.eventId,
    aiSync: { dirty: true, syncedAt: existing?.aiSync.syncedAt ?? null, lockedAt: null, attempts: 0 },
    createdAt: existing?.createdAt ?? now, updatedAt: now, schemaVersion: PARTNER_SCHEMA_VERSION,
  };
  const rejection = await intentRejectionReason(db, draft, existing?.sourceEventId, session);
  if (rejection) return { eventId: event.eventId, status: "rejected", reason: rejection };

  await intents.replaceOne({ _id: draft._id }, draft, { upsert: true, session });
  if (customerId) await recomputeIntentCurrent(db, customerId, courseCode, now, session);
  const state = eventStatus({ ...identity, customerId });
  await replacePartnerEvent(db, partnerEventDoc(existingEvent, partnerId, event, {
    ...state, customerId, purchaseId: null,
  }, now), session);
  await db.collection(COLLECTIONS.partnerQuarantine).deleteOne({ partnerId, eventId: event.eventId }, { session });
  return { eventId: event.eventId, status: state.status, ...(state.reason ? { reason: state.reason } : {}) };
}

async function processVoid(
  db: Db,
  partnerId: string,
  event: ParsedPartnerEvent,
  session: ClientSession,
  existingEvent: PartnerEventDoc | null,
  now: Date
): Promise<PartnerEventResult> {
  const target = await db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).findOne(
    { partnerId, eventId: event.voids! },
    { session }
  );
  const expected = event.type === "purchase.void" ? "purchase" : "intent";
  if (!target || target.type !== expected) {
    return { eventId: event.eventId, status: "quarantined", reason: "void_target_not_found" };
  }

  if (event.type === "purchase.void") {
    if (!target.purchaseId) return { eventId: event.eventId, status: "quarantined", reason: "void_target_not_found" };
    await db.collection<PurchaseDoc>(COLLECTIONS.purchases).updateOne(
      { _id: target.purchaseId },
      { $set: { status: "voided", updatedAt: now, "aiSync.dirty": true, "aiSync.lockedAt": null } },
      { session }
    );
  } else {
    const intent = await db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents).findOne(
      { partnerId, sourceEventId: target.eventId }, { session }
    );
    if (!intent) return { eventId: event.eventId, status: "quarantined", reason: "void_target_not_found" };
    await db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents).updateOne(
      { _id: intent._id },
      { $set: { voidedAt: now, supersededAt: intent.supersededAt ?? now, updatedAt: now, "aiSync.dirty": true, "aiSync.lockedAt": null } },
      { session }
    );
    if (intent.customerId) await recomputeIntentCurrent(db, intent.customerId, intent.courseCode, now, session);
  }

  await db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).updateOne(
    { _id: target._id },
    { $set: { status: "voided", reason: null } },
    { session }
  );
  await replacePartnerEvent(db, partnerEventDoc(existingEvent, partnerId, event, {
    status: "accepted", reason: null, customerId: target.customerId, purchaseId: target.purchaseId,
  }, now), session);
  return { eventId: event.eventId, status: "accepted" };
}

async function processAccepted(db: Db, partnerId: string, event: ParsedPartnerEvent): Promise<PartnerEventResult> {
  let identity: PartnerIdentityResult = { customerId: null, evidence: null, ambiguous: false, created: false };
  if (event.subject) identity = await resolvePartnerSubject(db, event.subject, { createMissingLine: Boolean(event.subject.lineUserId) });

  const lines: { course: CourseDef; line: ParsedPurchaseLine }[] = [];
  if (event.payment) {
    for (const line of event.payment.lines) {
      const canonical = canonicalCourse(line);
      if ("reason" in canonical) {
        return storeQuarantine(db, partnerId, {
          ok: false, eventId: event.eventId, status: "quarantined", reason: canonical.reason,
          raw: event.raw, meta: { type: event.type, occurredAt: event.occurredAt, revision: event.revision },
        } as const);
      }
      lines.push(canonical);
    }
  }
  const intentCourse = event.intent ? canonicalIntentCourse(event.intent.courseCode) : null;
  if (intentCourse === "unknown") {
    return storeQuarantine(db, partnerId, {
      ok: false, eventId: event.eventId, status: "quarantined", reason: `unknown_course_code:${event.intent!.courseCode}`,
      raw: event.raw, meta: { type: event.type, occurredAt: event.occurredAt, revision: event.revision },
    } as const);
  }

  const client = await getClient();
  for (let attempt = 0; attempt < MAX_WRITE_RETRIES; attempt++) {
    const session = client.startSession();
    try {
      const result = await session.withTransaction(async () => {
        const existing = await db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).findOne(
          { partnerId, eventId: event.eventId }, { session }
        );
        if (existing && existing.revision >= event.revision) return { eventId: event.eventId, status: "duplicate" as const };
        if (existing && existing.type !== event.type) return { eventId: event.eventId, status: "rejected" as const, reason: "revision_type_change" };
        const now = new Date();
        if (event.type === "purchase") return processPurchase(db, partnerId, event, identity, lines, session, existing, now);
        if (event.type === "intent") {
          return processIntent(db, partnerId, event, identity, intentCourse ? intentCourse.code : null, session, existing, now);
        }
        const voidResult = await processVoid(db, partnerId, event, session, existing, now);
        if (voidResult.status === "quarantined") throw Object.assign(new Error(voidResult.reason), { quarantine: voidResult });
        return voidResult;
      });
      return result!;
    } catch (error) {
      const q = (error as { quarantine?: PartnerEventResult }).quarantine;
      if (q) {
        return storeQuarantine(db, partnerId, {
          ok: false, eventId: event.eventId, status: "quarantined", reason: q.reason!, raw: event.raw,
          meta: { type: event.type, occurredAt: event.occurredAt, revision: event.revision },
        } as const);
      }
      if (!isDuplicateKey(error) || attempt === MAX_WRITE_RETRIES - 1) throw error;
    } finally {
      await session.endSession();
    }
  }
  throw new Error("partner intake retry เกินกำหนด");
}

export interface PartnerIntakeReport {
  summary: { accepted: number; duplicate: number; quarantined: number; rejected: number; pendingIdentity: number };
  results: PartnerEventResult[];
}

export async function intakePartnerEvents(partnerId: string, inputs: readonly unknown[]): Promise<PartnerIntakeReport> {
  const db = await getDb();
  const parsed = inputs.map(parsePartnerEvent);
  const results = await Promise.all(parsed.map(async (item) => {
    if (!item.ok) {
      if (item.status === "quarantined") return storeQuarantine(db, partnerId, item);
      return { eventId: item.eventId, status: "rejected" as const, reason: item.reason };
    }
    return processAccepted(db, partnerId, item.event);
  }));

  if (parsed.some((item) => item.ok && Boolean(item.event.subject?.lineUserId))) {
    await reconcilePartnerIdentities(db).catch((error) => {
      log.warn("partner reconciliation หลัง intake ไม่สำเร็จ — สคริปต์จะเก็บรอบถัดไป", { error: (error as Error).message });
    });
  }

  return {
    summary: {
      accepted: results.filter((item) => item.status === "accepted").length,
      duplicate: results.filter((item) => item.status === "duplicate").length,
      quarantined: results.filter((item) => item.status === "quarantined").length,
      rejected: results.filter((item) => item.status === "rejected").length,
      pendingIdentity: results.filter((item) => item.status === "pending_identity").length,
    },
    results,
  };
}
