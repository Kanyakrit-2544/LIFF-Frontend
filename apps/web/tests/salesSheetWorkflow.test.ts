import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface WorkflowNode {
  name: string;
  parameters: Record<string, unknown> & { jsCode?: string; url?: string };
}

const workflow = JSON.parse(fs.readFileSync(
  path.resolve(process.cwd(), "../../workflows/WF-C-sheets-sync.json"),
  "utf8"
)) as {
  nodes: WorkflowNode[];
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
};
const node = (name: string) => workflow.nodes.find((item) => item.name === name)!;

describe("WF-C sales report", () => {
  it("รันต่อได้แม้ไม่มี dirty customer เพราะยังมีรายงาน", () => {
    expect(JSON.stringify(node("Has Rows?").parameters)).toContain("salesReport");
    expect(JSON.stringify(node("Has Rows?").parameters)).toContain("intentReport");
  });

  it("ล้างแท็บเก่าก่อนเขียนรายงานชุดใหม่", () => {
    expect(node("Clear Sales Report").parameters.url).toContain(":clear");
    expect(workflow.connections["Read Keys"]!.main[0]![0]!.node).toBe("Clear Sales Report");
    expect(workflow.connections["Clear Sales Report"]!.main[0]![0]!.node).toBe("Clear Intent Report");
  });

  it("Plan Writes เขียน salesReport จาก core ลง batch เดียวกับข้อมูลลูกค้า", () => {
    expect(node("Plan Writes").parameters.jsCode).toContain("claim.salesReport");
    expect(node("Plan Writes").parameters.jsCode).toContain("report.values");
  });

  it("ล้าง Intent!A:G แล้วเขียน intentReport ใน batch เดียว โดยไม่แตะชีตการตลาด", () => {
    expect(node("Clear Intent Report").parameters.url).toContain("intentReport.tab + '!A:G'");
    expect(workflow.connections["Clear Sales Report"]!.main[0]![0]!.node).toBe("Clear Intent Report");
    expect(workflow.connections["Clear Intent Report"]!.main[0]![0]!.node).toBe("Plan Writes");
    expect(node("Plan Writes").parameters.jsCode).toContain("claim.intentReport");
    expect(node("Plan Writes").parameters.jsCode).toContain("intent.values");
    expect(node("Plan Writes").parameters.jsCode).toContain("data.push");
    expect(JSON.stringify(workflow)).not.toContain("GOOGLE_SHEET_ID_MARKETING");
  });
});
