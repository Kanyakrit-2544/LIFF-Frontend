import { createRequire } from "node:module";
import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowUpReco, UpsellReco } from "@line-crm/core";

const renderToStaticMarkup = (createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup(element: React.ReactNode): string;
}).renderToStaticMarkup;

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  signOut: vi.fn(),
  getDb: vi.fn(),
  getAdminReviewDbs: vi.fn(),
  listSalesOpportunities: vi.fn(),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth, signOut: mocks.signOut }));
vi.mock("@/lib/adminDb", () => ({ getAdminReviewDbs: mocks.getAdminReviewDbs }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@line-crm/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@line-crm/core")>(),
  getDb: mocks.getDb,
  listSalesOpportunities: mocks.listSalesOpportunities,
}));

import OpportunitiesPage from "../app/admin/opportunities/page";
import { FollowUpList, UpsellList } from "../app/admin/opportunities/OpportunityLists";

const followUp: FollowUpReco = {
  recoId: "follow_up:cus_1:INNER",
  type: "follow_up",
  customerId: "cus_1",
  customerName: "ลูกค้าทดสอบ",
  courseCode: "INNER",
  courseName: "Inner Makeover",
  hesitationReason: "budget",
  confidence: 0.87,
  suggestedAction: "เสนอผ่อน / ส่วนลด",
  observedAt: new Date("2026-09-01"),
  synthetic: true,
};

const upsell: UpsellReco = {
  recoId: "upsell:cus_1:COMMU",
  type: "upsell",
  customerId: "cus_1",
  customerName: "ผู้เรียนทดสอบ",
  completedCourseCode: "INNER",
  completedCourseName: "Inner Makeover",
  courseCode: "COMMU",
  courseName: "Communication",
  completedAt: new Date("2026-08-01"),
  source: "legacy",
  synthetic: true,
};

describe("หน้า /admin/opportunities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STAFF_EMAIL_ALLOWLIST = "staff@example.test";
    mocks.auth.mockResolvedValue({ user: { email: "staff@example.test" } });
    mocks.getDb.mockResolvedValue({ name: "main" });
    mocks.getAdminReviewDbs.mockResolvedValue({ aiDb: { name: "ai" }, legacyDb: { name: "legacy" } });
    mocks.listSalesOpportunities.mockResolvedValue({ followUps: [followUp], upsells: [upsell] });
  });

  it("คนไม่ล็อกอินถูก redirect ก่อนต่อฐาน", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(OpportunitiesPage({})).rejects.toThrow("redirect:/admin/login");
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getAdminReviewDbs).not.toHaveBeenCalled();
  });

  it("อีเมลนอก allowlist ถูก redirect ก่อนต่อฐาน", async () => {
    mocks.auth.mockResolvedValue({ user: { email: "outsider@example.test" } });
    await expect(OpportunitiesPage({})).rejects.toThrow("redirect:/admin/login");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("พนักงานที่ได้รับอนุญาตอ่านข้อมูลผ่านฐานทั้งสาม", async () => {
    expect(await OpportunitiesPage({})).toBeTruthy();
    expect(mocks.listSalesOpportunities).toHaveBeenCalledWith(
      { name: "main" }, { name: "ai" }, { name: "legacy" }
    );
  });

  it("แสดง synthetic, confidence และมีเฉพาะปุ่ม human review", () => {
    const html = renderToStaticMarkup(React.createElement(React.Fragment, null,
      React.createElement(FollowUpList, { items: [followUp] }),
      React.createElement(UpsellList, { items: [upsell] })
    ));
    expect(html).toContain("ข้อมูลจำลอง");
    expect(html).toContain("87%");
    expect(html).toContain("ประวัติเก่าที่พนักงานยืนยันแล้ว");
    expect(html).toContain("ทำแล้ว");
    expect(html).toContain("ข้าม");
    expect(html).not.toMatch(/<button[^>]*>[^<]*(ส่ง|ยิง)/);
  });
});
