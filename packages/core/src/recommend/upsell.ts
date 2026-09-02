import { courseByCode } from "../legacy/courses";
import type { RecommendationCustomer } from "./followUp";
import { nextCourses } from "./courseLadder";

export interface CourseHistoryRow {
  customerId: string;
  courseCode: string;
  countsAsSeat: boolean;
  sessionStart: Date | null;
  source: "partner" | "legacy";
  synthetic?: boolean;
}

export interface CompletedCourse {
  courseCode: string;
  completedAt: Date;
  source: "partner" | "legacy";
  synthetic: boolean;
}

export interface CustomerCourseHistory {
  purchasedCourseCodes: ReadonlySet<string>;
  completedCourses: readonly CompletedCourse[];
}

export type CompletedByCustomer = ReadonlyMap<string, CustomerCourseHistory>;

export interface UpsellReco {
  recoId: string;
  type: "upsell";
  customerId: string;
  customerName: string;
  completedCourseCode: string;
  completedCourseName: string;
  courseCode: string;
  courseName: string;
  completedAt: Date;
  source: "partner" | "legacy";
  synthetic: boolean;
}

function courseName(code: string): string {
  return courseByCode(code)?.nameTh ?? code;
}

export function buildCompletedByCustomer(
  rows: readonly CourseHistoryRow[],
  now: Date
): Map<string, CustomerCourseHistory> {
  const purchased = new Map<string, Set<string>>();
  const latestCompleted = new Map<string, Map<string, CompletedCourse>>();

  for (const row of rows) {
    const code = row.courseCode.trim().toUpperCase();
    if (!row.customerId || !code) continue;
    const purchasedCodes = purchased.get(row.customerId) ?? new Set<string>();
    purchasedCodes.add(code);
    purchased.set(row.customerId, purchasedCodes);

    if (!row.countsAsSeat || !row.sessionStart || row.sessionStart >= now) continue;
    const byCourse = latestCompleted.get(row.customerId) ?? new Map<string, CompletedCourse>();
    const candidate: CompletedCourse = {
      courseCode: code,
      completedAt: row.sessionStart,
      source: row.source,
      synthetic: row.synthetic === true,
    };
    const existing = byCourse.get(code);
    if (!existing || candidate.completedAt > existing.completedAt) byCourse.set(code, candidate);
    latestCompleted.set(row.customerId, byCourse);
  }

  const result = new Map<string, CustomerCourseHistory>();
  for (const [customerId, purchasedCourseCodes] of purchased) {
    result.set(customerId, {
      purchasedCourseCodes,
      completedCourses: [...(latestCompleted.get(customerId)?.values() ?? [])],
    });
  }
  return result;
}

export function buildUpsellRecommendations(
  completedByCustomer: CompletedByCustomer,
  customersById: ReadonlyMap<string, RecommendationCustomer>
): UpsellReco[] {
  const byRecoId = new Map<string, UpsellReco>();

  for (const [customerId, history] of completedByCustomer) {
    const customer = customersById.get(customerId);
    if (!customer || customer.status !== "active") continue;

    for (const completed of history.completedCourses) {
      for (const nextCode of nextCourses(completed.courseCode)) {
        if (history.purchasedCourseCodes.has(nextCode)) continue;
        const recoId = `upsell:${customerId}:${nextCode}`;
        const candidate: UpsellReco = {
          recoId,
          type: "upsell",
          customerId,
          customerName: customer.displayName ?? customer.lineDisplayName ?? customerId,
          completedCourseCode: completed.courseCode,
          completedCourseName: courseName(completed.courseCode),
          courseCode: nextCode,
          courseName: courseName(nextCode),
          completedAt: completed.completedAt,
          source: completed.source,
          synthetic: customer.synthetic === true || completed.synthetic,
        };
        const existing = byRecoId.get(recoId);
        if (!existing || candidate.completedAt > existing.completedAt) byRecoId.set(recoId, candidate);
      }
    }
  }

  return [...byRecoId.values()].sort((left, right) =>
    right.completedAt.getTime() - left.completedAt.getTime() || left.recoId.localeCompare(right.recoId)
  );
}
