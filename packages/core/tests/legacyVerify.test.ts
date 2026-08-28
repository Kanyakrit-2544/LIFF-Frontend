import { describe, expect, it } from "vitest";
import { legacyMirrorCountsOk } from "../src/legacy/verify";

describe("legacy mirror verify", () => {
  it("ผ่านเมื่อจำนวนเท่ากันและ dirty เป็นศูนย์ทุก collection", () => {
    expect(legacyMirrorCountsOk([
      { source: 1550, scrubbed: 1550, dirty: 0 },
      { source: 2017, scrubbed: 2017, dirty: 0 },
      { source: 2239, scrubbed: 2239, dirty: 0 },
    ])).toBe(true);
  });

  it("ไม่ผ่านเมื่อข้อมูล scrubbed ขาดหรือยังมี dirty", () => {
    expect(legacyMirrorCountsOk([{ source: 1550, scrubbed: 0, dirty: 0 }])).toBe(false);
    expect(legacyMirrorCountsOk([{ source: 1550, scrubbed: 1550, dirty: 1 }])).toBe(false);
  });
});
