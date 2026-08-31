import {
  getDb,
  listCustomerLinkReviews,
  listPartnerReviews,
  listPendingMergeReviews,
  type CustomerLinkReviewItem,
  type PartnerReviewItem,
} from "@line-crm/core";
import { auth, signOut } from "@/auth";
import { getAdminAiDb, getAdminReviewDbs } from "@/lib/adminDb";
import { isAllowedStaffEmail } from "@/lib/adminAuth";
import { AlertTriangle, Check, CircleUserRound, Link2, LogOut, RefreshCw, ShoppingBag, X } from "lucide-react";
import { redirect } from "next/navigation";
import {
  assignPartnerAction,
  correctPartnerAction,
  decideLinkAction,
  decideMergeAction,
  rejectPartnerAction,
} from "./actions";

export const dynamic = "force-dynamic";

type Tab = "merge" | "links" | "partner";
type Search = Promise<{ tab?: string; notice?: string; error?: string }>;

function value(raw: Record<string, unknown>, key: string): string {
  const item = raw[key];
  return typeof item === "string" ? item : "";
}

function displayName(row: { displayName?: string | null; lineDisplayName?: string | null; _id: string }): string {
  return row.displayName || row.lineDisplayName || row._id;
}

function date(value: Date | null | undefined): string {
  return value ? new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(value) : "-";
}

function DecisionButtons({ disabled = false }: { disabled?: boolean }) {
  return (
    <div className="decision-buttons">
      <button className="confirm-button" name="decision" value="confirmed" disabled={disabled}><Check size={17} /> ยืนยัน</button>
      <button className="reject-button" name="decision" value="rejected" disabled={disabled}><X size={17} /> ปฏิเสธ</button>
    </div>
  );
}

function CustomerLinks({ items }: { items: CustomerLinkReviewItem[] }) {
  if (!items.length) return <div className="empty-state"><Check size={24} /><p>ไม่มีลิงก์รอตรวจ</p></div>;
  return <div className="review-list">{items.map(({ link, customer, legacyPerson, payments, enrollments, legacyAvailable }) => (
    <article className="review-item" key={link._id}>
      <header><div><span className="item-type">ประวัติลูกค้าเดิม</span><h2>{customer ? displayName(customer) : link.customerId}</h2></div><span className={`confidence ${link.confidence}`}>{link.confidence}</span></header>
      <div className="comparison-grid">
        <section><h3>ลูกค้าใน LINE CRM</h3><dl><dt>ชื่อ</dt><dd>{customer ? displayName(customer) : "ไม่พบข้อมูล"}</dd><dt>เบอร์</dt><dd>{customer?.phone || "-"}</dd><dt>อีเมล</dt><dd>{customer?.email || "-"}</dd></dl></section>
        <section><h3>ประวัติจากชีตเดิม</h3>{legacyPerson ? <dl><dt>ชื่อ</dt><dd>{legacyPerson.fullNameTh || legacyPerson.fullNameEn || "-"}</dd><dt>ชื่อเล่น</dt><dd>{legacyPerson.nickname || "-"}</dd><dt>เบอร์</dt><dd>{legacyPerson.phone || "-"}</dd><dt>อีเมล</dt><dd>{legacyPerson.email || "-"}</dd></dl> : <p className="warning-text">ยังอ่านฐาน legacy ต้นฉบับไม่ได้</p>}</section>
      </div>
      <div className="evidence-row"><span>เบอร์ตรง: <b>{link.evidence.phoneHashMatch ? "ใช่" : "ไม่ใช่"}</b></span><span>อีเมลตรง: <b>{link.evidence.emailHashMatch ? "ใช่" : "ไม่ใช่"}</b></span><span>ผู้สมัครอื่น: <b>{link.evidence.competingCandidates}</b></span><span>คะแนน: <b>{Math.round(link.score * 100)}%</b></span></div>
      {legacyPerson && <section className="history"><h3>ประวัติซื้อ</h3><p>{payments.length} การชำระ · {enrollments.length} รายการเรียน · รวม {legacyPerson.totalPaid.toLocaleString("th-TH")} บาท</p><ul>{enrollments.slice(0, 8).map((row) => <li key={row._id}>{row.courseLabel} · {row.kind} · {date(row.sessionStart)}</li>)}</ul></section>}
      <form action={decideLinkAction} className="decision-form">
        <input type="hidden" name="linkId" value={link._id}/><input type="hidden" name="legacyPersonId" value={link.legacyPersonId}/>
        <label>หมายเหตุ <input name="reason" maxLength={300} placeholder="เหตุผลประกอบการตัดสิน" /></label>
        {!legacyAvailable && <p className="warning-text"><AlertTriangle size={16}/> ต้องเชื่อมฐาน legacy ต้นฉบับก่อนจึงจะตัดสินได้</p>}
        <DecisionButtons disabled={!legacyAvailable}/>
      </form>
    </article>
  ))}</div>;
}

