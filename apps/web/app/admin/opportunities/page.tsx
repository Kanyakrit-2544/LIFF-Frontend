import { AdminNav } from "@/app/admin/AdminNav";
import { auth, signOut } from "@/auth";
import { isAllowedStaffEmail } from "@/lib/adminAuth";
import { getAdminReviewDbs } from "@/lib/adminDb";
import {
  getDb,
  listSalesOpportunities,
} from "@line-crm/core";
import {
  AlertTriangle,
  Check,
  CircleUserRound,
  Clock3,
  LogOut,
  Target,
  WalletCards,
} from "lucide-react";
import { redirect } from "next/navigation";
import React from "react";
import { FollowUpList, UpsellList } from "./OpportunityLists";

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage({
  searchParams,
}: {
  searchParams?: Promise<{ notice?: string }>;
}) {
  const session = await auth();
  if (!isAllowedStaffEmail(session?.user?.email)) redirect("/admin/login");
  const staffEmail = session?.user?.email ?? "";
  const mainDb = await getDb();
  const { aiDb, legacyDb } = await getAdminReviewDbs();
  const opportunities = await listSalesOpportunities(mainDb, aiDb, legacyDb);
  const params = await searchParams;

  return <main className="admin-shell opportunities-page">
    <header className="topbar">
      <div><span className="eyebrow">LINE CRM</span><h1><Target size={30}/> โอกาสการขาย</h1></div>
      <div className="staff-menu">
        <span><CircleUserRound size={17}/>{staffEmail}</span>
        <form action={async () => { "use server"; await signOut({ redirectTo: "/admin/login" }); }}>
          <button className="icon-button" title="ออกจากระบบ"><LogOut size={18}/><span className="sr-only">ออกจากระบบ</span></button>
        </form>
      </div>
    </header>
    <AdminNav active="opportunities"/>
    {params?.notice && <p className="notice"><Check size={17}/>{params.notice}</p>}
    <p className="human-loop-note"><AlertTriangle size={18}/><span>รายการเหล่านี้เป็นคำแนะนำให้พนักงานพิจารณา ระบบจะไม่ส่งข้อความ โปรโมชัน หรือโฆษณาอัตโนมัติ</span></p>

    <section className="opportunity-section" aria-labelledby="follow-up-title">
      <header><div><h2 id="follow-up-title"><WalletCards size={21}/> คนลังเล ควรตามผล</h2><p>แสดงเฉพาะผู้ที่ยินยอมรับการตลาดและยังไม่ซื้อคอร์สที่สนใจ</p></div><b>{opportunities.followUps.length}</b></header>
      <p className="confidence-warning"><AlertTriangle size={16}/> ความมั่นใจมาจาก AI tagger ที่ยังอยู่ระหว่างตรวจความแม่น พนักงานต้องอ่านเหตุผลประกอบทุกครั้ง</p>
      <FollowUpList items={opportunities.followUps}/>
    </section>

    <section className="opportunity-section" aria-labelledby="upsell-title">
      <header><div><h2 id="upsell-title"><Clock3 size={21}/> เรียนจบแล้ว แนะนำคอร์สถัดไป</h2><p>อ้างอิงวันที่เรียนที่ผ่านมาและประวัติเก่าที่พนักงานยืนยันตัวตนแล้วเท่านั้น</p></div><b>{opportunities.upsells.length}</b></header>
      <UpsellList items={opportunities.upsells}/>
    </section>
  </main>;
}
