import { ObjectId, type Db } from "mongodb";
import { COLLECTIONS, AI_COLLECTIONS, type AuditLogDoc, type CustomerDoc, type CustomerLinkDoc } from "../db/models";
import { getClient, getDb } from "../db/client";
import { LEGACY_COLLECTIONS, type LegacyEnrollmentDoc, type LegacyPaymentDoc, type LegacyPersonDoc } from "../legacy/models";
import { normalizeEmail, normalizePhone } from "../identity/normalize";
import { eraseCustomer } from "../partner/erase";
import { intakePartnerEvents } from "../partner/intake";
import { recomputeIntentCurrent } from "../partner/intents";
import type { CustomerIntentDoc, PartnerEventDoc, PartnerEventResult, PurchaseDoc } from "../partner/models";

export interface PendingMergeReviewItem {
  customer: CustomerDoc;
  candidate: CustomerDoc;
  evidence: { phoneMatch: boolean; emailMatch: boolean; reason: string };
}

export interface CustomerLinkReviewItem {
  link: CustomerLinkDoc;
  customer: CustomerDoc | null;
  legacyPerson: LegacyPersonDoc | null;
  payments: LegacyPaymentDoc[];
  enrollments: LegacyEnrollmentDoc[];
  legacyAvailable: boolean;
}

export interface PartnerReviewCandidate {
  customerId: string;
  displayName: string | null;
  phone: string | null;
  email: string | null;
  matchedBy: Array<"phone" | "email" | "name">;
}

export interface PartnerReviewItem {
  event: PartnerEventDoc;
  candidates: PartnerReviewCandidate[];
}

export async function listPendingMergeReviews(db: Db): Promise<PendingMergeReviewItem[]> {
  const customers = db.collection<CustomerDoc>(COLLECTIONS.customers);
  const waiting = await customers.find(
    { status: "active", pendingMerge: { $ne: null } },
    { sort: { "pendingMerge.at": 1 }, limit: 200 }
  ).toArray();
  const candidateIds = [...new Set(waiting.map((row) => row.pendingMerge?.candidateId).filter((id): id is string => Boolean(id)))];
  const candidates = candidateIds.length
    ? await customers.find({ _id: { $in: candidateIds } }).toArray()
    : [];
  const byId = new Map(candidates.map((row) => [row._id, row]));
  return waiting.flatMap((customer) => {
    const pending = customer.pendingMerge;
    const candidate = pending ? byId.get(pending.candidateId) : null;
    if (!pending || !candidate) return [];
    return [{
      customer,
      candidate,
      evidence: {
        phoneMatch: Boolean(customer.phone && customer.phone === candidate.phone),
        emailMatch: Boolean(customer.email && customer.email === candidate.email),
        reason: pending.reason,
      },
    }];
  });
}

export async function listCustomerLinkReviews(
  mainDb: Db,
  aiDb: Db,
  legacyDb: Db | null
): Promise<CustomerLinkReviewItem[]> {
  const links = await aiDb.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks)
    .find({ status: "needs_review" }, { sort: { updatedAt: 1 }, limit: 200 }).toArray();
  const customerIds = [...new Set(links.map((row) => row.customerId))];
  const customers = customerIds.length
    ? await mainDb.collection<CustomerDoc>(COLLECTIONS.customers).find({ _id: { $in: customerIds } }).toArray()
    : [];
  const customerById = new Map(customers.map((row) => [row._id, row]));

  if (!legacyDb) {
    return links.map((link) => ({
      link,
      customer: customerById.get(link.customerId) ?? null,
      legacyPerson: null,
      payments: [],
      enrollments: [],
      legacyAvailable: false,
    }));
  }

  const personIds = [...new Set(links.map((row) => row.legacyPersonId))];
  const [people, payments, enrollments] = await Promise.all([
    legacyDb.collection<LegacyPersonDoc>(LEGACY_COLLECTIONS.persons).find({ _id: { $in: personIds } }).toArray(),
    legacyDb.collection<LegacyPaymentDoc>(LEGACY_COLLECTIONS.payments).find({ personId: { $in: personIds } }).sort({ paidAt: -1 }).toArray(),
    legacyDb.collection<LegacyEnrollmentDoc>(LEGACY_COLLECTIONS.enrollments).find({ personId: { $in: personIds } }).sort({ sessionStart: -1 }).toArray(),
  ]);
  const personById = new Map(people.map((row) => [row._id, row]));
  return links.map((link) => ({
    link,
    customer: customerById.get(link.customerId) ?? null,
    legacyPerson: personById.get(link.legacyPersonId) ?? null,
    payments: payments.filter((row) => row.personId === link.legacyPersonId),
    enrollments: enrollments.filter((row) => row.personId === link.legacyPersonId),
    legacyAvailable: personById.has(link.legacyPersonId),
  }));
}

