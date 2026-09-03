import { auth } from "@/auth";
import { isAllowedStaffEmail } from "@/lib/adminAuth";
import { getDb, listPostAnalytics } from "@line-crm/core";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const session = await auth();
  if (!isAllowedStaffEmail(session?.user?.email)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }
  const params = new URL(request.url).searchParams;
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  try {
    return NextResponse.json(await listPostAnalytics(await getDb(), { from, to }));
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: "INVALID_QUERY",
      message: error instanceof Error ? error.message : "ช่วงวันที่ไม่ถูกต้อง",
    }, { status: 400 });
  }
}
