import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  signOut: vi.fn(),
  getDb: vi.fn(),
  getCustomerProfile: vi.fn(),
  getAdminReviewDbs: vi.fn(),
  redirect: vi.fn((path: string) => { throw new Error(`redirect:${path}`); }),
  notFound: vi.fn(() => { throw new Error("not-found"); }),
}));

vi.mock("@/auth", () => ({ auth: mocks.auth, signOut: mocks.signOut }));
vi.mock("@/lib/adminDb", () => ({ getAdminReviewDbs: mocks.getAdminReviewDbs }));
vi.mock("@line-crm/core", () => ({ getDb: mocks.getDb, getCustomerProfile: mocks.getCustomerProfile }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));

import CustomerPage from "../app/admin/customer/[id]/page";

describe("หน้าโปรไฟล์ลูกค้า admin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.STAFF_EMAIL_ALLOWLIST = "staff@example.test";
  });

  it("ไม่ล็อกอินต้อง redirect ไปหน้า admin login ก่อนต่อฐาน", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(CustomerPage({ params: Promise.resolve({ id: "cus_1" }) })).rejects.toThrow("redirect:/admin/login");
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/login");
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getAdminReviewDbs).not.toHaveBeenCalled();
  });

  it("อีเมลนอก allowlist ต้องเข้าไม่ได้และยังไม่ต่อฐาน", async () => {
    mocks.auth.mockResolvedValue({ user: { email: "outsider@example.test" } });

    await expect(CustomerPage({ params: Promise.resolve({ id: "cus_1" }) })).rejects.toThrow("redirect:/admin/login");
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/login");
    expect(mocks.getDb).not.toHaveBeenCalled();
    expect(mocks.getAdminReviewDbs).not.toHaveBeenCalled();
  });

  it("พนักงานใน allowlist อ่านโปรไฟล์ผ่าน core ด้วยฐานทั้งสาม", async () => {
    const mainDb = { name: "main" };
    const aiDb = { name: "ai" };
    const legacyDb = { name: "legacy" };
    mocks.auth.mockResolvedValue({ user: { email: "staff@example.test" } });
    mocks.getDb.mockResolvedValue(mainDb);
    mocks.getAdminReviewDbs.mockResolvedValue({ aiDb, legacyDb });
    mocks.getCustomerProfile.mockResolvedValue({
      customerId: "cus_1",
      displayName: "ลูกค้าทดสอบ",
      phone: null,
      email: null,
      heardFrom: null,
      customerStatus: "customer",
      status: "active",
      totalPaid: 0,
      paymentCount: 0,
      seatCount: 0,
      firstPaidAt: null,
      lastPaidAt: null,
      courseCodes: [],
      purchases: [],
      linkedLegacyPersonIds: [],
      hasUnconfirmedLinks: false,
      legacyHidden: false,
    });

    const result = await CustomerPage({ params: Promise.resolve({ id: "cus_1" }) });
    expect(result).toBeTruthy();
    expect(mocks.getCustomerProfile).toHaveBeenCalledWith(mainDb, aiDb, legacyDb, "cus_1");
  });
});
