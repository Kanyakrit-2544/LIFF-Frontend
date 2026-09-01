import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getAdminAiDb: vi.fn(),
  getMirrorAiDb: vi.fn(),
  mirrorConfigured: vi.fn(),
  runAnalytics: vi.fn(),
  createLlmProvider: vi.fn(),
  parseQuestion: vi.fn(),
  renderAnswer: vi.fn(),
  saveInsight: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/adminDb", () => ({ getAdminAiDb: mocks.getAdminAiDb }));
vi.mock("@/lib/mirrorDb", () => ({ getMirrorAiDb: mocks.getMirrorAiDb, mirrorConfigured: mocks.mirrorConfigured }));
vi.mock("@line-crm/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@line-crm/core")>(),
  runAnalytics: mocks.runAnalytics,
  createLlmProvider: mocks.createLlmProvider,
  parseQuestion: mocks.parseQuestion,
  renderAnswer: mocks.renderAnswer,
  saveInsight: mocks.saveInsight,
}));

import { POST } from "../app/api/admin/analytics/route";

const baseQuery = { metric: "revenue", from: "2026-08-01", to: "2026-08-31", groupBy: "month" };
const result = {
  metric: "revenue",
  rows: [{ key: "2026-08", label: "2026-08", value: 12500, share: 1, delta: 2500 }],
  total: 12500,
  meta: {
    from: "2026-08-01",
    to: "2026-08-31",
    timezone: "Asia/Bangkok",
    sourcesUsed: ["legacy", "partner"],
    containsSynthetic: false,
    isEstimate: false,
    rowsScanned: 3,
    warnings: [],
    generatedAt: "2026-09-01T00:00:00.000Z",
  },
};

function request(body: unknown): Request {
  return new Request("https://example.test/api/admin/analytics", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/analytics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STAFF_EMAIL_ALLOWLIST = "staff@example.test";
    mocks.auth.mockResolvedValue({ user: { email: "staff@example.test" } });
    mocks.getAdminAiDb.mockResolvedValue({ name: "read-ai" });
    mocks.getMirrorAiDb.mockResolvedValue({ name: "write-ai" });
    mocks.mirrorConfigured.mockReturnValue(false);
    mocks.createLlmProvider.mockReturnValue(null);
    mocks.runAnalytics.mockResolvedValue(result);
  });

  it("⭐ คนไม่ล็อกอินถูกปฏิเสธด้วย 401 ก่อนต่อฐาน", async () => {
    mocks.auth.mockResolvedValue(null);
    const response = await POST(request(baseQuery));
    expect(response.status).toBe(401);
    expect(mocks.getAdminAiDb).not.toHaveBeenCalled();
  });

  it("⭐ อีเมลนอก allowlist ถูกปฏิเสธด้วย 401 ก่อนต่อฐาน", async () => {
    mocks.auth.mockResolvedValue({ user: { email: "outsider@example.test" } });
    const response = await POST(request(baseQuery));
    expect(response.status).toBe(401);
    expect(mocks.getAdminAiDb).not.toHaveBeenCalled();
  });

  it("query ถูกต้องคืน AnalyticsResult จาก runAnalytics", async () => {
    const response = await POST(request(baseQuery));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
    expect(mocks.runAnalytics).toHaveBeenCalledWith({ name: "read-ai" }, expect.objectContaining(baseQuery));
  });

  it("includeSynthetic มีค่าเริ่มต้น false ก่อนส่งเข้า core", async () => {
    await POST(request(baseQuery));
    expect(mocks.runAnalytics).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ includeSynthetic: false })
    );
  });

  it("query ที่ from มากกว่า to คืน 400 พร้อมเหตุผล", async () => {
    const response = await POST(request({ ...baseQuery, from: "2026-09-01" }));
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("from");
    expect(mocks.runAnalytics).not.toHaveBeenCalled();
  });

  it("โหมดคำถามเมื่อยังไม่มี Hermes บอกให้ใช้ dropdown และไม่ error", async () => {
    const response = await POST(request({ question: "เดือนสิงหาคมขายได้เท่าไร" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.llmAvailable).toBe(false);
    expect(body.message).toContain("ตัวเลือก");
    expect(mocks.getAdminAiDb).not.toHaveBeenCalled();
  });

  it("คำตอบ AI ที่แต่งตัวเลขไม่ถูกส่งกลับไปแสดง", async () => {
    const provider = { name: "hermes-test" };
    mocks.createLlmProvider.mockReturnValue(provider);
    mocks.parseQuestion.mockResolvedValue({ ok: true, query: { ...baseQuery, sources: ["legacy", "partner"], includeSynthetic: false, minConfidence: 0.6 } });
    mocks.renderAnswer.mockResolvedValue({ answer: "ยอดโต 99%", verified: false, invented: ["99"] });

    const response = await POST(request({ question: "เดือนสิงหาคมขายได้เท่าไร" }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.result).toEqual(result);
    expect(body.answer).toBeNull();
    expect(body.answerVerified).toBe(false);
    expect(body.invented).toEqual(["99"]);
  });

  it("เมื่อมี mirror writer จะบันทึก insight โดยไม่ใช้ review_user เขียน", async () => {
    mocks.mirrorConfigured.mockReturnValue(true);
    mocks.saveInsight.mockResolvedValue("ins_1");
    await POST(request(baseQuery));
    expect(mocks.getMirrorAiDb).toHaveBeenCalled();
    expect(mocks.saveInsight).toHaveBeenCalledWith(
      { name: "write-ai" },
      expect.objectContaining({ question: null, result, answerVerified: false })
    );
  });
});
