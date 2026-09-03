import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MongoClient, type Db, type Document } from "mongodb";
import {
  AI_COLLECTIONS,
  COLLECTIONS,
  METRICS,
  analyticsQuerySchema,
  buildCustomerLinks,
  ensureAiIndexes,
  ensureIndexes,
  listCustomerLinkReviews,
  listPartnerReviews,
  listPendingMergeReviews,
  listSalesOpportunities,
  listSalesReport,
  runAnalytics,
  scrubCustomer,
  scrubPartnerToAi,
  type CustomerDoc,
  type CustomerIntentDoc,
  type CustomerLinkDoc,
  type PartnerEventDoc,
  type PurchaseDoc,
  type PurchaseItemDoc,
} from "../packages/core/src/index";
import { importLegacyRows, type ImportLegacySheetInput } from "../packages/core/src/legacy/importReal";
import { ensureLegacyIndexes } from "../packages/core/src/legacy/indexes";
import {
  LEGACY_COLLECTIONS,
  type LegacyEnrollmentDoc,
  type LegacyImportRunDoc,
  type LegacyPaymentDoc,
  type LegacyPersonDoc,
} from "../packages/core/src/legacy/models";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PROJECT_PYTHON = fileURLToPath(new URL("../.venv/bin/python", import.meta.url));
const LEGACY_FILE = "raw input/Inner.xlsx";
const LEGACY_SHEETS = "Inner2025,Inner2026";
const MAIN_DB = "line_crm_dev";
const AI_DB = "line_crm_ai";
const LEGACY_DB = "line_crm_legacy";
const SEED_TAG = "local-demo";
const PARTNER_ID = "local-demo";
const LEGACY_RUN_ID = "job_LOCAL_REAL";

interface SeedTagMeta {
  seedTag: typeof SEED_TAG;
}

interface SeedMeta extends SeedTagMeta {
  synthetic: true;
}

interface ExtractOutput {
  source: string;
  sheets: ImportLegacySheetInput[];
}

function arg(name: string, fallback?: string): string | undefined {
  const equals = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (equals) return equals.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1]!.startsWith("--")) {
    return process.argv[index + 1];
  }
  return fallback;
}

