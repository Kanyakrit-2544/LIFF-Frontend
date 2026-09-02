import { BarChart3, ClipboardCheck, Target } from "lucide-react";

export function AdminNav({ active }: { active: "review" | "opportunities" | "analytics" }) {
  return <nav className="admin-nav" aria-label="เมนูผู้ดูแลระบบ">
    <a className={active === "review" ? "active" : ""} href="/admin/review"><ClipboardCheck size={18}/> งานรอตรวจ</a>
    <a className={active === "opportunities" ? "active" : ""} href="/admin/opportunities"><Target size={18}/> โอกาสการขาย</a>
    <a className={active === "analytics" ? "active" : ""} href="/admin/analytics"><BarChart3 size={18}/> Analytics</a>
  </nav>;
}
