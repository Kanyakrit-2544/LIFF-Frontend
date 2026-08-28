import { ageBand } from "../ai/tokens";
import { decideByRules, type MatchCandidate } from "./rules";

export interface MatchCustomerRow {
  _id?: unknown;
  customerId?: string;
  status?: string;
  phone?: string | null;
  email?: string | null;
  phoneHash?: string | null;
  emailHash?: string | null;
  nameKeys?: string[];
  nicknameKey?: string | null;
  birthYear?: number | null;
  firstInteractionAt?: string | null;
  formSubmittedAt?: string | null;
  courseCodes?: string[];
}

export interface MatchLegacyRow {
  _id: string;
  phone?: string | null;
  email?: string | null;
  phoneHash?: string | null;
  emailHash?: string | null;
  nameKeys?: string[];
  nicknameKey?: string | null;
  ageBand?: string | null;
  firstPaidAt?: string | null;
  courseCodes?: string[];
}

export interface CandidatePair extends MatchCandidate {
  customer: MatchCustomerRow;
  legacy: MatchLegacyRow;
}

type Index = Map<string, Set<number>>;

function add(index: Index, value: string | null | undefined, row: number): void {
  if (!value) return;
  const rows = index.get(value) ?? new Set<number>();
  rows.add(row);
  index.set(value, rows);
}

function last4(value: string | null | undefined): string | null {
  const match = value?.match(/(\d{4})$/);
  return match?.[1] ?? null;
}

function emailDomain(value: string | null | undefined): string | null {
  const at = value?.lastIndexOf("@") ?? -1;
  return at >= 0 ? value!.slice(at + 1).toLowerCase() : null;
}

function customerAgeBand(row: MatchCustomerRow, now: Date): string | null {
  if (!row.birthYear) return null;
  return ageBand(now.getFullYear() + 543 - row.birthYear);
}

function overlap(a: readonly string[], b: readonly string[]): number {
  const right = new Set(b);
  return [...new Set(a)].filter((key) => right.has(key)).length;
}

function daysBetween(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const left = Date.parse(a);
  const right = Date.parse(b);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.round(Math.abs(left - right) / 86_400_000);
}

export function customerRowId(row: MatchCustomerRow): string | null {
  if (typeof row.customerId === "string") return row.customerId;
  return typeof row._id === "string" ? row._id : null;
}

export interface LlmPairFeatures {
  pairId: string;
  nameKeyOverlap: number;
  nameKeyTotalA: number;
  nameKeyTotalB: number;
  nicknameMatch: boolean;
  ageBandMatch: boolean | null;
  phoneLast4Match: boolean;
  emailDomainMatch: boolean;
  courseOverlap: number;
  daysBetweenFirstSeen: number | null;
}

export function toLlmFeatures(pair: CandidatePair, pairId: string): LlmPairFeatures {
  const customerNames = pair.customer.nameKeys ?? [];
  const legacyNames = pair.legacy.nameKeys ?? [];
  return {
    pairId,
    nameKeyOverlap: pair.evidence.nameKeyOverlap,
    nameKeyTotalA: new Set(customerNames).size,
    nameKeyTotalB: new Set(legacyNames).size,
    nicknameMatch: pair.evidence.nicknameMatch,
    ageBandMatch: pair.evidence.ageBandMatch,
    phoneLast4Match: Boolean(last4(pair.customer.phone) && last4(pair.customer.phone) === last4(pair.legacy.phone)),
    emailDomainMatch: Boolean(emailDomain(pair.customer.email) && emailDomain(pair.customer.email) === emailDomain(pair.legacy.email)),
    courseOverlap: overlap(pair.customer.courseCodes ?? [], pair.legacy.courseCodes ?? []),
    daysBetweenFirstSeen: daysBetween(
      pair.customer.firstInteractionAt ?? pair.customer.formSubmittedAt,
      pair.legacy.firstPaidAt
    ),
  };
}

function candidateRank(pair: CandidatePair): number {
  const feature = toLlmFeatures(pair, "rank");
  return feature.nameKeyOverlap * 3
    + Number(feature.nicknameMatch) * 3
    + Number(feature.phoneLast4Match) * 2
    + Number(feature.emailDomainMatch)
    + Number(feature.ageBandMatch === true)
    + feature.courseOverlap * 2;
}

