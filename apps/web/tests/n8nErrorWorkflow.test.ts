import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("WF-E error extraction", () => {
  it("อ่าน error จริงจาก execution.error และ redact PII", () => {
    const file = path.resolve(process.cwd(), "../../workflows/WF-E-error-handler.json");
    const workflow = JSON.parse(fs.readFileSync(file, "utf8")) as { nodes: Array<{ name: string; parameters: { jsCode?: string } }> };
    const code = workflow.nodes.find((node) => node.name === "Redact")?.parameters.jsCode;
    expect(code).toContain("src.execution?.error");
    const execute = new Function("$json", code!) as (input: unknown) => Array<{ json: { payload: Record<string, unknown> } }>;
    const [item] = execute({
      execution: { id: "123", lastNodeExecuted: "Claim Rows", error: { message: "Authorization failed for 081-234-5678 staff@example.com" } },
      workflow: { name: "WF-C" },
    });
    expect(item!.json.payload).toMatchObject({
      executionId: "123",
      workflow: "WF-C",
      node: "Claim Rows",
      message: "Authorization failed for [PHONE] [EMAIL]",
    });
  });
});