function PartnerCorrection({ item }: { item: PartnerReviewItem }) {
  const { event } = item;
  const raw = event.raw;
  if (event.type === "tag") return <p className="warning-text">ประเภท tag ยังไม่รองรับในระบบนี้ แก้เป็นประเภทอื่นไม่ได้</p>;
  if (event.type === "purchase") {
    const payment = raw.payment && typeof raw.payment === "object" && !Array.isArray(raw.payment) ? raw.payment as Record<string, unknown> : {};
    const lines = Array.isArray(payment.lines) ? payment.lines as Array<Record<string, unknown>> : [];
    return <>{lines.map((line, index) => <div className="line-editor" key={index}><label>ชื่อคอร์ส<input name={`courseLabel.${index}`} defaultValue={value(line, "courseLabel")} required /></label><label>รหัสคอร์ส<input name={`courseCode.${index}`} defaultValue={value(line, "courseCode")} /></label></div>)}<input type="hidden" name="lineCount" value={lines.length}/></>;
  }
  if (event.type === "intent") {
    const intent = raw.intent && typeof raw.intent === "object" && !Array.isArray(raw.intent) ? raw.intent as Record<string, unknown> : {};
    return <div className="line-editor"><label>รหัสคอร์ส<input name="courseCode" defaultValue={value(intent, "courseCode")} /></label><label>สถานะ<select name="intentStatus" defaultValue={value(intent, "status")}><option value="interested">สนใจ</option><option value="not_interested">ไม่สนใจ</option><option value="hesitant">ยังลังเล</option><option value="unknown">ยังไม่ทราบ</option></select></label><label>เหตุผลที่ลังเล<select name="hesitationReason" defaultValue={value(intent, "hesitationReason")}><option value="">ไม่มี</option><option value="budget">งบประมาณ</option><option value="not_needed">ยังไม่จำเป็น</option><option value="timing_conflict">เวลาไม่ตรง</option><option value="not_ready">ยังไม่พร้อม</option><option value="needs_approval">รออนุมัติ</option><option value="unknown">ไม่ทราบ</option></select></label></div>;
  }
  return <label>Event ที่ต้องการยกเลิก<input name="voids" defaultValue={value(raw, "voids")} required /></label>;
}

function PartnerItems({ items }: { items: PartnerReviewItem[] }) {
  if (!items.length) return <div className="empty-state"><Check size={24}/><p>ไม่มีรายการจาก partner รอตรวจ</p></div>;
  return <div className="review-list">{items.map((item) => {
    const { event, candidates } = item;
    const subject = event.raw.subject && typeof event.raw.subject === "object" && !Array.isArray(event.raw.subject) ? event.raw.subject as Record<string, unknown> : {};
    return <article className="review-item" key={event._id}>
      <header><div><span className="item-type">{event.partnerId} · {event.type}</span><h2>{event.status === "quarantined" ? "ข้อมูลต้องแก้ไข" : "ยังระบุตัวลูกค้าไม่ได้"}</h2></div><span className="status-badge">{event.status}</span></header>
      <p className="reason-box">เหตุผล: {event.reason || "ไม่ระบุ"}</p>
      <dl className="event-summary"><dt>ชื่อที่ส่งมา</dt><dd>{value(subject, "fullName") || "-"}</dd><dt>เบอร์</dt><dd>{value(subject, "phone") || "-"}</dd><dt>อีเมล</dt><dd>{value(subject, "email") || "-"}</dd><dt>รับเมื่อ</dt><dd>{date(event.receivedAt)}</dd></dl>
      {event.status === "pending_identity" ? <form action={assignPartnerAction} className="decision-form"><input type="hidden" name="partnerId" value={event.partnerId}/><input type="hidden" name="eventId" value={event.eventId}/><label>เลือกลูกค้า<select name="customerId" required defaultValue=""><option value="" disabled>เลือกลูกค้าที่ถูกต้อง</option>{candidates.map((candidate) => <option value={candidate.customerId} key={candidate.customerId}>{candidate.displayName || candidate.customerId} · ตรงจาก {candidate.matchedBy.join(" + ")}</option>)}</select></label>{candidates.length === 0 && <p className="warning-text">ไม่พบลูกค้าที่เบอร์หรืออีเมลตรงกัน</p>}<label>หมายเหตุ<input name="reason" maxLength={300}/></label><button className="confirm-button" disabled={candidates.length === 0}><Check size={17}/> ยืนยันลูกค้า</button></form> : <form action={correctPartnerAction} className="decision-form"><input type="hidden" name="partnerId" value={event.partnerId}/><input type="hidden" name="eventId" value={event.eventId}/><input type="hidden" name="type" value={event.type}/><PartnerCorrection item={item}/><label>หมายเหตุ<input name="reason" maxLength={300}/></label><button className="confirm-button" disabled={event.type === "tag"}><RefreshCw size={17}/> บันทึกและประมวลผลใหม่</button></form>}
      <form action={rejectPartnerAction} className="reject-row"><input type="hidden" name="partnerId" value={event.partnerId}/><input type="hidden" name="eventId" value={event.eventId}/><input name="reason" maxLength={300} placeholder="เหตุผลที่ปฏิเสธ" required/><button className="reject-button"><X size={17}/> ปฏิเสธรายการ</button></form>
    </article>;
  })}</div>;
}

