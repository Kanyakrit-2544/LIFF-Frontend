import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), getDb: vi.fn(), listPostAnalytics: vi.fn() }));
vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("@line-crm/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@line-crm/core")>(),
  getDb: mocks.getDb,
  listPostAnalytics: mocks.listPostAnalytics,
}));

import { GET } from "../app/api/admin/facebook-posts/route";

const request = () => new Request("https://example.test/api/admin/facebook-posts?from=2026-08-01&to=2026-08-31");

describe("GET /api/admin/facebook-posts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STAFF_EMAIL_ALLOWLIST = "staff@example.test";
    mocks.auth.mockResolvedValue({ user: { email: "staff@example.test" } });
    mocks.getDb.mockResolvedValue({ name: "main" });
    mocks.listPostAnalytics.mockResolvedValue({ rows: [], summary: { totalPosts: 0 } });
  });

  it("คนไม่ล็อกอินถูกปฏิเสธก่อนต่อฐาน", async () => {
    mocks.auth.mockResolvedValue(null);
    expect((await GET(request())).status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("อีเมลนอก allowlist ถูกปฏิเสธก่อนต่อฐาน", async () => {
    mocks.auth.mockResolvedValue({ user: { email: "outsider@example.test" } });
    expect((await GET(request())).status).toBe(401);
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("พนักงานที่ได้รับอนุญาตได้ผลจาก core ตามช่วงวันที่", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(mocks.listPostAnalytics).toHaveBeenCalledWith({ name: "main" }, { from: "2026-08-01", to: "2026-08-31" });
  });
});
