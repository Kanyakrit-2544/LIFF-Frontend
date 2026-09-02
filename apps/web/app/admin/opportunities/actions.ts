"use server";

import {
  COLLECTIONS,
  getDb,
  type RecommendationReviewDoc,
  type RecommendationType,
} from "@line-crm/core";
import { auth } from "@/auth";
import { isAllowedStaffEmail } from "@/lib/adminAuth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

function value(form: FormData, name: string): string {
  const input = form.get(name);
  return typeof input === "string" ? input.trim() : "";
}

function parseRecoId(recoId: string): {
  type: RecommendationType;
  customerId: string;
  courseCode: string;
} {
  const parts = recoId.split(":");
  const type = parts[0];
  const customerId = parts[1] ?? "";
  const courseCode = parts[2] ?? "";
  if (
    parts.length !== 3
    || (type !== "follow_up" && type !== "upsell")
    || !/^cus_[A-Za-z0-9_-]+$/.test(customerId)
    || !/^[A-Z0-9_-]{1,40}$/.test(courseCode)
  ) throw new Error("invalid_recommendation");
  return { type, customerId, courseCode };
}

export async function markRecommendation(form: FormData): Promise<never> {
  const session = await auth();
  const staffEmail = session?.user?.email?.trim().toLowerCase();
  if (!staffEmail || !isAllowedStaffEmail(staffEmail)) throw new Error("staff_unauthorized");

  const status = value(form, "status");
  if (status !== "done" && status !== "skipped") throw new Error("invalid_recommendation_status");
  const recoId = value(form, "recoId");
  const parsed = parseRecoId(recoId);
  const db = await getDb();
  const customer = await db.collection<{ _id: string; status: string; seedTag?: string; synthetic?: boolean }>(
    COLLECTIONS.customers
  ).findOne({ _id: parsed.customerId, status: "active" }, {
    projection: { _id: 1, seedTag: 1, synthetic: 1 },
  });
  if (!customer) throw new Error("recommendation_customer_changed");

  const review: RecommendationReviewDoc = {
    _id: recoId,
    ...parsed,
    status,
    staffEmail,
    at: new Date(),
    ...(customer.synthetic === true ? { synthetic: true } : {}),
    ...(customer.synthetic === true && customer.seedTag ? { seedTag: customer.seedTag } : {}),
  };
  await db.collection<RecommendationReviewDoc>(COLLECTIONS.recommendationReviews).updateOne(
    { _id: recoId },
    { $setOnInsert: review },
    { upsert: true }
  );

  revalidatePath("/admin/opportunities");
  const notice = status === "done" ? "บันทึกว่าดำเนินการแล้ว" : "ข้ามรายการแล้ว";
  redirect(`/admin/opportunities?notice=${encodeURIComponent(notice)}`);
}
