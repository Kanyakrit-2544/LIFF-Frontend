import { describe, expect, it } from "vitest";
import { isAllowedStaffEmail, staffEmailAllowlist } from "../lib/adminAuth";

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
