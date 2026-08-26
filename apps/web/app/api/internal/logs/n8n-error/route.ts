import { ObjectId } from "mongodb";
import { COLLECTIONS, getDb, redact, type AuditLogDoc } from "@line-crm/core";
import { readSignedJson } from "@/lib/internal";
import { fail, newRequestId, ok } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 10;

export async function POST(req: Request) {
  const requestId = newRequestId();
  const signed = await readSignedJson(req, requestId);
  if (!signed.ok) return signed.response;

  const payload = redact(signed.body) as Record<string, unknown>;
  const workflow = typeof payload.workflow === "string" ? payload.workflow : "unknown";
  const doc: AuditLogDoc = {
    _id: new ObjectId(),
    actor: `n8n:${workflow}`,
    action: "workflow.error",
    customerId: null,
    before: null,
    after: {
      executionId: typeof payload.executionId === "string" ? payload.executionId : null,
      workflow,
      node: typeof payload.node === "string" ? payload.node : null,
      message: typeof payload.message === "string" ? payload.message : "n8n execution failed",
    },
    reason: "n8n execution failed",
    at: new Date(),
  };

  try {
    await (await getDb()).collection<AuditLogDoc>(COLLECTIONS.auditLogs).insertOne(doc);
    return ok({ logged: true }, requestId);
  } catch {
    return fail("INTERNAL_ERROR", "บันทึก workflow error ไม่สำเร็จ", requestId);
  }
}
