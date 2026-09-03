import {
  claimDirtyCustomers,
  getDb,
  HEADERS,
  INTENT_SHEET_HEADERS,
  INTENT_SHEET_TAB,
  listIntentSheetReport,
  listSalesReport,
  log,
  SALES_SHEET_HEADERS,
  SALES_SHEET_TAB,
  SYSTEM_COLUMNS,
  toSalesSheetRows,
} from "@line-crm/core";
import { readSignedJson } from "@/lib/internal";
import { fail, newRequestId, ok } from "@/lib/http";
import { getAdminReviewDbs } from "@/lib/adminDb";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/internal/sheets/pending  (docs/03 §3.8)
 *
 * n8n มาดึงแถวที่รอซิงก์ — **การแปลง customer เป็นแถวทำที่นี่ ไม่ใช่ที่ n8n**
 * เพราะการเลือกว่าคอลัมน์ไหนเก็บอะไร และ PII จะแสดงเต็มหรือ mask เป็น business rule
 */
export async function POST(req: Request) {
  const requestId = newRequestId();
  const signed = await readSignedJson(req, requestId);
  if (!signed.ok) return signed.response;

  const raw = Number(signed.body.limit);
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(Math.floor(raw), 500)) : 200;

  try {
    const mainDb = await getDb();
    const { aiDb, legacyDb } = await getAdminReviewDbs();
    const [salesReport, intentReport] = await Promise.all([
      listSalesReport(mainDb, aiDb, legacyDb),
      listIntentSheetReport(mainDb),
    ]);
    const salesRows = toSalesSheetRows(salesReport);
    const { claimId, rows } = await claimDirtyCustomers(limit);
    log.info("จองแถวรอซิงก์ชีต", {
      requestId,
      claimed: rows.length,
      salesCustomers: salesReport.summary.totalCustomers,
      currentIntents: intentReport.values.length - 2,
    });
    return ok(
      {
        claimId,
        claimed: rows.length,
        rows,
        headers: HEADERS,
        systemColumnCount: SYSTEM_COLUMNS.length,
        salesReport: {
          tab: SALES_SHEET_TAB,
          headers: SALES_SHEET_HEADERS,
          columnCount: SALES_SHEET_HEADERS.length,
          values: salesRows,
        },
        intentReport: {
          tab: INTENT_SHEET_TAB,
          headers: INTENT_SHEET_HEADERS,
          columnCount: INTENT_SHEET_HEADERS.length,
          values: intentReport.values,
          summary: intentReport.summary,
        },
      },
      requestId
    );
  } catch (e) {
    log.error("ดึงแถวรอซิงก์ไม่สำเร็จ", { requestId, error: (e as Error).message });
    return fail("INTERNAL_ERROR", "ดึงแถวรอซิงก์ไม่สำเร็จ", requestId);
  }
}