export async function decideCustomerLink(input: {
  mainDb: Db;
  aiDb: Db;
  linkId: string;
  decision: "confirmed" | "rejected";
  actor: string;
  reason?: string | null;
  now?: Date;
}): Promise<void> {
  const now = input.now ?? new Date();
  const links = input.aiDb.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks);
  const previous = await links.findOne({ _id: input.linkId, status: "needs_review" });
  if (!previous) throw new Error("customer_link_changed");

  const changed = await links.updateOne(
    { _id: previous._id, status: "needs_review" },
    { $set: { status: input.decision, decidedBy: "staff", decidedAt: now, updatedAt: now } }
  );
  if (changed.modifiedCount !== 1) throw new Error("customer_link_changed");

  try {
    await input.mainDb.collection<AuditLogDoc>(COLLECTIONS.auditLogs).insertOne({
      _id: new ObjectId(),
      actor: input.actor,
      action: `customer_link.${input.decision}`,
      customerId: previous.customerId,
      before: { linkId: previous._id, status: previous.status, legacyPersonId: previous.legacyPersonId },
      after: { linkId: previous._id, status: input.decision, legacyPersonId: previous.legacyPersonId },
      reason: input.reason?.trim() || null,
      at: now,
    });
  } catch (error) {
    await links.updateOne(
      { _id: previous._id, status: input.decision, decidedAt: now },
      { $set: { status: previous.status, decidedBy: previous.decidedBy, decidedAt: previous.decidedAt, updatedAt: previous.updatedAt } }
    );
    throw error;
  }
}

async function partnerCandidates(db: Db, event: PartnerEventDoc): Promise<PartnerReviewCandidate[]> {
  const rawSubject = event.raw.subject;
  if (!rawSubject || typeof rawSubject !== "object" || Array.isArray(rawSubject)) return [];
  const subject = rawSubject as Record<string, unknown>;
  const phone = normalizePhone(typeof subject.phone === "string" ? subject.phone : null);
  const email = normalizeEmail(typeof subject.email === "string" ? subject.email : null);
  const fullName = typeof subject.fullName === "string" ? subject.fullName.trim() : "";
  const clauses = [...(phone ? [{ phone }] : []), ...(email ? [{ email }] : []), ...(fullName ? [{ displayName: fullName }] : [])];
  if (clauses.length === 0) return [];
  const rows = await db.collection<CustomerDoc>(COLLECTIONS.customers)
    .find({ status: "active", $or: clauses }, { limit: 20 }).toArray();
  return rows.map((row) => ({
    customerId: row._id,
    displayName: row.displayName,
    phone: row.phone,
    email: row.email,
    matchedBy: [
      ...(phone && row.phone === phone ? ["phone" as const] : []),
      ...(email && row.email === email ? ["email" as const] : []),
      ...(fullName && row.displayName === fullName ? ["name" as const] : []),
    ],
  }));
}

export async function listPartnerReviews(db: Db): Promise<PartnerReviewItem[]> {
  const events = await db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).find(
    { status: { $in: ["quarantined", "pending_identity"] } },
    { sort: { receivedAt: 1 }, limit: 200 }
  ).toArray();
  return Promise.all(events.map(async (event) => ({ event, candidates: await partnerCandidates(db, event) })));
}

