import React from "react";
import { createRequire } from "node:module";
import { beforeEach, describe, expect, it, vi } from "vitest";

const renderToStaticMarkup = (createRequire(import.meta.url)("react-dom/server") as {
  renderToStaticMarkup(element: React.ReactNode): string;
}).renderToStaticMarkup;

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  signOut: vi.fn(),
  getAdminAiDb: vi.fn(),
  getDb: vi.fn(),
  listPostAnalytics: vi.fn(),
  runAnalytics: vi.fn(),
  createLlmProvider: vi.fn(),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth, signOut: mocks.signOut }));
vi.mock("@/lib/adminDb", () => ({ getAdminAiDb: mocks.getAdminAiDb }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@line-crm/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@line-crm/core")>(),
  runAnalytics: mocks.runAnalytics,
  createLlmProvider: mocks.createLlmProvider,
  getDb: mocks.getDb,
  listPostAnalytics: mocks.listPostAnalytics,
}));

import AnalyticsPage from "../app/admin/analytics/page";
import { AnalyticsResultPanel } from "../app/admin/analytics/AnalyticsDashboard";
import { PostAnalyticsPanel } from "../app/admin/analytics/PostAnalyticsPanel";
import type { AnalyticsResult, PostAnalyticsResult } from "@line-crm/core";

function result(over: Partial<AnalyticsResult> = {}): AnalyticsResult {
  return {
    metric: "revenue",
    rows: [{ key: "a", label: "ค่าจาก Core", value: 7, share: 0.375, delta: 2 }],
    total: 999,
    meta: {
      from: "2026-08-01",
      to: "2026-08-31",
      timezone: "Asia/Bangkok",
      sourcesUsed: ["legacy", "partner"],
      containsSynthetic: false,
      isEstimate: false,
      rowsScanned: 41,
      warnings: [],
      generatedAt: "2026-09-01T00:00:00.000Z",
    },
    ...over,
  };
}

function postResult(over: Partial<PostAnalyticsResult> = {}): PostAnalyticsResult {
  return {
    rows: [{ key: "INNER", courseCode: "INNER", label: "Inner Makeover", postCount: 2,
      reactions: { total: 8, average: 4 }, comments: { total: 4, average: 2 }, shares: { total: 2, average: 1 },
      engagement: { total: 14, average: 7 }, reach: { total: 100, average: 50 } }],
    summary: { totalPosts: 2, mappedPosts: 2, unmappedPosts: 0, totalEngagement: 14, totalReach: 100 },
    chartMaxEngagement: 14,
    meta: { from: "2026-08-01", to: "2026-08-31", containsSynthetic: false, generatedAt: "2026-09-01T00:00:00Z" },
    ...over,
  };
}

describe("หน้า /admin/analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STAFF_EMAIL_ALLOWLIST = "staff@example.test";
    mocks.auth.mockResolvedValue({ user: { email: "staff@example.test" } });
    mocks.getAdminAiDb.mockResolvedValue({ name: "ai" });
    mocks.getDb.mockResolvedValue({ name: "main" });
    mocks.listPostAnalytics.mockResolvedValue(postResult());
    mocks.runAnalytics.mockResolvedValue(result());
    mocks.createLlmProvider.mockReturnValue(null);
  });

  it("⭐ คนไม่ล็อกอินถูก redirect ก่อนต่อฐาน", async () => {
    mocks.auth.mockResolvedValue(null);
    await expect(AnalyticsPage()).rejects.toThrow("redirect:/admin/login");
    expect(mocks.getAdminAiDb).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("⭐ อีเมลนอก allowlist ถูก redirect ก่อนต่อฐาน", async () => {
    mocks.auth.mockResolvedValue({ user: { email: "outsider@example.test" } });
    await expect(AnalyticsPage()).rejects.toThrow("redirect:/admin/login");
    expect(mocks.getAdminAiDb).not.toHaveBeenCalled();
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("พนักงานที่ได้รับอนุญาตโหลดผลเริ่มต้นผ่าน runAnalytics", async () => {
    expect(await AnalyticsPage()).toBeTruthy();
    expect(mocks.runAnalytics).toHaveBeenCalledWith(
      { name: "ai" },
      expect.objectContaining({ metric: "revenue", groupBy: "month", includeSynthetic: false })
    );
  });

  it("⭐ containsSynthetic ทำให้แถบเตือนปรากฏใน HTML", () => {
    const html = renderToStaticMarkup(React.createElement(AnalyticsResultPanel, { result: result({
      meta: { ...result().meta, containsSynthetic: true },
    }) }));
    expect(html).toContain("ตัวเลขนี้มีข้อมูลจำลอง ห้ามใช้ตัดสินใจ");
    expect(html).toContain("synthetic-alert");
  });

  it("D45 แสดง total/value/share ที่ core คืนมาโดยไม่รวมใหม่ใน UI", () => {
    const html = renderToStaticMarkup(React.createElement(AnalyticsResultPanel, { result: result() }));
    expect(html).toContain("฿999.00");
    expect(html).toContain("฿7.00");
    expect(html).toContain("37.5%");
    expect(html).toContain('viewBox="0 0 999 1"');
    expect(html).toContain('width="7"');
  });

  it("D49 แสดงตัวเลขและสเกลกราฟโพสต์ที่ core คืนมา พร้อมป้าย unmapped", () => {
    const base = postResult();
    const html = renderToStaticMarkup(React.createElement(PostAnalyticsPanel, { result: postResult({
      rows: [{ ...base.rows[0]!, key: "UNMAPPED", courseCode: null, label: "ยังไม่ map hashtag" }],
      summary: { ...base.summary, mappedPosts: 0, unmappedPosts: 2 },
    }) }));
    expect(html).toContain("มี 2 โพสต์ที่ยัง map hashtag ไม่ได้");
    expect(html).toContain("ยังไม่ map");
    expect(html).toContain('viewBox="0 0 14 1"');
    expect(html).toContain('width="14"');
  });
});
