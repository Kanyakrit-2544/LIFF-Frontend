import type { FollowUpReco, UpsellReco } from "@line-crm/core";
import { AlertTriangle, Check, ExternalLink, GraduationCap, SkipForward } from "lucide-react";
import React from "react";
import { markRecommendation } from "./actions";

const reasonLabel: Record<string, string> = {
  budget: "งบประมาณ",
  not_needed: "ยังไม่เห็นความจำเป็น",
  timing_conflict: "เวลาไม่ลงตัว",
  not_ready: "ยังไม่พร้อม",
  needs_approval: "รอผู้มีอำนาจอนุมัติ",
  unknown: "ยังระบุไม่ได้",
};

function date(value: Date): string {
  return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeZone: "Asia/Bangkok" }).format(value);
}

function confidence(value: number): string {
  return new Intl.NumberFormat("th-TH", { style: "percent", maximumFractionDigits: 0 }).format(value);
}

function ActionButtons({ recoId }: { recoId: string }) {
  return <form action={markRecommendation} className="opportunity-actions">
    <input type="hidden" name="recoId" value={recoId}/>
    <button className="confirm-button" name="status" value="done"><Check size={17}/> ทำแล้ว</button>
    <button className="reject-button" name="status" value="skipped"><SkipForward size={17}/> ข้าม</button>
  </form>;
}

function SyntheticBadge({ visible }: { visible: boolean }) {
  return visible ? <span className="synthetic-badge"><AlertTriangle size={14}/> ข้อมูลจำลอง</span> : null;
}

export function FollowUpList({ items }: { items: FollowUpReco[] }) {
  if (items.length === 0) return <div className="empty-state compact"><Check size={24}/><p>ไม่มีคนลังเลที่เข้าเงื่อนไขการติดตาม</p></div>;
  return <div className="opportunity-list">{items.map((item) => <article className="opportunity-row" key={item.recoId}>
    <div className="opportunity-main">
      <div className="opportunity-title"><h3>{item.customerName}</h3><SyntheticBadge visible={item.synthetic}/></div>
      <p className="course-pair"><strong>{item.courseName}</strong><span>{item.courseCode}</span></p>
      <dl className="opportunity-facts">
        <dt>เหตุผลที่ลังเล</dt><dd>{item.hesitationReason ? reasonLabel[item.hesitationReason] ?? item.hesitationReason : "ไม่ได้ระบุ"}</dd>
        <dt>ความมั่นใจ AI</dt><dd><span className="confidence neutral">{confidence(item.confidence)}</span></dd>
        <dt>พบล่าสุด</dt><dd>{date(item.observedAt)}</dd>
      </dl>
    </div>
    <div className="opportunity-decision">
      <span>คำแนะนำ</span><strong>{item.suggestedAction}</strong>
      <a className="profile-link" href={`/admin/customer/${encodeURIComponent(item.customerId)}`}><ExternalLink size={15}/> ดูโปรไฟล์</a>
      <ActionButtons recoId={item.recoId}/>
    </div>
  </article>)}</div>;
}

export function UpsellList({ items }: { items: UpsellReco[] }) {
  if (items.length === 0) return <div className="empty-state compact"><Check size={24}/><p>ยังไม่มีผู้เรียนที่เข้าเงื่อนไขแนะนำคอร์สถัดไป</p></div>;
  return <div className="opportunity-list">{items.map((item) => <article className="opportunity-row" key={item.recoId}>
    <div className="opportunity-main">
      <div className="opportunity-title"><h3>{item.customerName}</h3><SyntheticBadge visible={item.synthetic}/></div>
      <p className="completed-course"><GraduationCap size={17}/><span>จบ <strong>{item.completedCourseName}</strong> เมื่อ {date(item.completedAt)}</span></p>
      <p className="source-note">ประวัติจาก {item.source === "partner" ? "ระบบขาย" : "ประวัติเก่าที่พนักงานยืนยันแล้ว"}</p>
    </div>
    <div className="opportunity-decision">
      <span>คอร์สถัดไปที่แนะนำ</span>
      <strong>{item.courseName}</strong><small>{item.courseCode}</small>
      <a className="profile-link" href={`/admin/customer/${encodeURIComponent(item.customerId)}`}><ExternalLink size={15}/> ดูโปรไฟล์</a>
      <ActionButtons recoId={item.recoId}/>
    </div>
  </article>)}</div>;
}
