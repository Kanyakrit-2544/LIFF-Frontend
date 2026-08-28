import type { AnyBulkWriteOperation, Db, Document, Filter } from "mongodb";
import { nameKeys } from "../ai/tokens";
import { AI_COLLECTIONS, type CustomerLinkDoc } from "../db/models";
import type { MatchCustomerRow, MatchLegacyRow } from "./candidates";

export interface PlantReport {
  total: number;
  phone: number;
  family: number;
  email: number;
  name: number;
  noMatch: number;
}

const id = (kind: string, index: number) => `cus_PLANT_${kind}_${String(index + 1).padStart(3, "0")}`;

function ageBirthYear(age: string | null | undefined, now: Date): number | null {
  const start = Number(age?.split("-")[0]);
  return Number.isInteger(start) ? now.getFullYear() + 543 - (start + 5) : null;
}

function baseCustomer(customerId: string, legacy: MatchLegacyRow | null, now: Date): MatchCustomerRow & Document {
  return {
    _id: customerId,
    customerId,
    status: "active",
    phone: null,
    email: null,
    phoneHash: null,
    emailHash: null,
    nameKeys: [],
    nicknameKey: null,
    birthYear: legacy ? ageBirthYear(legacy.ageBand, now) : null,
    firstInteractionAt: now.toISOString().slice(0, 10),
    formSubmittedAt: now.toISOString().slice(0, 10),
    courseCodes: [],
  };
}

export async function unplantMatchFixtures(db: Db): Promise<{ customers: number; links: number }> {
  const links = await db.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks)
    .deleteMany({ customerId: { $regex: "^cus_PLANT_" } } as Filter<CustomerLinkDoc>);
  const customers = await db.collection<MatchCustomerRow & Document>(AI_COLLECTIONS.customersScrubbed).deleteMany({
    $or: [{ _id: { $regex: "^cus_PLANT_" } }, { customerId: { $regex: "^cus_PLANT_" } }],
  } as Filter<MatchCustomerRow & Document>);
  return { customers: customers.deletedCount, links: links.deletedCount };
}

export async function plantMatchFixtures(db: Db, total: number, now = new Date()): Promise<PlantReport> {
  if (!Number.isInteger(total) || total < 8) throw new Error("--plant ต้องอย่างน้อย 8 เพื่อให้มี fixture ครบทุกกรณี");
  await unplantMatchFixtures(db);
  const legacy = await db.collection<MatchLegacyRow>(AI_COLLECTIONS.legacyPersonsScrubbed)
    .find({}, { sort: { _id: 1 } }).toArray();
  if (legacy.length < total) throw new Error(`legacy_persons_scrubbed มีเพียง ${legacy.length} คน ไม่พอปลูก ${total}`);

  const family = 3;
  const bucket = Math.max(1, Math.floor((total - family) / 5));
  const email = bucket;
  const name = bucket;
  const noMatch = bucket;
  const phone = total - family - email - name - noMatch;
  const used = new Set<string>();
  const take = (predicate: (row: MatchLegacyRow) => boolean): MatchLegacyRow => {
    const row = legacy.find((item) => !used.has(item._id) && predicate(item));
    if (!row) throw new Error("ข้อมูล legacy scrubbed ไม่มี fixture ที่มีคุณสมบัติพอ");
    used.add(row._id);
    return row;
  };

  const phoneCounts = new Map<string, number>();
  const emailCounts = new Map<string, number>();
  const nameSignatures = new Map<string, number>();
  for (const row of legacy) {
    if (row.phoneHash) phoneCounts.set(row.phoneHash, (phoneCounts.get(row.phoneHash) ?? 0) + 1);
    if (row.emailHash) emailCounts.set(row.emailHash, (emailCounts.get(row.emailHash) ?? 0) + 1);
    const signature = `${(row.nameKeys ?? []).join(",")}|${row.nicknameKey ?? ""}`;
    nameSignatures.set(signature, (nameSignatures.get(signature) ?? 0) + 1);
  }
  const hasUniqueNameRuleMatch = (row: MatchLegacyRow): boolean => {
    if (!row.nicknameKey || (row.nameKeys?.length ?? 0) < 2) return false;
    const own = new Set(row.nameKeys);
    return legacy.filter((other) => {
      if (other.nicknameKey !== row.nicknameKey) return false;
      return [...new Set(other.nameKeys ?? [])].filter((key) => own.has(key)).length >= 2;
    }).length === 1;
  };

  const docs: Array<MatchCustomerRow & Document> = [];
  const familyLegacy = take((row) => Boolean(row.phoneHash && phoneCounts.get(row.phoneHash) === 1));
  for (let index = 0; index < family; index++) {
    const doc = baseCustomer(id("FAMILY", index), familyLegacy, now);
    doc.phone = familyLegacy.phone ?? null;
    doc.phoneHash = familyLegacy.phoneHash ?? null;
    doc.nameKeys = nameKeys(`Fixture Family ${index}`);
    docs.push(doc);
  }

  for (let index = 0; index < phone; index++) {
    const row = take((item) => Boolean(item.phoneHash && phoneCounts.get(item.phoneHash) === 1));
    const doc = baseCustomer(id("PHONE", index), row, now);
    doc.phone = row.phone ?? null;
    doc.phoneHash = row.phoneHash ?? null;
    docs.push(doc);
  }
  for (let index = 0; index < email; index++) {
    const row = take((item) => Boolean(item.emailHash && emailCounts.get(item.emailHash) === 1));
    const doc = baseCustomer(id("EMAIL", index), row, now);
    doc.email = row.email ?? null;
    doc.emailHash = row.emailHash ?? null;
    docs.push(doc);
  }
  for (let index = 0; index < name; index++) {
    const row = take((item) => {
      const signature = `${(item.nameKeys ?? []).join(",")}|${item.nicknameKey ?? ""}`;
      return nameSignatures.get(signature) === 1 && hasUniqueNameRuleMatch(item);
    });
    const doc = baseCustomer(id("NAME", index), row, now);
    doc.nameKeys = [...(row.nameKeys ?? [])];
    doc.nicknameKey = row.nicknameKey ?? null;
    docs.push(doc);
  }
  for (let index = 0; index < noMatch; index++) {
    const doc = baseCustomer(id("NOMATCH", index), null, now);
    doc.nameKeys = nameKeys(`Fixture Unmatched ${index}`);
    docs.push(doc);
  }

  const operations: AnyBulkWriteOperation<MatchCustomerRow & Document>[] = docs.map((doc) => ({
    replaceOne: { filter: { _id: doc._id } as Filter<MatchCustomerRow & Document>, replacement: doc, upsert: true },
  }));
  await db.collection<MatchCustomerRow & Document>(AI_COLLECTIONS.customersScrubbed).bulkWrite(operations, { ordered: false });
  return { total, phone, family, email, name, noMatch };
}
