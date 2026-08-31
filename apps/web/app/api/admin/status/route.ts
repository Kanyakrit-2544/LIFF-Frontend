import { auth } from "@/auth";
import { isAllowedStaffEmail } from "@/lib/adminAuth";
import { checkSystemStatus } from "@line-crm/core";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!isAllowedStaffEmail(session?.user?.email)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }
  const status = await checkSystemStatus();
  return NextResponse.json({
    ...status,
    checkedAt: status.checkedAt.toISOString(),
  }, { status: status.ok ? 200 : 503 });
}
