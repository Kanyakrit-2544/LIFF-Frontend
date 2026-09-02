import { describe, expect, it } from "vitest";
import type { NextAuthConfig } from "next-auth";
import { buildAuthConfig } from "../lib/authConfig";
import { isAllowedStaffEmail, staffEmailAllowlist } from "../lib/adminAuth";

type ResolvedProvider = {
  id: string;
  options?: {
    authorize?: (credentials: Partial<Record<string, unknown>>, request: Request) => unknown;
  };
};

function provider(config: NextAuthConfig, id: string): ResolvedProvider | undefined {
  for (const value of config.providers) {
    const resolved = typeof value === "function" ? value() : value;
    if (resolved.id === id) return resolved as ResolvedProvider;
  }
  return undefined;
}

const env = (overrides: Record<string, string>) => ({
  NODE_ENV: "development",
  DEV_AUTH_ENABLED: "true",
  DEV_ADMIN_EMAIL: "admin@example.com",
  STAFF_EMAIL_ALLOWLIST: "admin@example.com",
  ...overrides,
});

describe("staff admin allowlist", () => {
  it("รับเฉพาะอีเมลที่อยู่ใน allowlist โดยไม่สนตัวพิมพ์ใหญ่เล็ก", () => {
    const source = " owner@example.com,STAFF@example.com ";
    expect(isAllowedStaffEmail("Owner@Example.com", source)).toBe(true);
    expect(isAllowedStaffEmail("other@example.com", source)).toBe(false);
    expect(staffEmailAllowlist(source).size).toBe(2);
  });

  it("allowlist ว่างต้องไม่เปิดสิทธิ์ให้ใคร", () => {
    expect(isAllowedStaffEmail("owner@example.com", "")).toBe(false);
    expect(isAllowedStaffEmail(null, "owner@example.com")).toBe(false);
  });
});

describe("dev admin login", () => {
  it("production ไม่มี credentials provider แม้เปิด flag", () => {
    const config = buildAuthConfig(env({ NODE_ENV: "production" }));
    expect(provider(config, "credentials")).toBeUndefined();
  });

  it("ปฏิเสธ DEV_ADMIN_EMAIL ที่ไม่อยู่ใน allowlist", async () => {
    const config = buildAuthConfig(env({ STAFF_EMAIL_ALLOWLIST: "owner@example.com" }));
    const credentials = provider(config, "credentials");
    expect(credentials).toBeDefined();
    const user = await credentials!.options?.authorize?.({}, new Request("http://localhost/admin/login"));
    expect(user).toBeNull();
  });

  it("อนุญาต DEV_ADMIN_EMAIL เมื่อเปิดเฉพาะ dev และอยู่ใน allowlist", async () => {
    const config = buildAuthConfig(env({}));
    const credentials = provider(config, "credentials");
    expect(credentials).toBeDefined();
    const user = await credentials!.options?.authorize?.({}, new Request("http://localhost/admin/login"));
    expect(user).toMatchObject({
      email: "admin@example.com",
    });
  });
});
