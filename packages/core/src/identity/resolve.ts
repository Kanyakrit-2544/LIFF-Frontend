import { type ClientSession, type Collection, type Db } from "mongodb";
import { getClient, getDb } from "../db/client";
import { COLLECTIONS, type CustomerDoc, type IdentityDoc, type IdentityProvider } from "../db/models";
import { newCustomerId, newIdentityId } from "../ids";

export interface ResolveHints {
  phone?: string | null;
  email?: string | null;
}

export interface CustomerCreateInput {
  now?: Date;
  firstInteractionAt?: Date;
  lastInteractionAt?: Date;
  displayName?: string | null;
  lineDisplayName?: string | null;
  pictureUrl?: string | null;
  sourceChannel?: string;
  tags?: string[];
}

export interface ResolveCustomerInput {
  provider: IdentityProvider;
  channelId: string;
  externalId: string;
  verified?: boolean;
  meta?: Record<string, unknown>;
  hints?: ResolveHints;
  create?: CustomerCreateInput;
}

export interface ResolveCustomerResult {
  customerId: string;
  isNew: boolean;
  linked: boolean;
}

async function collections(db: Db) {
  return {
    customers: db.collection<CustomerDoc>(COLLECTIONS.customers),
    identities: db.collection<IdentityDoc>(COLLECTIONS.identities),
  };
}

async function activeCustomerId(customers: Collection<CustomerDoc>, customerId: string): Promise<string> {
  let id = customerId;
  for (let i = 0; i < 5; i++) {
    const doc = await customers.findOne({ _id: id }, { projection: { status: 1, mergedInto: 1 } });
    if (!doc) return id;
    if (doc.status !== "merged" || !doc.mergedInto) return id;
    id = doc.mergedInto;
  }
  return id;
}

function buildNewCustomer(customerId: string, input: ResolveCustomerInput): CustomerDoc {
  const now = input.create?.now ?? new Date();
  const firstInteractionAt = input.create?.firstInteractionAt ?? now;
  const lastInteractionAt = input.create?.lastInteractionAt ?? firstInteractionAt;
  const sourceChannel = input.create?.sourceChannel ?? input.provider;
  const tags = [...new Set(input.create?.tags ?? [])];

  return {
    _id: customerId,
    status: "active",
    mergedInto: null,
    displayName: input.create?.displayName ?? null,
    nickname: null,
    fullNameEn: null,
    birthYear: null,
    lineDisplayName: input.create?.lineDisplayName ?? null,
    pictureUrl: input.create?.pictureUrl ?? null,
    facebook: null,
    instagram: null,
    phone: null,
    email: null,
    customerStatus: "lead",
    tags,
    source: { channel: sourceChannel, campaign: null },
    sources: [sourceChannel],
    consent: null,
    profileRef: null,
    pendingMerge: null,
    sheetSync: { dirty: true, rowKey: customerId, syncedAt: null, lockedAt: null, attempts: 0 },
    aiSync: { dirty: true, syncedAt: null, lockedAt: null, attempts: 0 },
    counters: { milestones: 0, formSubmits: 0 },
    firstInteractionAt,
    lastInteractionAt,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1,
  };
}

async function findByHints(customers: Collection<CustomerDoc>, hints?: ResolveHints): Promise<string | null> {
  const phone = hints?.phone ?? null;
  if (phone) {
    const byPhone = await customers.findOne({ phone, status: "active" }, { projection: { _id: 1 } });
    if (byPhone) return byPhone._id;
  }

  const email = hints?.email ?? null;
  if (email) {
    const byEmail = await customers.findOne({ email, status: "active" }, { projection: { _id: 1 } });
    if (byEmail) return byEmail._id;
  }

  return null;
}

async function linkIdentity(
  identities: Collection<IdentityDoc>,
  input: ResolveCustomerInput,
  customerId: string,
  now: Date,
  session?: ClientSession
) {
  await identities.insertOne(
    {
      _id: newIdentityId(),
      customerId,
      provider: input.provider,
      channelId: input.channelId,
      externalId: input.externalId,
      verified: input.verified ?? true,
      meta: input.meta ?? {},
      linkedAt: now,
      createdAt: now,
      updatedAt: now,
    },
    { session }
  );
}

function isDuplicateKey(e: unknown): boolean {
  return (e as { code?: number }).code === 11000;
}

export async function resolveCustomer(input: ResolveCustomerInput, depth = 0): Promise<ResolveCustomerResult> {
  // retry เกิดจาก duplicate key ตอนแข่งกันสร้าง ซึ่งรอบถัดไปต้องเจอ identity แล้ว
  // ถ้ายังวนอยู่แปลว่ามีอย่างอื่นผิด — หยุดดีกว่าวนไม่รู้จบจน function timeout
  if (depth > 3) throw new Error("resolveCustomer: retry เกินกำหนด");
  const db = await getDb();
  const { customers, identities } = await collections(db);

  const identity = await identities.findOne({
    provider: input.provider,
    channelId: input.channelId,
    externalId: input.externalId,
  });
  if (identity) {
    const customerId = await activeCustomerId(customers, identity.customerId);
    if (customerId !== identity.customerId) {
      await identities.updateOne({ _id: identity._id }, { $set: { customerId, updatedAt: new Date() } });
    }
    return { customerId, isNew: false, linked: false };
  }

  const hintedCustomerId = await findByHints(customers, input.hints);
  if (hintedCustomerId) {
    const now = input.create?.now ?? new Date();
    try {
      await linkIdentity(identities, input, hintedCustomerId, now);
      return { customerId: hintedCustomerId, isNew: false, linked: true };
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      return resolveCustomer(input, depth + 1);
    }
  }

  const client = await getClient();
  const session = client.startSession();
  const now = input.create?.now ?? new Date();
  const customerId = newCustomerId();
  try {
    await session.withTransaction(async () => {
      await customers.insertOne(buildNewCustomer(customerId, { ...input, create: { ...input.create, now } }), { session });
      await linkIdentity(identities, input, customerId, now, session);
    });
    return { customerId, isNew: true, linked: false };
  } catch (e) {
    if (!isDuplicateKey(e)) throw e;
    return resolveCustomer(input, depth + 1);
  } finally {
    await session.endSession();
  }
}