/** Build every deterministic pair, then cap only the unresolved pairs that may go to the LLM. */
export function buildMatchCandidates(
  customers: readonly MatchCustomerRow[],
  legacyPeople: readonly MatchLegacyRow[],
  maxFuzzyCandidates = 5,
  now = new Date()
): CandidatePair[] {
  const phone = new Map<string, Set<number>>();
  const email = new Map<string, Set<number>>();
  const names = new Map<string, Set<number>>();
  const nicknames = new Map<string, Set<number>>();
  const phoneSuffixes = new Map<string, Set<number>>();
  const emailDomains = new Map<string, Set<number>>();
  const ages = new Map<string, Set<number>>();

  legacyPeople.forEach((row, index) => {
    add(phone, row.phoneHash, index);
    add(email, row.emailHash, index);
    for (const key of row.nameKeys ?? []) add(names, key, index);
    add(nicknames, row.nicknameKey, index);
    add(phoneSuffixes, last4(row.phone), index);
    add(emailDomains, emailDomain(row.email), index);
    add(ages, row.ageBand, index);
  });

  const customerPhoneCounts = new Map<string, number>();
  const customerEmailCounts = new Map<string, number>();
  for (const row of customers) {
    if (row.phoneHash) customerPhoneCounts.set(row.phoneHash, (customerPhoneCounts.get(row.phoneHash) ?? 0) + 1);
    if (row.emailHash) customerEmailCounts.set(row.emailHash, (customerEmailCounts.get(row.emailHash) ?? 0) + 1);
  }

  const output: CandidatePair[] = [];
  for (const customer of customers) {
    const customerId = customerRowId(customer);
    if (!customerId || customer.status === "merged" || customer.status === "archived") continue;
    const hashIndexes = new Set<number>();
    for (const index of phone.get(customer.phoneHash ?? "") ?? []) hashIndexes.add(index);
    for (const index of email.get(customer.emailHash ?? "") ?? []) hashIndexes.add(index);

    const fuzzyIndexes = new Set<number>();
    for (const key of customer.nameKeys ?? []) for (const index of names.get(key) ?? []) fuzzyIndexes.add(index);
    for (const index of nicknames.get(customer.nicknameKey ?? "") ?? []) fuzzyIndexes.add(index);
    for (const index of phoneSuffixes.get(last4(customer.phone) ?? "") ?? []) fuzzyIndexes.add(index);
    for (const index of emailDomains.get(emailDomain(customer.email) ?? "") ?? []) fuzzyIndexes.add(index);
    for (const index of ages.get(customerAgeBand(customer, now) ?? "") ?? []) fuzzyIndexes.add(index);
    for (const index of hashIndexes) fuzzyIndexes.delete(index);

    const makePair = (index: number): CandidatePair => {
      const legacy = legacyPeople[index]!;
      const phoneMatch = Boolean(customer.phoneHash && customer.phoneHash === legacy.phoneHash);
      const emailMatch = Boolean(customer.emailHash && customer.emailHash === legacy.emailHash);
      const phoneCompetitors = phoneMatch
        ? (customerPhoneCounts.get(customer.phoneHash!) ?? 1) - 1 + (phone.get(customer.phoneHash!)?.size ?? 1) - 1
        : 0;
      const emailCompetitors = emailMatch
        ? (customerEmailCounts.get(customer.emailHash!) ?? 1) - 1 + (email.get(customer.emailHash!)?.size ?? 1) - 1
        : 0;
      const customerAge = customerAgeBand(customer, now);
      return {
        customerId,
        legacyPersonId: legacy._id,
        customer,
        legacy,
        evidence: {
          phoneHashMatch: phoneMatch,
          emailHashMatch: emailMatch,
          nameKeyOverlap: overlap(customer.nameKeys ?? [], legacy.nameKeys ?? []),
          nicknameMatch: Boolean(customer.nicknameKey && customer.nicknameKey === legacy.nicknameKey),
          ageBandMatch: customerAge && legacy.ageBand ? customerAge === legacy.ageBand : null,
          competingCandidates: Math.max(phoneCompetitors, emailCompetitors),
        },
      };
    };

    for (const index of hashIndexes) output.push(makePair(index));
    const fuzzy = [...fuzzyIndexes].map(makePair).sort((a, b) => candidateRank(b) - candidateRank(a));
    const rulePairs = fuzzy.filter((pair) => decideByRules(pair) !== null);
    const llmPairs = fuzzy.filter((pair) => decideByRules(pair) === null);
    output.push(...rulePairs, ...llmPairs.slice(0, maxFuzzyCandidates));
  }
  return output;
}