export interface PartnerCorrection {
  purchaseLines?: Array<{ index: number; courseCode?: string | null; courseLabel?: string | null }>;
  intent?: { courseCode?: string | null; status?: string; hesitationReason?: string | null };
  voids?: string;
}

export async function correctPartnerEvent(input: {
  partnerId: string;
  eventId: string;
  correction: PartnerCorrection;
  actor: string;
  reason?: string | null;
}): Promise<PartnerEventResult> {
  const db = await getDb();
  const event = await db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).findOne({
    partnerId: input.partnerId,
    eventId: input.eventId,
    status: "quarantined",
  });
  if (!event) throw new Error("partner_event_changed");
  if (event.type === "tag") throw new Error("unsupported_tag_requires_reject");

  const corrected = structuredClone(event.raw) as Record<string, unknown>;
  corrected.eventId = event.eventId;
  corrected.type = event.type;
  corrected.revision = event.revision + 1;

  if (event.type === "purchase" && input.correction.purchaseLines) {
    const payment = corrected.payment;
    if (!payment || typeof payment !== "object" || Array.isArray(payment)) throw new Error("invalid_purchase_payload");
    const lines = (payment as Record<string, unknown>).lines;
    if (!Array.isArray(lines)) throw new Error("invalid_purchase_lines");
    for (const change of input.correction.purchaseLines) {
      const line = lines[change.index];
      if (!line || typeof line !== "object" || Array.isArray(line)) throw new Error("invalid_purchase_line");
      if (change.courseCode !== undefined) (line as Record<string, unknown>).courseCode = change.courseCode || null;
      if (change.courseLabel !== undefined) (line as Record<string, unknown>).courseLabel = change.courseLabel;
    }
  }
  if (event.type === "intent" && input.correction.intent) {
    const intent = corrected.intent;
    if (!intent || typeof intent !== "object" || Array.isArray(intent)) throw new Error("invalid_intent_payload");
    if (input.correction.intent.courseCode !== undefined) (intent as Record<string, unknown>).courseCode = input.correction.intent.courseCode || null;
    if (input.correction.intent.status !== undefined) (intent as Record<string, unknown>).status = input.correction.intent.status;
    if (input.correction.intent.hesitationReason !== undefined) {
      (intent as Record<string, unknown>).hesitationReason = input.correction.intent.hesitationReason || null;
    }
  }
  if ((event.type === "purchase.void" || event.type === "intent.void") && input.correction.voids !== undefined) {
    corrected.voids = input.correction.voids.trim();
  }

  const audit: AuditLogDoc = {
    _id: new ObjectId(),
    actor: input.actor,
    action: "partner_event.correction_requested",
    customerId: event.customerId,
    before: { partnerId: event.partnerId, eventId: event.eventId, revision: event.revision, reason: event.reason },
    after: { requestedRevision: event.revision + 1 },
    reason: input.reason?.trim() || null,
    at: new Date(),
  };
  await db.collection<AuditLogDoc>(COLLECTIONS.auditLogs).insertOne(audit);
  const report = await intakePartnerEvents(event.partnerId, [corrected]);
  const result = report.results[0]!;
  await db.collection<AuditLogDoc>(COLLECTIONS.auditLogs).updateOne(
    { _id: audit._id },
    { $set: { action: "partner_event.corrected", after: { revision: event.revision + 1, status: result.status, reason: result.reason ?? null } } }
  );
  return result;
}

