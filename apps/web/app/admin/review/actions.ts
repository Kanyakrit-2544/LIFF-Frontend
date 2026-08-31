"use server";

import {
  AI_COLLECTIONS,
  type CustomerLinkDoc,
  assignPartnerIdentity,
  confirmPendingMerge,
  correctPartnerEvent,
  decideCustomerLink,
  getDb,
  rejectPartnerEvent,
  rejectPendingMerge,
  type PartnerCorrection,
} from "@line-crm/core";
import { auth } from "@/auth";
import { getAdminReviewDbs } from "@/lib/adminDb";
import { isAllowedStaffEmail } from "@/lib/adminAuth";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

type Tab = "merge" | "links" | "partner";

function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value.trim() : "";
}

async function staffEmail(): Promise<string> {
  const session = await auth();
  const email = session?.user?.email?.trim().toLowerCase();
  if (!email || !isAllowedStaffEmail(email)) throw new Error("staff_unauthorized");
  return email;
}

function message(error: unknown): string {
  const code = error instanceof Error ? error.message : "unknown";
  const known: Record<string, string> = {
    pending_merge_changed: "รายการ merge เปลี่ยนไปแล้ว กรุณาโหลดหน้าใหม่",
    pending_merge_customer_inactive: "ลูกค้ารายใดรายหนึ่งไม่อยู่ในสถานะที่รวมได้",
    customer_link_changed: "ลิงก์นี้ถูกตัดสินไปแล้ว กรุณาโหลดหน้าใหม่",
    partner_event_changed: "รายการ partner เปลี่ยนไปแล้ว กรุณาโหลดหน้าใหม่",
    partner_identity_changed: "รายการหรือลูกค้าเปลี่ยนไปแล้ว กรุณาโหลดหน้าใหม่",
    unsupported_tag_requires_reject: "event ประเภท tag แก้เป็นประเภทอื่นไม่ได้ กรุณาปฏิเสธรายการนี้",
    legacy_evidence_missing: "ยังไม่มีข้อมูล legacy ต้นฉบับ จึงยังตัดสินลิงก์นี้ไม่ได้",
    staff_unauthorized: "ไม่มีสิทธิ์ทำรายการ",
  };
  return known[code] ?? "ทำรายการไม่สำเร็จ กรุณาตรวจข้อมูลแล้วลองใหม่";
}

async function run(tab: Tab, success: string, operation: () => Promise<unknown>): Promise<never> {
  let errorText = "";
  try {
    await operation();
  } catch (error) {
    errorText = message(error);
  }
  revalidatePath("/admin/review");
  const params = new URLSearchParams({ tab, ...(errorText ? { error: errorText } : { notice: success }) });
  redirect(`/admin/review?${params.toString()}`);
}

export async function decideMergeAction(form: FormData): Promise<never> {
  const actor = await staffEmail();
  const customerId = text(form, "customerId");
  const candidateId = text(form, "candidateId");
  const decision = text(form, "decision");
  const reason = text(form, "reason");
  return run("merge", decision === "confirmed" ? "รวมข้อมูลลูกค้าแล้ว" : "ปฏิเสธและจำคู่นี้ถาวรแล้ว", async () => {
    if (!customerId || !candidateId) throw new Error("pending_merge_changed");
    if (decision === "confirmed") {
      await confirmPendingMerge({ customerId, candidateId, actor: `staff:${actor}`, reason });
    } else if (decision === "rejected") {
      await rejectPendingMerge({ customerId, candidateId, actor: `staff:${actor}`, reason });
    } else {
      throw new Error("invalid_decision");
    }
  });
}

export async function decideLinkAction(form: FormData): Promise<never> {
  const actor = await staffEmail();
  const linkId = text(form, "linkId");
  const legacyPersonId = text(form, "legacyPersonId");
  const decision = text(form, "decision");
  const reason = text(form, "reason");
  return run("links", decision === "confirmed" ? "ยืนยันลิงก์แล้ว" : "ปฏิเสธลิงก์แล้ว", async () => {
    if (!linkId || !legacyPersonId || !["confirmed", "rejected"].includes(decision)) throw new Error("invalid_decision");
    const { aiDb, legacyDb } = await getAdminReviewDbs();
    const [link, legacy] = await Promise.all([
      aiDb.collection<CustomerLinkDoc>(AI_COLLECTIONS.customerLinks).findOne({ _id: linkId, legacyPersonId }),
      legacyDb.collection<{ _id: string }>("legacy_persons").findOne({ _id: legacyPersonId }, { projection: { _id: 1 } }),
    ]);
    if (!link) throw new Error("customer_link_changed");
    if (!legacy) throw new Error("legacy_evidence_missing");
    await decideCustomerLink({
      mainDb: await getDb(), aiDb, linkId,
      decision: decision as "confirmed" | "rejected",
      actor: `staff:${actor}`, reason,
    });
  });
}

export async function rejectPartnerAction(form: FormData): Promise<never> {
  const actor = await staffEmail();
  return run("partner", "ปฏิเสธรายการแล้ว", () => rejectPartnerEvent({
    partnerId: text(form, "partnerId"),
    eventId: text(form, "eventId"),
    actor: `staff:${actor}`,
    reason: text(form, "reason"),
  }));
}

export async function assignPartnerAction(form: FormData): Promise<never> {
  const actor = await staffEmail();
  return run("partner", "ผูกข้อมูลเข้ากับลูกค้าแล้ว", () => assignPartnerIdentity({
    partnerId: text(form, "partnerId"),
    eventId: text(form, "eventId"),
    customerId: text(form, "customerId"),
    actor: `staff:${actor}`,
    reason: text(form, "reason"),
  }));
}

export async function correctPartnerAction(form: FormData): Promise<never> {
  const actor = await staffEmail();
  const type = text(form, "type");
  const correction: PartnerCorrection = {};
  if (type === "purchase") {
    const count = Number(text(form, "lineCount"));
    correction.purchaseLines = Array.from({ length: Number.isFinite(count) ? count : 0 }, (_, index) => ({
      index,
      courseCode: text(form, `courseCode.${index}`) || null,
      courseLabel: text(form, `courseLabel.${index}`),
    }));
  } else if (type === "intent") {
    correction.intent = {
      courseCode: text(form, "courseCode") || null,
      status: text(form, "intentStatus"),
      hesitationReason: text(form, "hesitationReason") || null,
    };
  } else if (type === "purchase.void" || type === "intent.void") {
    correction.voids = text(form, "voids");
  }
  return run("partner", "บันทึกการแก้ไขและประมวลผลใหม่แล้ว", () => correctPartnerEvent({
    partnerId: text(form, "partnerId"),
    eventId: text(form, "eventId"),
    correction,
    actor: `staff:${actor}`,
    reason: text(form, "reason"),
  }));
}
