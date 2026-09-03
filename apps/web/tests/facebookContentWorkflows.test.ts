import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const load = (name: string) => JSON.parse(fs.readFileSync(path.resolve(process.cwd(), `../../workflows/${name}`), "utf8"));

describe("Facebook content workflows", () => {
  it("WF-J รัน 07:00 Bangkok และ refresh 90 วันผ่าน HMAC endpoint", () => {
    const workflow = load("WF-J-facebook-posts.json");
    const text = JSON.stringify(workflow);
    expect(workflow.settings.timezone).toBe("Asia/Bangkok");
    expect(text).toContain("0 7 * * *");
    expect(text).toContain("days: 90");
    expect(text).toContain("/api/internal/facebook/posts");
    expect(text).toContain("x-signature");
  });

  it("WF-K เขียนเฉพาะชีตการตลาดครบ 3 tab", () => {
    const text = JSON.stringify(load("WF-K-marketing-sheets.json"));
    expect(text).toContain("GOOGLE_SHEET_ID_MARKETING");
    expect(text).toContain("/api/internal/sheets/marketing");
    for (const tab of ["Customers", "FB Leads", "FB Posts"]) expect(text).toContain(tab);
    expect(text).not.toContain("/api/internal/sheets/pending");
    expect(text).not.toContain("สรุปการขาย");
  });
});