export default async function ReviewPage({ searchParams }: { searchParams: Search }) {
  const session = await auth();
  if (!isAllowedStaffEmail(session?.user?.email)) redirect("/admin/login");
  const staffEmail = session?.user?.email ?? "";
  const params = await searchParams;
  const tab: Tab = params.tab === "links" || params.tab === "partner" ? params.tab : "merge";
  const mainDb = await getDb();
  const [merges, partners] = await Promise.all([listPendingMergeReviews(mainDb), listPartnerReviews(mainDb)]);
  let links: CustomerLinkReviewItem[] = [];
  let linkDbError = false;
  try {
    const { aiDb, legacyDb } = await getAdminReviewDbs();
    links = await listCustomerLinkReviews(mainDb, aiDb, legacyDb);
  } catch {
    try {
      links = await listCustomerLinkReviews(mainDb, await getAdminAiDb(), null);
    } catch {
      linkDbError = true;
    }
  }

  return <main className="admin-shell"><header className="topbar"><div><span className="eyebrow">LINE CRM</span><h1>รายการรอพนักงานตรวจ</h1></div><div className="staff-menu"><span><CircleUserRound size={17}/>{staffEmail}</span><form action={async () => { "use server"; await signOut({ redirectTo: "/admin/login" }); }}><button className="icon-button" title="ออกจากระบบ"><LogOut size={18}/><span className="sr-only">ออกจากระบบ</span></button></form></div></header>
    <nav className="tabs" aria-label="ประเภทงานรอตรวจ"><a className={tab === "merge" ? "active" : ""} href="?tab=merge"><CircleUserRound size={18}/> ลูกค้าซ้ำ <b>{merges.length}</b></a><a className={tab === "links" ? "active" : ""} href="?tab=links"><Link2 size={18}/> ประวัติเก่า <b>{links.length}</b></a><a className={tab === "partner" ? "active" : ""} href="?tab=partner"><ShoppingBag size={18}/> Partner <b>{partners.length}</b></a></nav>
    {params.notice && <p className="notice"><Check size={17}/>{params.notice}</p>}{params.error && <p className="error-notice"><AlertTriangle size={17}/>{params.error}</p>}
    {tab === "merge" && (merges.length ? <div className="review-list">{merges.map(({ customer, candidate, evidence }) => <article className="review-item" key={customer._id}><header><div><span className="item-type">ลูกค้าที่อาจซ้ำกัน</span><h2>{displayName(customer)} ↔ {displayName(candidate)}</h2></div><span className="status-badge">รอตรวจ</span></header><div className="comparison-grid"><section><h3>รายการที่เพิ่งเข้ามา</h3><dl><dt>ชื่อ</dt><dd>{displayName(customer)}</dd><dt>เบอร์</dt><dd>{customer.phone || "-"}</dd><dt>อีเมล</dt><dd>{customer.email || "-"}</dd><dt>สร้างเมื่อ</dt><dd>{date(customer.createdAt)}</dd></dl></section><section><h3>ลูกค้าที่มีอยู่แล้ว</h3><dl><dt>ชื่อ</dt><dd>{displayName(candidate)}</dd><dt>เบอร์</dt><dd>{candidate.phone || "-"}</dd><dt>อีเมล</dt><dd>{candidate.email || "-"}</dd><dt>สร้างเมื่อ</dt><dd>{date(candidate.createdAt)}</dd></dl></section></div><div className="evidence-row"><span>เบอร์ตรง: <b>{evidence.phoneMatch ? "ใช่" : "ไม่ใช่"}</b></span><span>อีเมลตรง: <b>{evidence.emailMatch ? "ใช่" : "ไม่ใช่"}</b></span><span>เหตุผล: <b>{evidence.reason}</b></span></div><form action={decideMergeAction} className="decision-form"><input type="hidden" name="customerId" value={customer._id}/><input type="hidden" name="candidateId" value={candidate._id}/><label>หมายเหตุ<input name="reason" maxLength={300} placeholder="เหตุผลประกอบการตัดสิน"/></label><DecisionButtons/></form></article>)}</div> : <div className="empty-state"><Check size={24}/><p>ไม่มีลูกค้าซ้ำรอตรวจ</p></div>)}
    {tab === "links" && <>{linkDbError && <p className="error-notice"><AlertTriangle size={17}/> ยังเชื่อมฐาน AI สำหรับหน้าตรวจไม่ได้</p>}<CustomerLinks items={links}/></>}
    {tab === "partner" && <PartnerItems items={partners}/>}</main>;
}
