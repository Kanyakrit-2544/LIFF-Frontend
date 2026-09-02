import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getDb: vi.fn(),
  findOne: vi.fn(),
  updateOne: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@line-crm/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@line-crm/core")>(),
  getDb: mocks.getDb,
}));

import { markRecommendation } from "../app/admin/opportunities/actions";

function form(status: "done" | "skipped" = "done"): FormData {
  const result = new FormData();
  result.set("recoId", "follow_up:cus_TEST_1:INNER");
  result.set("status", status);
  return result;
}

describe("markRecommendation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STAFF_EMAIL_ALLOWLIST = "staff@example.test";
    mocks.auth.mockResolvedValue({ user: { email: "staff@example.test" } });
    mocks.findOne.mockResolvedValue({ _id: "cus_TEST_1", status: "active", seedTag: "sales-demo", synthetic: true });
    mocks.updateOne.mockResolvedValue({ upsertedCount: 1 });
    mocks.getDb.mockResolvedValue({
      collection: vi.fn((name: string) => name === "customers"
        ? { findOne: mocks.findOne }
        : { updateOne: mocks.updateOne }),
    });
  });

  it("ไม่อนุญาตให้คนนอก allowlist เขียน review", async () => {
    mocks.auth.mockResolvedValue({ user: { email: "outsider@example.test" } });
    await expect(markRecommendation(form())).rejects.toThrow("staff_unauthorized");
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it("บันทึกครั้งแรกแบบ idempotent และคง seedTag สำหรับ cleanup", async () => {
    await expect(markRecommendation(form())).rejects.toThrow("redirect:/admin/opportunities");
    expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: "follow_up:cus_TEST_1:INNER" },
      { $setOnInsert: expect.objectContaining({
        _id: "follow_up:cus_TEST_1:INNER",
        type: "follow_up",
        customerId: "cus_TEST_1",
        courseCode: "INNER",
        status: "done",
        staffEmail: "staff@example.test",
        seedTag: "sales-demo",
        synthetic: true,
      }) },
      { upsert: true }
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin/opportunities");
  });
});
