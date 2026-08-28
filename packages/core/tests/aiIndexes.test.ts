import { describe, expect, it } from "vitest";
import { aiIndexMatchesSpec, type AiIndexSpec } from "../src/ai/indexes";

const spec: AiIndexSpec = {
  name: "ux_pair",
  key: { customerId: 1, legacyPersonId: 1 },
  unique: true,
};

describe("aiIndexMatchesSpec", () => {
  it("ผ่านเมื่อ key และ unique ตรงทั้งหมด", () => {
    expect(aiIndexMatchesSpec({ key: { customerId: 1, legacyPersonId: 1 }, unique: true }, spec)).toBe(true);
  });

  it("ไม่ผ่านเมื่อชื่อเดิมแต่ key หรือ unique ผิด", () => {
    expect(aiIndexMatchesSpec({ key: { customerId: 1 }, unique: true }, spec)).toBe(false);
    expect(aiIndexMatchesSpec({ key: { customerId: 1, legacyPersonId: 1 }, unique: false }, spec)).toBe(false);
  });
});
