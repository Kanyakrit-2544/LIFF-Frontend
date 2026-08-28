import type { Collection, Db } from "mongodb";
import { COLLECTIONS, type CustomerDoc, type IdentityDoc } from "../db/models";
import { normalizeEmail, normalizePhone } from "../identity/normalize";
import { resolveCustomer } from "../identity/resolve";
import { partnerLineChannelId } from "./auth";
import type { PartnerSubject } from "./models";

export interface PartnerIdentityResult {
  customerId: string | null;
  evidence: "line" | "phone_only" | "email_only" | null;
  ambiguous: boolean;
  created: boolean;
}

async function activeCustomerId(customers: Collection<CustomerDoc>, initial: string): Promise<string | null> {
  let id = initial;
  for (let i = 0; i < 5; i++) {
    const customer = await customers.findOne({ _id: id }, { projection: { status: 1, mergedInto: 1 } });
    if (!customer) return null;
    if (customer.status !== "merged" || !customer.mergedInto) return id;
    id = customer.mergedInto;
  }
  return null;
}

async function uniqueCustomerBy(
  customers: Collection<CustomerDoc>,
  field: "phone" | "email",
  value: string
): Promise<{ id: string | null; ambiguous: boolean }> {
  const rows = await customers.find({ [field]: value, status: "active" }, { projection: { _id: 1 }, limit: 2 }).toArray();
  return rows.length === 1 ? { id: rows[0]!._id, ambiguous: false } : { id: null, ambiguous: rows.length > 1 };
}

export async function resolvePartnerSubject(
  db: Db,
  subject: PartnerSubject,
  options: { createMissingLine?: boolean } = {}
): Promise<PartnerIdentityResult> {
  const customers = db.collection<CustomerDoc>(COLLECTIONS.customers);
  const identities = db.collection<IdentityDoc>(COLLECTIONS.identities);

  if (subject.lineUserId) {
    const identity = await identities.findOne(
      { externalId: subject.lineUserId, provider: { $in: ["line", "line_login"] } },
      { sort: { linkedAt: 1 } }
    );
    if (identity) {
      return {
        customerId: await activeCustomerId(customers, identity.customerId),
        evidence: "line",
        ambiguous: false,
        created: false,
      };
    }
    if (options.createMissingLine) {
      const resolved = await resolveCustomer({
        provider: "line",
        channelId: partnerLineChannelId(),
        externalId: subject.lineUserId,
        verified: true,
        meta: { source: "partner_intake" },
        create: { sourceChannel: "partner" },
      });
      return { customerId: resolved.customerId, evidence: "line", ambiguous: false, created: resolved.isNew };
    }
  }

  const phone = normalizePhone(subject.phone);
  if (phone) {
    const match = await uniqueCustomerBy(customers, "phone", phone);
    if (match.id || match.ambiguous) {
      return { customerId: match.id, evidence: match.id ? "phone_only" : null, ambiguous: match.ambiguous, created: false };
    }
  }

  const email = normalizeEmail(subject.email);
  if (email) {
    const match = await uniqueCustomerBy(customers, "email", email);
    if (match.id || match.ambiguous) {
      return { customerId: match.id, evidence: match.id ? "email_only" : null, ambiguous: match.ambiguous, created: false };
    }
  }

  return { customerId: null, evidence: null, ambiguous: false, created: false };
}