function positiveIntArg(name: string, fallback: number): number {
  const value = Number(arg(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${name} ต้องเป็นจำนวนเต็มบวก`);
  return value;
}

export function assertLocalMongoUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("URI ของ seed:local ไม่ถูกต้อง");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!(["localhost", "127.0.0.1", "::1"] as const).includes(host as never)) {
    throw new Error("seed:local ปฏิเสธ URI ที่ไม่ใช่ localhost เพื่อป้องกันการเขียนทับ Atlas");
  }
  if (parsed.searchParams.get("directConnection") !== "true") {
    throw new Error("URI local ต้องมี /?directConnection=true");
  }
}

function customerId(index: number): string {
  return `cus_LOCAL_${String(index + 1).padStart(3, "0")}`;
}

function localPhone(index: number): string {
  return `+6691${String(index + 1).padStart(7, "0")}`;
}

async function replaceMany<T extends Document & { _id: string }>(db: Db, name: string, docs: T[]): Promise<void> {
  if (docs.length === 0) return;
  await db.collection<T>(name).bulkWrite(docs.map((doc) => ({
    replaceOne: { filter: { _id: doc._id }, replacement: doc, upsert: true },
  })) as never[], { ordered: false });
}

async function cleanSeed(mainDb: Db, aiDb: Db, legacyDb: Db): Promise<void> {
  const ids = Array.from({ length: 40 }, (_, index) => customerId(index));
  const [purchases, oldPeople, oldPayments, oldEnrollments] = await Promise.all([
    mainDb.collection<PurchaseDoc>(COLLECTIONS.purchases)
      .find({ partnerId: PARTNER_ID }, { projection: { _id: 1 } }).toArray(),
    legacyDb.collection<LegacyPersonDoc & SeedTagMeta>(LEGACY_COLLECTIONS.persons)
      .find({ $or: [{ seedTag: SEED_TAG }, { _id: { $regex: "^lgp_LOCAL_" } }] }, { projection: { _id: 1 } }).toArray(),
    legacyDb.collection<LegacyPaymentDoc & SeedTagMeta>(LEGACY_COLLECTIONS.payments)
      .find({ $or: [{ seedTag: SEED_TAG }, { _id: { $regex: "^lgy_LOCAL_" } }] }, { projection: { _id: 1 } }).toArray(),
    legacyDb.collection<LegacyEnrollmentDoc & SeedTagMeta>(LEGACY_COLLECTIONS.enrollments)
      .find({ $or: [{ seedTag: SEED_TAG }, { _id: { $regex: "^lge_LOCAL_" } }] }, { projection: { _id: 1 } }).toArray(),
  ]);
  const purchaseIds = purchases.map((row) => row._id);
  const oldPersonIds = oldPeople.map((row) => row._id);
  const oldPaymentIds = oldPayments.map((row) => row._id);
  const oldEnrollmentIds = oldEnrollments.map((row) => row._id);

  await Promise.all([
    mainDb.collection(COLLECTIONS.interactions).deleteMany({ customerId: { $in: ids } }),
    mainDb.collection(COLLECTIONS.customerProfiles).deleteMany({ customerId: { $in: ids } }),
    mainDb.collection(COLLECTIONS.identities).deleteMany({ customerId: { $in: ids } }),
    mainDb.collection(COLLECTIONS.auditLogs).deleteMany({ customerId: { $in: ids } }),
    mainDb.collection(COLLECTIONS.staffReviewDecisions).deleteMany({ customerIds: { $in: ids } }),
    mainDb.collection(COLLECTIONS.recommendationReviews).deleteMany({ seedTag: SEED_TAG }),
    mainDb.collection(COLLECTIONS.partnerEvents).deleteMany({ partnerId: PARTNER_ID }),
    mainDb.collection(COLLECTIONS.partnerQuarantine).deleteMany({ partnerId: PARTNER_ID }),
    mainDb.collection(COLLECTIONS.customerIntents).deleteMany({ partnerId: PARTNER_ID }),
    mainDb.collection(COLLECTIONS.purchaseItems).deleteMany({ purchaseId: { $in: purchaseIds } }),
    mainDb.collection(COLLECTIONS.purchases).deleteMany({ partnerId: PARTNER_ID }),
    mainDb.collection<CustomerDoc>(COLLECTIONS.customers).deleteMany({ _id: { $in: ids } }),
    aiDb.collection(AI_COLLECTIONS.customerLinks).deleteMany({
      $or: [{ customerId: { $in: ids } }, { legacyPersonId: { $in: oldPersonIds } }],
    }),
    aiDb.collection<{ _id: string }>(AI_COLLECTIONS.customersScrubbed).deleteMany({ _id: { $in: ids } }),
    aiDb.collection(AI_COLLECTIONS.purchasesScrubbed).deleteMany({ partnerId: PARTNER_ID }),
    aiDb.collection<{ _id: string }>(AI_COLLECTIONS.purchaseItemsScrubbed).deleteMany({ _id: { $regex: "^pit_LOCAL_" } }),
    aiDb.collection(AI_COLLECTIONS.customerIntentsScrubbed).deleteMany({ partnerId: PARTNER_ID }),
    aiDb.collection<{ _id: string }>(AI_COLLECTIONS.legacyPersonsScrubbed).deleteMany({
      $or: [{ _id: { $in: oldPersonIds } }, { _id: { $regex: "^lgp_LOCAL_" } }],
    }),
    aiDb.collection<{ _id: string }>(AI_COLLECTIONS.legacyPaymentsScrubbed).deleteMany({
      $or: [{ _id: { $in: oldPaymentIds } }, { _id: { $regex: "^lgy_LOCAL_" } }],
    }),
    aiDb.collection<{ _id: string }>(AI_COLLECTIONS.legacyEnrollmentsScrubbed).deleteMany({
      $or: [{ _id: { $in: oldEnrollmentIds } }, { _id: { $regex: "^lge_LOCAL_" } }],
    }),
    legacyDb.collection<LegacyEnrollmentDoc & SeedTagMeta>(LEGACY_COLLECTIONS.enrollments).deleteMany({
      $or: [{ seedTag: SEED_TAG }, { _id: { $regex: "^lge_LOCAL_" } }],
    }),
    legacyDb.collection<LegacyPaymentDoc & SeedTagMeta>(LEGACY_COLLECTIONS.payments).deleteMany({
      $or: [{ seedTag: SEED_TAG }, { _id: { $regex: "^lgy_LOCAL_" } }],
    }),
    legacyDb.collection<LegacyPersonDoc & SeedTagMeta>(LEGACY_COLLECTIONS.persons).deleteMany({
      $or: [{ seedTag: SEED_TAG }, { _id: { $regex: "^lgp_LOCAL_" } }],
    }),
    legacyDb.collection<LegacyImportRunDoc & SeedTagMeta>(LEGACY_COLLECTIONS.importRuns).deleteMany({
      $or: [{ seedTag: SEED_TAG }, { _id: { $in: ["job_LOCAL_DEMO", LEGACY_RUN_ID] } }],
    }),
  ]);
}

async function seedLegacy(legacyDb: Db, now: Date, limit: number): Promise<LegacyPersonDoc[]> {
  const python = arg("python", process.env.PYTHON) ?? (existsSync(PROJECT_PYTHON) ? PROJECT_PYTHON : "python3");
  const raw = execFileSync(python, [
    "scripts/legacy/extract_rows.py", LEGACY_FILE, LEGACY_SHEETS, "--limit", String(limit),
  ], { cwd: ROOT, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  const extracted = JSON.parse(raw) as ExtractOutput;
  const imported = importLegacyRows({ sheets: extracted.sheets, importRunId: LEGACY_RUN_ID, now });
  const meta: SeedTagMeta = { seedTag: SEED_TAG };
  const persons = imported.persons.map((row) => ({ ...row, ...meta }));
  const payments = imported.payments.map((row) => ({ ...row, ...meta }));
  const enrollments = imported.enrollments.map((row) => ({ ...row, ...meta }));
  if (persons.length === 0) throw new Error("ไม่พบ legacy person จาก Inner.xlsx ในช่วงแถวที่เลือก");

  await replaceMany<LegacyPersonDoc & SeedTagMeta>(legacyDb, LEGACY_COLLECTIONS.persons, persons);
  await replaceMany<LegacyPaymentDoc & SeedTagMeta>(legacyDb, LEGACY_COLLECTIONS.payments, payments);
  await replaceMany<LegacyEnrollmentDoc & SeedTagMeta>(legacyDb, LEGACY_COLLECTIONS.enrollments, enrollments);
  const run: LegacyImportRunDoc & SeedTagMeta = {
    _id: LEGACY_RUN_ID,
    mode: "real",
    sheets: extracted.sheets.map((sheet) => sheet.sheet),
    startedAt: now,
    finishedAt: now,
    counts: {
      rows: imported.rows,
      persons: persons.length,
      payments: payments.length,
      enrollments: enrollments.length,
      skipped: imported.skipped,
    },
    unknownCourseHeaders: imported.unknownCourseHeaders,
    notes: ["local admin harness", `limit=${limit}`, "ข้อมูล legacy จริง มี PII และอยู่เฉพาะ local"],
    ...meta,
  };
  await replaceMany(legacyDb, LEGACY_COLLECTIONS.importRuns, [run]);
  return persons;
}

async function pickUniquePhonePeople(legacyDb: Db, imported: LegacyPersonDoc[]): Promise<LegacyPersonDoc[]> {
  const unique = await legacyDb.collection<LegacyPersonDoc>(LEGACY_COLLECTIONS.persons).aggregate<{ _id: string }>([
    { $match: { phone: { $type: "string" } } },
    { $group: { _id: "$phone", count: { $sum: 1 } } },
    { $match: { count: 1 } },
    { $project: { _id: 1 } },
  ]).toArray();
  const uniquePhones = new Set(unique.map((row) => row._id));
  const selected = imported.filter((row) => row.phone && uniquePhones.has(row.phone)).slice(0, 18);
  if (selected.length < 18) throw new Error("legacy จริงช่วงที่เลือกมีเบอร์ไม่ซ้ำสำหรับทดสอบไม่ถึง 18 คน");
  return selected;
}

function buildCustomers(legacyPeople: LegacyPersonDoc[], now: Date): Array<CustomerDoc & SeedMeta> {
  const matchPeople = legacyPeople.slice(0, 18);
  const channels = ["Facebook", "เพื่อนแนะนำ", "LINE OA", "งานสัมมนา", "Google"];
  const statuses: CustomerDoc["customerStatus"][] = ["lead", "prospect", "customer", "inactive"];
  const pendingPairs = new Map<number, number>([[21, 20], [23, 22], [25, 24]]);

  return Array.from({ length: 40 }, (_, index): CustomerDoc & SeedMeta => {
    const matched = index < 18 ? matchPeople[index] : index === 18 ? matchPeople[16] : index === 19 ? matchPeople[17] : null;
    const pairBase = index >= 20 && index < 26 ? index - (index % 2) : null;
    const erased = index >= 38;
    const phone = matched?.phone ?? (pairBase === null ? localPhone(index) : localPhone(pairBase));
    const email = matched?.email ?? (pairBase === null
      ? `customer${String(index + 1).padStart(2, "0")}@local.example`
      : `merge${String(pairBase + 1).padStart(2, "0")}@local.example`);
    const interactionAt = new Date(now.getTime() - index * 86_400_000);
    const candidateIndex = pendingPairs.get(index);
    return {
      _id: customerId(index),
      status: erased ? "erased" : "active",
      mergedInto: null,
      title: index % 3 === 0 ? "คุณ" : null,
      heardFrom: channels[index % channels.length]!,
      displayName: erased ? null : matched?.fullNameTh ?? `ลูกค้าทดลอง ${String(index + 1).padStart(2, "0")}`,
      nickname: erased ? null : matched?.nickname ?? `Demo ${index + 1}`,
      fullNameEn: erased ? null : matched?.fullNameEn ?? null,
      birthYear: erased ? null : matched?.ageAtImport ? now.getUTCFullYear() + 543 - matched.ageAtImport : 2530 + (index % 12),
      lineDisplayName: erased ? null : `LINE Demo ${index + 1}`,
      pictureUrl: null,
      facebook: null,
      instagram: null,
      phone: erased ? null : phone,
      email: erased ? null : email,
      customerStatus: statuses[index % statuses.length]!,
      tags: ["local-test", matched ? "legacy-real-match" : index % 2 === 0 ? "สนใจคอร์ส" : "ติดตามผล"],
      source: matched
        ? { channel: "legacy_seed", campaign: null }
        : { channel: index % 3 === 0 ? "facebook_lead" : "liff", campaign: index % 3 === 0 ? "local-demo-campaign" : null },
      sources: [matched ? "legacy_seed" : index % 3 === 0 ? "facebook_lead" : "liff"],
      consent: erased ? null : {
        dataProcessing: true,
        marketing: index % 2 === 0,
        version: "local-demo-v1",
        grantedAt: interactionAt,
        ip: null,
        userAgent: null,
      },
      profileRef: erased ? null : { revision: 1, formId: "local-demo", formVersion: "1", updatedAt: interactionAt },
      pendingMerge: candidateIndex === undefined ? null : {
        candidateId: customerId(candidateIndex),
        reason: index % 2 === 0 ? "email_match" : "phone_and_email_match",
        at: interactionAt,
      },
      erasedAt: erased ? now : null,
      eraseReason: erased ? "local demo" : null,
      leadAttribution: index % 3 === 0 ? {
        pageId: "local-page",
        formId: "local-form",
        adId: `local-ad-${index % 2}`,
        courseCode: index % 2 === 0 ? "INNER" : "COMMU",
        campaignName: "Local Demo Campaign",
        adOrOrganic: index % 2 === 0 ? "ad" : "organic",
        attributionPending: false,
        capturedAt: interactionAt,
      } : null,
      sheetSync: { dirty: false, rowKey: customerId(index), syncedAt: now, lockedAt: null, attempts: 0 },
      aiSync: { dirty: false, syncedAt: now, lockedAt: null, attempts: 0 },
      counters: { milestones: index % 4, formSubmits: erased ? 0 : 1 },
      firstInteractionAt: interactionAt,
      firstMessageAt: index % 5 === 0 ? null : new Date(interactionAt.getTime() + 3_600_000),
      lastInteractionAt: interactionAt,
      createdAt: interactionAt,
      updatedAt: now,
      schemaVersion: 1,
      seedTag: SEED_TAG,
      synthetic: true,
    };
  });
}

function buildPartnerData(customers: CustomerDoc[], now: Date) {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const current = new Date(Date.UTC(year, monthIndex, 5, 5));
  const previous = new Date(Date.UTC(year, monthIndex - 1, 15, 5));
  const sync = { dirty: true, syncedAt: null, lockedAt: null, attempts: 0 };
  const meta: SeedMeta = { seedTag: SEED_TAG, synthetic: true };
  const purchases: Array<PurchaseDoc & SeedMeta> = [
    { _id: "pur_LOCAL_001", customerId: customers[0]!._id, partnerId: PARTNER_ID, externalPaymentId: "LOCAL-PAY-001", amount: 33900, currency: "THB", paidAt: current, year, month: monthIndex + 1, saleRep: "พนักงานทดลอง A", attribution: { source: "facebook", adOrOrganic: "ad", campaignId: "local-campaign", contentRef: null }, status: "active", sourceEventId: "local-purchase-001", aiSync: { ...sync }, createdAt: now, updatedAt: now, schemaVersion: 1, ...meta },
    { _id: "pur_LOCAL_002", customerId: customers[0]!._id, partnerId: PARTNER_ID, externalPaymentId: "LOCAL-PAY-002", amount: 17900, currency: "THB", paidAt: previous, year: previous.getUTCFullYear(), month: previous.getUTCMonth() + 1, saleRep: "พนักงานทดลอง B", attribution: { source: "line", adOrOrganic: "organic", campaignId: null, contentRef: null }, status: "active", sourceEventId: "local-purchase-002", aiSync: { ...sync }, createdAt: now, updatedAt: now, schemaVersion: 1, ...meta },
    { _id: "pur_LOCAL_003", customerId: customers[1]!._id, partnerId: PARTNER_ID, externalPaymentId: "LOCAL-PAY-003", amount: 25900, currency: "THB", paidAt: current, year, month: monthIndex + 1, saleRep: "พนักงานทดลอง A", attribution: null, status: "active", sourceEventId: "local-purchase-003", aiSync: { ...sync }, createdAt: now, updatedAt: now, schemaVersion: 1, ...meta },
    { _id: "pur_LOCAL_004", customerId: customers[8]!._id, partnerId: PARTNER_ID, externalPaymentId: "LOCAL-PAY-004", amount: 15900, currency: "THB", paidAt: previous, year: previous.getUTCFullYear(), month: previous.getUTCMonth() + 1, saleRep: "พนักงานทดลอง A", attribution: null, status: "active", sourceEventId: "local-purchase-004", aiSync: { ...sync }, createdAt: now, updatedAt: now, schemaVersion: 1, ...meta },
    { _id: "pur_LOCAL_005", customerId: customers[10]!._id, partnerId: PARTNER_ID, externalPaymentId: "LOCAL-PAY-005", amount: 15900, currency: "THB", paidAt: previous, year: previous.getUTCFullYear(), month: previous.getUTCMonth() + 1, saleRep: "พนักงานทดลอง B", attribution: null, status: "active", sourceEventId: "local-purchase-005", aiSync: { ...sync }, createdAt: now, updatedAt: now, schemaVersion: 1, ...meta },
    { _id: "pur_LOCAL_006", customerId: customers[12]!._id, partnerId: PARTNER_ID, externalPaymentId: "LOCAL-PAY-006", amount: 15900, currency: "THB", paidAt: previous, year: previous.getUTCFullYear(), month: previous.getUTCMonth() + 1, saleRep: "พนักงานทดลอง A", attribution: null, status: "active", sourceEventId: "local-purchase-006", aiSync: { ...sync }, createdAt: now, updatedAt: now, schemaVersion: 1, ...meta },
    { _id: "pur_LOCAL_007", customerId: customers[2]!._id, partnerId: PARTNER_ID, externalPaymentId: "LOCAL-PAY-007", amount: 21900, currency: "THB", paidAt: previous, year: previous.getUTCFullYear(), month: previous.getUTCMonth() + 1, saleRep: "พนักงานทดลอง B", attribution: null, status: "active", sourceEventId: "local-purchase-007", aiSync: { ...sync }, createdAt: now, updatedAt: now, schemaVersion: 1, ...meta },
  ];
  const session = new Date(Date.UTC(year, monthIndex, 20));
  const items: Array<PurchaseItemDoc & SeedMeta> = [
    { _id: "pit_LOCAL_001", purchaseId: purchases[0]!._id, customerId: customers[0]!._id, courseCode: "INNER", courseLabel: "Inner", kind: "enrolled", countsAsSeat: true, sessionLabel: "Local demo", sessionStart: session, sessionYear: year, createdAt: now, schemaVersion: 1, ...meta },
    { _id: "pit_LOCAL_002", purchaseId: purchases[0]!._id, customerId: customers[0]!._id, courseCode: "COMMU", courseLabel: "Commu", kind: "enrolled", countsAsSeat: true, sessionLabel: "Local demo", sessionStart: session, sessionYear: year, createdAt: now, schemaVersion: 1, ...meta },
    { _id: "pit_LOCAL_003", purchaseId: purchases[0]!._id, customerId: customers[0]!._id, courseCode: "PRESENT", courseLabel: "Present", kind: "enrolled", countsAsSeat: true, sessionLabel: "Local demo", sessionStart: session, sessionYear: year, createdAt: now, schemaVersion: 1, ...meta },
    { _id: "pit_LOCAL_004", purchaseId: purchases[1]!._id, customerId: customers[0]!._id, courseCode: "INNER", courseLabel: "Inner", kind: "enrolled", countsAsSeat: true, sessionLabel: "Local demo", sessionStart: previous, sessionYear: previous.getUTCFullYear(), createdAt: now, schemaVersion: 1, ...meta },
    { _id: "pit_LOCAL_005", purchaseId: purchases[2]!._id, customerId: customers[1]!._id, courseCode: "DEEPIN", courseLabel: "Deep In", kind: "enrolled", countsAsSeat: true, sessionLabel: "Local demo", sessionStart: session, sessionYear: year, createdAt: now, schemaVersion: 1, ...meta },
    { _id: "pit_LOCAL_006", purchaseId: purchases[3]!._id, customerId: customers[8]!._id, courseCode: "INNER", courseLabel: "Inner", kind: "enrolled", countsAsSeat: true, sessionLabel: "Local sales demo", sessionStart: previous, sessionYear: previous.getUTCFullYear(), createdAt: now, schemaVersion: 1, ...meta },
    { _id: "pit_LOCAL_007", purchaseId: purchases[4]!._id, customerId: customers[10]!._id, courseCode: "INNER", courseLabel: "Inner", kind: "enrolled", countsAsSeat: true, sessionLabel: "Local sales demo", sessionStart: previous, sessionYear: previous.getUTCFullYear(), createdAt: now, schemaVersion: 1, ...meta },
    { _id: "pit_LOCAL_008", purchaseId: purchases[5]!._id, customerId: customers[12]!._id, courseCode: "INNER", courseLabel: "Inner", kind: "enrolled", countsAsSeat: true, sessionLabel: "Local sales demo", sessionStart: previous, sessionYear: previous.getUTCFullYear(), createdAt: now, schemaVersion: 1, ...meta },
    { _id: "pit_LOCAL_009", purchaseId: purchases[6]!._id, customerId: customers[2]!._id, courseCode: "INNER", courseLabel: "Inner", kind: "enrolled", countsAsSeat: true, sessionLabel: "Local sales returning", sessionStart: previous, sessionYear: previous.getUTCFullYear(), createdAt: now, schemaVersion: 1, ...meta },
  ];
  const intents: Array<CustomerIntentDoc & SeedMeta> = [
    { _id: "int_LOCAL_001", customerId: customers[2]!._id, courseCode: "INNER", status: "interested", hesitationReason: null, confidence: 0.92, belowThreshold: false, source: "ai", lock: "soft", model: "local-demo-hermes", observedAt: now, supersededAt: null, voidedAt: null, partnerId: PARTNER_ID, sourceEventId: "local-intent-001", aiSync: { ...sync }, createdAt: now, updatedAt: now, schemaVersion: 1, ...meta },
    { _id: "int_LOCAL_002", customerId: customers[30]!._id, courseCode: "COMMU", status: "hesitant", hesitationReason: "budget", confidence: 0.86, belowThreshold: false, source: "ai", lock: "soft", model: "local-demo-hermes", observedAt: now, supersededAt: null, voidedAt: null, partnerId: PARTNER_ID, sourceEventId: "local-intent-002", aiSync: { ...sync }, createdAt: now, updatedAt: now, schemaVersion: 1, ...meta },
    { _id: "int_LOCAL_003", customerId: customers[32]!._id, courseCode: "PRESENT", status: "hesitant", hesitationReason: "timing_conflict", confidence: 0.74, belowThreshold: false, source: "ai", lock: "soft", model: "local-demo-hermes", observedAt: new Date(now.getTime() - 60_000), supersededAt: null, voidedAt: null, partnerId: PARTNER_ID, sourceEventId: "local-intent-003", aiSync: { ...sync }, createdAt: now, updatedAt: now, schemaVersion: 1, ...meta },
    { _id: "int_LOCAL_004", customerId: customers[34]!._id, courseCode: "TTRT", status: "hesitant", hesitationReason: null, confidence: 0.62, belowThreshold: false, source: "ai", lock: "soft", model: "local-demo-hermes", observedAt: new Date(now.getTime() - 120_000), supersededAt: null, voidedAt: null, partnerId: PARTNER_ID, sourceEventId: "local-intent-004", aiSync: { ...sync }, createdAt: now, updatedAt: now, schemaVersion: 1, ...meta },
    { _id: "int_LOCAL_005", customerId: customers[3]!._id, courseCode: "INNER", status: "hesitant", hesitationReason: "budget", confidence: 0.91, belowThreshold: false, source: "ai", lock: "soft", model: "local-demo-hermes", observedAt: now, supersededAt: null, voidedAt: null, partnerId: PARTNER_ID, sourceEventId: "local-intent-005", aiSync: { ...sync }, createdAt: now, updatedAt: now, schemaVersion: 1, ...meta },
  ];
  const event = (index: number, status: PartnerEventDoc["status"], customer: CustomerDoc, type: PartnerEventDoc["type"], reason: string): PartnerEventDoc & SeedMeta => ({
    _id: `pev_LOCAL_${String(index).padStart(3, "0")}`,
    partnerId: PARTNER_ID,
    eventId: `local-review-${String(index).padStart(3, "0")}`,
    revision: 1,
    type,
    occurredAt: now,
    receivedAt: new Date(now.getTime() + index * 1_000),
    status,
    reason,
    customerId: null,
    purchaseId: null,
    originalRaw: null,
    raw: {
      subject: { fullName: customer.displayName, phone: customer.phone, email: customer.email },
      ...(type === "purchase" ? { payment: { externalPaymentId: `REVIEW-${index}`, amount: 12000, currency: "THB", paidAt: now.toISOString(), lines: [{ courseCode: index === 3 ? null : "INNER", courseLabel: index === 3 ? "คอร์สที่ยังไม่รู้จัก" : "Inner" }] } } : {}),
      ...(type === "intent" ? { intent: { courseCode: "COMMU", status: "hesitant", hesitationReason: "budget", confidence: 0.75 } } : {}),
    },
    schemaVersion: 1,
    ...meta,
  });
  const events = [
    event(1, "pending_identity", customers[26]!, "purchase", "identity_not_found"),
    event(2, "pending_identity", customers[27]!, "intent", "identity_not_found"),
    event(3, "quarantined", customers[28]!, "purchase", "unknown_course"),
    event(4, "quarantined", customers[29]!, "intent", "invalid_payload"),
  ];
  return { purchases, items, intents, events };
}

async function runLegacyScrub(uri: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", [
      "run", "legacy:scrub", "--",
      "--legacy-uri", uri,
      "--ai-uri", uri,
      "--legacy-db", LEGACY_DB,
      "--ai-db", AI_DB,
      "--all",
    ], { cwd: ROOT, env: process.env, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`legacy:scrub จบด้วย code ${code ?? "unknown"}`)));
  });
}

async function main(): Promise<void> {
  const uri = arg("uri", process.env.MONGODB_URI);
  if (!uri) throw new Error("ไม่พบ URI — ใส่ --uri หรือตั้ง MONGODB_URI");
  assertLocalMongoUri(uri);
  const legacyLimit = positiveIntArg("legacy-limit", 200);
  process.env.MONGODB_URI = uri;
  process.env.MONGODB_DB = MAIN_DB;
  process.env.MONGODB_MIRROR_URI = uri;
  process.env.LEGACY_MONGODB_URI = uri;
  process.env.AI_MONGODB_DB = AI_DB;
  process.env.LEGACY_MONGODB_DB = LEGACY_DB;

  const client = new MongoClient(uri, { appName: "line-crm-local-seed", serverSelectionTimeoutMS: 8_000 });
  await client.connect();
  const mainDb = client.db(MAIN_DB);
  const aiDb = client.db(AI_DB);
  const legacyDb = client.db(LEGACY_DB);
  const now = new Date();

  try {
    await Promise.all([ensureIndexes(mainDb), ensureAiIndexes(aiDb), ensureLegacyIndexes(legacyDb)]);
    await cleanSeed(mainDb, aiDb, legacyDb);
    console.log(process.argv.includes("--drop")
      ? "ล้างข้อมูล local-demo เดิมแล้ว (--drop ไม่แตะข้อมูลอื่น)"
      : "รีเซ็ตข้อมูล local-demo เดิมเพื่อให้รันซ้ำได้");

    const legacyPeople = await seedLegacy(legacyDb, now, legacyLimit);
    const matchPeople = await pickUniquePhonePeople(legacyDb, legacyPeople);
    const customers = buildCustomers(matchPeople, now);
    await replaceMany(mainDb, COLLECTIONS.customers, customers);
    await replaceMany(aiDb, AI_COLLECTIONS.customersScrubbed, customers.map((row) => ({
      ...scrubCustomer(row, now), seedTag: SEED_TAG, synthetic: true,
    })));

    const partner = buildPartnerData(customers, now);
    await replaceMany(mainDb, COLLECTIONS.purchases, partner.purchases);
    await replaceMany(mainDb, COLLECTIONS.purchaseItems, partner.items);
    await replaceMany(mainDb, COLLECTIONS.customerIntents, partner.intents);
    await replaceMany(mainDb, COLLECTIONS.partnerEvents, partner.events);

    await runLegacyScrub(uri);
    await scrubPartnerToAi(mainDb, aiDb);
    await Promise.all([
      aiDb.collection(AI_COLLECTIONS.purchasesScrubbed).updateMany({ partnerId: PARTNER_ID }, { $set: { seedTag: SEED_TAG, synthetic: true } }),
      aiDb.collection<{ _id: string; seedTag?: string; synthetic?: boolean }>(AI_COLLECTIONS.purchaseItemsScrubbed).updateMany({ _id: { $regex: "^pit_LOCAL_" } }, { $set: { seedTag: SEED_TAG, synthetic: true } }),
      aiDb.collection(AI_COLLECTIONS.customerIntentsScrubbed).updateMany({ partnerId: PARTNER_ID }, { $set: { seedTag: SEED_TAG, synthetic: true } }),
    ]);

    await buildCustomerLinks(aiDb, { llmProvider: null, now });
    for (const id of [customerId(0), customerId(1), customerId(2)]) {
      const link = await aiDb.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks).findOne({ customerId: id, status: "auto" });
      if (!link) throw new Error(`ไม่พบ auto link สำหรับ ${id}`);
      await aiDb.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks).updateOne({ _id: link._id }, {
        $set: { status: "confirmed", decidedBy: "staff", decidedAt: now, updatedAt: now },
      });
    }

    const [merges, links, partnerReviews, customerCount, erasedCount, linkStatuses, eventStatuses, matchedLinks, opportunities, salesReport] = await Promise.all([
      listPendingMergeReviews(mainDb),
      listCustomerLinkReviews(mainDb, aiDb, legacyDb),
      listPartnerReviews(mainDb),
      mainDb.collection<CustomerDoc>(COLLECTIONS.customers).countDocuments({ _id: { $regex: "^cus_LOCAL_" } }),
      mainDb.collection<CustomerDoc>(COLLECTIONS.customers).countDocuments({ _id: { $regex: "^cus_LOCAL_" }, status: "erased" }),
      aiDb.collection(AI_COLLECTIONS.customerLinks).aggregate<{ _id: string; count: number }>([
        { $match: { customerId: { $regex: "^cus_LOCAL_" } } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]).toArray(),
      mainDb.collection(COLLECTIONS.partnerEvents).aggregate<{ _id: string; count: number }>([
        { $match: { partnerId: PARTNER_ID } },
        { $group: { _id: "$status", count: { $sum: 1 } } },
      ]).toArray(),
      aiDb.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks).find(
        { customerId: { $in: Array.from({ length: 20 }, (_, index) => customerId(index)) } },
        { projection: { customerId: 1 } }
      ).toArray(),
      listSalesOpportunities(mainDb, aiDb, legacyDb, now),
      listSalesReport(mainDb, aiDb, legacyDb),
    ]);
    const linkCount = new Map(linkStatuses.map((row) => [row._id, row.count]));
    const eventCount = new Map(eventStatuses.map((row) => [row._id, row.count]));
    const matchedCustomers = new Set(matchedLinks.map((row) => row.customerId)).size;
    if (
      merges.length < 3 || links.length < 1 || partnerReviews.length < 4
      || (linkCount.get("auto") ?? 0) < 1 || (linkCount.get("confirmed") ?? 0) < 3
      || matchedCustomers < 20
    ) {
      throw new Error("ข้อมูล seed ไม่ครบเกณฑ์ของหน้า review");
    }
    if ((eventCount.get("pending_identity") ?? 0) < 2 || (eventCount.get("quarantined") ?? 0) < 2) {
      throw new Error("ข้อมูล seed ของ Partner ไม่ครบเกณฑ์");
    }
    if (opportunities.followUps.length < 3 || opportunities.upsells.length < 3) {
      throw new Error("ข้อมูล seed ของโอกาสการขายไม่ครบเกณฑ์");
    }
    if (salesReport.summary.newCount < 3 || salesReport.summary.returningCount < 3) {
      throw new Error("ข้อมูล seed ของรายงานการขายต้องมีลูกค้าใหม่และกลับมาซื้ออย่างละอย่างน้อย 3 คน");
    }

    const from = "2025-01-01";
    const to = `${now.getUTCFullYear() + 1}-12-31`;
    const analytics = await Promise.all(METRICS.map(async (metric) => {
      const query = analyticsQuerySchema.parse({
        metric, from, to, includeSynthetic: true,
        ...(metric === "channel_mix" ? { groupBy: "channel" } : {}),
      });
      return runAnalytics(aiDb, query);
    }));
    if (analytics.some((result) => result.rows.length === 0 || result.total === 0)) {
      throw new Error("analytics บาง metric ยังไม่มีข้อมูล");
    }
    const analyticsRows = analytics.reduce((sum, result) => sum + result.rows.length, 0);

    console.log("\nLocal admin demo พร้อมทดสอบ");
    console.log(`  Legacy persons จริง ${legacyPeople.length} คน (จาก ${legacyLimit} แถวแรก)`);
    console.log(`  Customers ที่ match ${matchedCustomers} คน`);
    console.log(`  Links                auto ${linkCount.get("auto") ?? 0} · needs_review ${linkCount.get("needs_review") ?? 0} · confirmed ${linkCount.get("confirmed") ?? 0}`);
    console.log(`  ลูกค้าซ้ำ          ${merges.length} รายการ`);
    console.log(`  ประวัติเก่ารอตรวจ  ${links.length} รายการ`);
    console.log(`  Partner             ${partnerReviews.length} รายการ · pending_identity ${eventCount.get("pending_identity") ?? 0} · quarantined ${eventCount.get("quarantined") ?? 0}`);
    console.log(`  ลูกค้า               ${customerCount} คน · erased ${erasedCount}`);
    console.log(`  Analytics            6/6 metric · รวม ${analyticsRows} แถว`);
    console.log(`  โอกาสการขาย          ตามผล ${opportunities.followUps.length} · upsell ${opportunities.upsells.length}`);
    console.log(`  รายงานการขาย          ใหม่ ${salesReport.summary.newCount} · กลับมาซื้อ ${salesReport.summary.returningCount} · รวม ${salesReport.summary.totalCustomers}`);
    console.log(`  โปรไฟล์ยืนยันแล้ว    ${customerId(0)}, ${customerId(1)}, ${customerId(2)}`);
    console.log(`  โปรไฟล์ erased       ${customerId(38)}, ${customerId(39)}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("seed:local ล้มเหลว:", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
