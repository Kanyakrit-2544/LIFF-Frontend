import { getCustomerProfile, getDb, type CustomerPurchaseRow } from "@line-crm/core";
import { auth, signOut } from "@/auth";
import { isAllowedStaffEmail } from "@/lib/adminAuth";
import { getAdminReviewDbs } from "@/lib/adminDb";
import {
  AlertTriangle,
  ArrowLeft,
  CircleUserRound,
  GraduationCap,
  Link2,
  LogOut,
  ReceiptText,
  WalletCards,
} from "lucide-react";
import { notFound, redirect } from "next/navigation";
import React from "react";

export const dynamic = "force-dynamic";

const kindLabel: Record<string, string> = {
  enrolled: "ลงเรียน",
  relearn: "เรียนซ้ำ",
  free: "ฟรี",
  waitlist: "รอที่นั่ง",
  transfer: "โอนสิทธิ์",
  refund: "คืนเงิน",
  merchandise: "สินค้า",
};

function date(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeZone: "Asia/Bangkok" }).format(new Date(value))
    : "-";
}

function money(value: number | null): string {
  return value === null ? "-" : `${value.toLocaleString("th-TH")} บาท`;
}

function sourceLabel(source: CustomerPurchaseRow["source"]): string {
  return source === "partner" ? "ระบบขาย" : "ประวัติเก่า";
}

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!isAllowedStaffEmail(session?.user?.email)) redirect("/admin/login");
  const staffEmail = session?.user?.email ?? "";
  const { id } = await params;
  const mainDb = await getDb();
  const { aiDb, legacyDb } = await getAdminReviewDbs();
  const profile = await getCustomerProfile(mainDb, aiDb, legacyDb, id);
  if (!profile) notFound();

  const erased = profile.status === "erased";
  const profileName = erased ? "ลูกค้าที่ลบข้อมูลแล้ว" : profile.displayName || profile.customerId;

  return <main className="admin-shell customer-profile-page">
    <header className="topbar">
      <div>
        <a className="back-link" href="/admin/review"><ArrowLeft size={17}/> รายการรอตรวจ</a>
        <h1>{profileName}</h1>
      </div>
      <div className="staff-menu">
        <span><CircleUserRound size={17}/>{staffEmail}</span>
        <form action={async () => { "use server"; await signOut({ redirectTo: "/admin/login" }); }}>
          <button className="icon-button" title="ออกจากระบบ"><LogOut size={18}/><span className="sr-only">ออกจากระบบ</span></button>
        </form>
      </div>
    </header>

    {erased && <p className="error-notice"><AlertTriangle size={17}/> ลูกค้ารายนี้ขอลบข้อมูลส่วนบุคคลแล้ว ระบบจึงไม่แสดงชื่อ เบอร์ และอีเมล</p>}
    {profile.hasUnconfirmedLinks && <p className="profile-warning"><AlertTriangle size={18}/><span>มีประวัติที่ระบบเดาว่าอาจเป็นคนนี้แต่ยังไม่ยืนยัน ประวัติส่วนนั้นถูกซ่อนไว้</span><a href="/admin/review?tab=links"><Link2 size={16}/> ไปยืนยันที่แท็บประวัติเก่า</a></p>}

    <section className="profile-identity" aria-labelledby="identity-title">
      <div className="section-heading"><CircleUserRound size={20}/><h2 id="identity-title">ข้อมูลลูกค้า</h2><span className="status-badge">{profile.status}</span></div>
      <dl>
        <dt>ชื่อ</dt><dd>{profile.displayName || "-"}</dd>
        <dt>เบอร์</dt><dd>{profile.phone || "-"}</dd>
        <dt>อีเมล</dt><dd>{profile.email || "-"}</dd>
        <dt>สถานะลูกค้า</dt><dd>{profile.customerStatus}</dd>
        <dt>เห็นเราจาก</dt><dd>{profile.heardFrom || "-"}</dd>
        <dt>รหัสลูกค้า</dt><dd>{profile.customerId}</dd>
      </dl>
    </section>

    <section className="profile-summary" aria-label="สรุปการซื้อ">
      <div><WalletCards size={19}/><span>ยอดชำระรวม</span><strong>{money(profile.totalPaid)}</strong></div>
      <div><ReceiptText size={19}/><span>จำนวนการชำระ</span><strong>{profile.paymentCount.toLocaleString("th-TH")} ครั้ง</strong></div>
      <div><GraduationCap size={19}/><span>ที่นั่งที่ขายได้</span><strong>{profile.seatCount.toLocaleString("th-TH")} ที่นั่ง</strong></div>
      <div><span>ชำระครั้งแรก</span><strong>{date(profile.firstPaidAt)}</strong></div>
      <div><span>ชำระล่าสุด</span><strong>{date(profile.lastPaidAt)}</strong></div>
      <div><span>คอร์สที่เคยมีรายการ</span><strong>{profile.courseCodes.join(", ") || "-"}</strong></div>
    </section>

    <section className="purchase-history" aria-labelledby="history-title">
      <div className="section-heading"><ReceiptText size={20}/><h2 id="history-title">ไทม์ไลน์การซื้อ</h2></div>
      {profile.purchases.length === 0
        ? <div className="empty-state"><ReceiptText size={24}/><p>ยังไม่มีประวัติซื้อที่ยืนยันแล้ว</p></div>
        : <div className="table-scroll"><table>
          <thead><tr><th>วันที่ชำระ</th><th>แหล่งข้อมูล</th><th>คอร์ส</th><th>ยอดชำระ</th><th>เซล</th></tr></thead>
          <tbody>{profile.purchases.map((purchase, index) => <tr key={`${purchase.source}-${purchase.paidAt ?? "none"}-${index}`}>
            <td>{date(purchase.paidAt)}</td>
            <td><span className={`source-label ${purchase.source}`}>{sourceLabel(purchase.source)}</span></td>
            <td>{purchase.courses.length
              ? <ul className="course-list">{purchase.courses.map((item, courseIndex) => <li key={`${item.courseCode}-${courseIndex}`}><strong>{item.courseNameTh}</strong><span>{item.courseCode} · {kindLabel[item.kind] ?? item.kind}{item.sessionLabel ? ` · ${item.sessionLabel}` : ""}</span></li>)}</ul>
              : "-"}</td>
            <td className="money-cell">{money(purchase.amount)}</td>
            <td>{purchase.saleRep || "-"}</td>
          </tr>)}</tbody>
        </table></div>}
    </section>
  </main>;
}
