import type { Db } from "mongodb";
import { COLLECTIONS, type CustomerDoc } from "../db/models";
import { currentIntent } from "../partner/intents";
import type { CustomerIntentDoc, HesitationReason, IntentStatus } from "../partner/models";

export const INTENT_SHEET_TAB = "Intent";
export const INTENT_SHEET_HEADERS = [
  "ชื่อลูกค้า",
  "คอร์ส",
  "สถานะ",
  "เหตุผลลังเล",
  "ความมั่นใจ %",
  "ที่มา",
  "วันที่พบล่าสุด",
] as const;

export type IntentSheetCell = string | number;
export type DisplayIntentStatus = Exclude<IntentStatus, "unknown">;

export interface IntentSheetCustomer {
  _id: string;
  status: CustomerDoc["status"];
  displayName?: string | null;
  lineDisplayName?: string | null;
  nickname?: string | null;
}

export interface IntentSheetSummary {
  interested: number;
  hesitant: number;
  notInterested: number;
}

export interface IntentSheetReport {
  values: IntentSheetCell[][];
  summary: IntentSheetSummary;
}

const STATUS_LABELS: Record<DisplayIntentStatus, string> = {
  interested: "สนใจ",
  hesitant: "ลังเล",
  not_interested: "ไม่สนใจ",
};

const REASON_LABELS: Record<HesitationReason, string> = {
  budget: "งบประมาณ",
  not_needed: "ยังไม่เห็นความจำเป็น",
  timing_conflict: "เวลาไม่สะดวก",
  not_ready: "ยังไม่พร้อม",
  needs_approval: "รออนุมัติ/ปรึกษา",
  unknown: "ไม่ทราบเหตุผล",
};

const DISPLAY_STATUSES = new Set<IntentStatus>(["interested", "hesitant", "not_interested"]);

function currentRows(intents: readonly CustomerIntentDoc[]): CustomerIntentDoc[] {
  const groups = new Map<string, CustomerIntentDoc[]>();
  for (const intent of intents) {
    if (
      !intent.customerId
      || intent.voidedAt !== null
      || intent.supersededAt !== null
      || !DISPLAY_STATUSES.has(intent.status)
    ) continue;
    const key = `${intent.customerId}\u0000${intent.courseCode ?? ""}`;
    const rows = groups.get(key) ?? [];
    rows.push(intent);
    groups.set(key, rows);
  }
  return [...groups.values()]
    .flatMap((rows) => {
      const winner = currentIntent(rows);
      return winner ? [winner] : [];
    })
    .sort((left, right) =>
      right.observedAt.getTime() - left.observedAt.getTime()
      || left._id.localeCompare(right._id)
    );
}

function confidenceLabel(confidence: number): string {
  const percent = Math.round(Math.max(0, Math.min(1, confidence)) * 10_000) / 100;
  return `${percent}%`;
}

export function buildIntentSheetReport(
  intents: readonly CustomerIntentDoc[],
  customersById: ReadonlyMap<string, IntentSheetCustomer>
): IntentSheetReport {
  const rows = currentRows(intents);
  const summary: IntentSheetSummary = {
    interested: rows.filter((row) => row.status === "interested").length,
    hesitant: rows.filter((row) => row.status === "hesitant").length,
    notInterested: rows.filter((row) => row.status === "not_interested").length,
  };
  return {
    summary,
    values: [
      [
        "สรุป",
        `สนใจ ${summary.interested}`,
        `ลังเล ${summary.hesitant}`,
        `ไม่สนใจ ${summary.notInterested}`,
        "",
        "",
        "",
      ],
      [...INTENT_SHEET_HEADERS],
      ...rows.map((intent): IntentSheetCell[] => {
        const customer = customersById.get(intent.customerId!);
        const name = customer?.status === "erased"
          ? ""
          : customer?.displayName ?? customer?.lineDisplayName ?? customer?.nickname ?? "";
        const status = intent.status as DisplayIntentStatus;
        return [
          name,
          intent.courseCode ?? "",
          STATUS_LABELS[status],
          intent.hesitationReason ? REASON_LABELS[intent.hesitationReason] : "",
          confidenceLabel(intent.confidence),
          intent.source === "staff" ? "พนักงาน" : "AI",
          intent.observedAt.toISOString().slice(0, 10),
        ];
      }),
    ],
  };
}

export function buildIntentSheetRows(
  intents: readonly CustomerIntentDoc[],
  customersById: ReadonlyMap<string, IntentSheetCustomer>
): IntentSheetCell[][] {
  return buildIntentSheetReport(intents, customersById).values;
}

export async function listIntentSheetReport(db: Db): Promise<IntentSheetReport> {
  const intents = await db.collection<CustomerIntentDoc>(COLLECTIONS.customerIntents).find({
    customerId: { $type: "string" },
    voidedAt: null,
    supersededAt: null,
    status: { $in: ["interested", "hesitant", "not_interested"] },
  }).toArray();
  const customerIds = [...new Set(intents.flatMap((intent) => intent.customerId ? [intent.customerId] : []))];
  const customers = customerIds.length
    ? await db.collection<IntentSheetCustomer>(COLLECTIONS.customers).find(
      { _id: { $in: customerIds } },
      { projection: { status: 1, displayName: 1, lineDisplayName: 1, nickname: 1 } }
    ).toArray()
    : [];
  return buildIntentSheetReport(intents, new Map(customers.map((customer) => [customer._id, customer])));
}
