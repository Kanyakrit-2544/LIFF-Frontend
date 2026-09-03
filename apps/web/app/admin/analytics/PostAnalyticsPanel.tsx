import type { PostAnalyticsResult } from "@line-crm/core";
import { AlertTriangle, MapPin, Newspaper } from "lucide-react";
import React from "react";

const numberFormatter = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 });

export function PostAnalyticsPanel({ result }: { result: PostAnalyticsResult }) {
  return <section className="post-analytics" aria-labelledby="post-analytics-title">
    <header className="post-analytics-header">
      <div className="section-heading"><Newspaper size={20}/><h2 id="post-analytics-title">โพสต์ / คอร์ส</h2></div>
      <span>{result.meta.from} ถึง {result.meta.to}</span>
    </header>
    {result.meta.containsSynthetic && <p className="analytics-alert synthetic-alert"><AlertTriangle size={18}/><strong>ส่วนโพสต์นี้มีข้อมูลจำลอง</strong></p>}
    {result.summary.unmappedPosts > 0 && <p className="analytics-alert estimate-alert"><MapPin size={18}/><strong>มี {numberFormatter.format(result.summary.unmappedPosts)} โพสต์ที่ยัง map hashtag ไม่ได้</strong></p>}

    <div className="post-summary" aria-label="สรุปโพสต์ Facebook">
      <div><span>โพสต์ทั้งหมด</span><strong>{numberFormatter.format(result.summary.totalPosts)}</strong></div>
      <div><span>map คอร์สแล้ว</span><strong>{numberFormatter.format(result.summary.mappedPosts)}</strong></div>
      <div><span>Engagement</span><strong>{numberFormatter.format(result.summary.totalEngagement)}</strong></div>
      <div><span>Reach</span><strong>{numberFormatter.format(result.summary.totalReach)}</strong></div>
    </div>

    {result.rows.length === 0
      ? <div className="empty-state compact"><Newspaper size={24}/><p>ไม่พบโพสต์ในช่วงที่เลือก</p></div>
      : <div className="post-analytics-grid">
        <div className="post-bars" aria-label="กราฟ engagement ต่อคอร์ส">
          {result.rows.map((row) => <div className="bar-row" key={row.key}>
            <div><span>{row.label}{row.courseCode === null && <b className="unmapped-badge">ยังไม่ map</b>}</span><strong>{numberFormatter.format(row.engagement.total)}</strong></div>
            <svg viewBox={`0 0 ${result.chartMaxEngagement} 1`} preserveAspectRatio="none" role="img" aria-label={`${row.label} ${row.engagement.total}`}>
              <rect className="bar-track" width={result.chartMaxEngagement} height="1"/>
              <rect className="bar-value post-bar-value" width={row.engagement.total} height="1"/>
            </svg>
          </div>)}
        </div>
        <div className="table-scroll"><table>
          <thead><tr><th>คอร์ส</th><th>โพสต์</th><th>Engagement รวม / เฉลี่ย</th><th>Reach รวม / เฉลี่ย</th></tr></thead>
          <tbody>{result.rows.map((row) => <tr key={row.key}>
            <td>{row.label}</td>
            <td className="analytics-number">{numberFormatter.format(row.postCount)}</td>
            <td className="analytics-number">{numberFormatter.format(row.engagement.total)} / {numberFormatter.format(row.engagement.average)}</td>
            <td className="analytics-number">{numberFormatter.format(row.reach.total)} / {numberFormatter.format(row.reach.average)}</td>
          </tr>)}</tbody>
        </table></div>
      </div>}
  </section>;
}
