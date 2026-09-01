import { auth, signOut } from "@/auth";
import { AdminNav } from "@/app/admin/AdminNav";
import { isAllowedStaffEmail } from "@/lib/adminAuth";
import { getAdminAiDb } from "@/lib/adminDb";
import { analyticsQuerySchema, createLlmProvider, runAnalytics } from "@line-crm/core";
import { BarChart3, CircleUserRound, LogOut } from "lucide-react";
import { redirect } from "next/navigation";
import React from "react";
import { AnalyticsDashboard } from "./AnalyticsDashboard";

export const dynamic = "force-dynamic";

function currentBangkokMonth(): { from: string; to: string } {
  const local = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  const monthText = String(month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${year}-${monthText}-01`, to: `${year}-${monthText}-${String(lastDay).padStart(2, "0")}` };
}

function hasLlm(): boolean {
  try {
    return createLlmProvider() !== null;
  } catch {
    return false;
  }
}

export default async function AnalyticsPage() {
  const session = await auth();
  if (!isAllowedStaffEmail(session?.user?.email)) redirect("/admin/login");
  const staffEmail = session?.user?.email ?? "";
  const range = currentBangkokMonth();
  const initialQuery = analyticsQuerySchema.parse({ metric: "revenue", ...range, groupBy: "month" });
  const initialResult = await runAnalytics(await getAdminAiDb(), initialQuery);

  return <main className="admin-shell analytics-page">
    <header className="topbar">
      <div><span className="eyebrow">LINE CRM</span><h1><BarChart3 size={30}/> Analytics</h1></div>
      <div className="staff-menu">
        <span><CircleUserRound size={17}/>{staffEmail}</span>
        <form action={async () => { "use server"; await signOut({ redirectTo: "/admin/login" }); }}>
          <button className="icon-button" title="ออกจากระบบ"><LogOut size={18}/><span className="sr-only">ออกจากระบบ</span></button>
        </form>
      </div>
    </header>
    <AdminNav active="analytics"/>
    <AnalyticsDashboard initialQuery={initialQuery} initialResult={initialResult} llmAvailable={hasLlm()}/>
  </main>;
}