export async function rejectPartnerEvent(input: {
  partnerId: string;
  eventId: string;
  actor: string;
  reason?: string | null;
  now?: Date;
}): Promise<void> {
  const db = await getDb();
  const client = await getClient();
  const session = client.startSession();
  const now = input.now ?? new Date();
  try {
    await session.withTransaction(async () => {
      const event = await db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).findOne({
        partnerId: input.partnerId,
        eventId: input.eventId,
        status: { $in: ["quarantined", "pending_identity"] },
      }, { session });
      if (!event) throw new Error("partner_event_changed");
      const updated = await db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).updateOne(
        { _id: event._id, status: event.status },
        { $set: { status: "rejected", reason: "staff_rejected" } },
        { session }
      );
      if (updated.modifiedCount !== 1) throw new Error("partner_event_changed");
      await db.collection<AuditLogDoc>(COLLECTIONS.auditLogs).insertOne({
        _id: new ObjectId(), actor: input.actor, action: "partner_event.rejected", customerId: event.customerId,
        before: { partnerId: event.partnerId, eventId: event.eventId, status: event.status, reason: event.reason },
        after: { status: "rejected" }, reason: input.reason?.trim() || null, at: now,
      }, { session });
    });
  } finally {
    await session.endSession();
  }
}

export async function assignPartnerIdentity(input: {
  partnerId: string;
  eventId: string;
  customerId: string;
  actor: string;
  reason?: string | null;
  now?: Date;
}): Promise<void> {
  const db = await getDb();
  const client = await getClient();
  const session = client.startSession();
  const now = input.now ?? new Date();
  try {
    await session.withTransaction(async () => {
      const [event, customer] = await Promise.all([
        db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).findOne(
          { partnerId: input.partnerId, eventId: input.eventId, status: "pending_identity" }, { session }
        ),
        db.collection<CustomerDoc>(COLLECTIONS.customers).findOne(
          { _id: input.customerId, status: "active" }, { session }
        ),
      ]);
      if (!event || !customer) throw new Error("partner_identity_changed");

      if (event.type === "erase") {
        const rawErase = event.raw.erase;
        const eraseReason = rawErase && typeof rawErase === "object" && !Array.isArray(rawErase)
          ? String((rawErase as Record<string, unknown>).reason ?? "customer_request")
          : "customer_request";
        await eraseCustomer(db, customer._id, eraseReason, now, session);
      } else {
        const purchaseRows = await db.collection<PurchaseDoc>(COLLECTIONS.purchases)
          .find({ partnerId: event.partnerId, sourceEventId: event.eventId }, { session }).toArray();
        for (const purchase of purchaseRows) {
          await db.collection<PurchaseDoc>(COLLECTIONS.purchases).updateOne(
            { _id: purchase._id, customerId: null },
            { $set: { customerId: customer._id, updatedAt: now, "aiSync.dirty": true, "aiSync.lockedAt": null } },
            { session }
          );
          await db.collection(COLLECTIONS.purchaseItems).updateMany(
            { purchaseId: purchase._id, customerId: null }, { $set: { customerId: customer._id } }, { session }
          );
        }
        const intents = await db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents)
          .find({ partnerId: event.partnerId, sourceEventId: event.eventId }, { session }).toArray();
        for (const intent of intents) {
          await db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents).updateOne(
            { _id: intent._id, customerId: null },
            { $set: { customerId: customer._id, updatedAt: now, "aiSync.dirty": true, "aiSync.lockedAt": null } },
            { session }
          );
          await recomputeIntentCurrent(db, customer._id, intent.courseCode, now, session);
        }
      }

      await db.collection<PartnerEventDoc>(COLLECTIONS.partnerEvents).updateOne(
        { _id: event._id, status: "pending_identity" },
        { $set: { customerId: customer._id, status: "accepted", reason: "staff_confirmed" } },
        { session }
      );
      await db.collection<AuditLogDoc>(COLLECTIONS.auditLogs).insertOne({
        _id: new ObjectId(), actor: input.actor, action: "partner_event.identity_confirmed", customerId: customer._id,
        before: { partnerId: event.partnerId, eventId: event.eventId, status: event.status },
        after: { status: "accepted", customerId: customer._id }, reason: input.reason?.trim() || null, at: now,
      }, { session });
    });
  } finally {
    await session.endSession();
  }
}
