"use client";

import type { AnalyticsQuery, AnalyticsResult, PostAnalyticsResult } from "@line-crm/core";
import { AlertTriangle, BarChart3, Bot, CheckCircle2, Filter, LoaderCircle, Search } from "lucide-react";
import React, { type FormEvent, useState } from "react";
import { PostAnalyticsPanel } from "./PostAnalyticsPanel";

const metricOptions: Array<{ value: AnalyticsQuery["metric"]; label: string }> = [
  { value: "revenue", label: "ยอดขาย" },
  { value: "seats", label: "ที่นั่งที่ขายได้" },
  { value: "people", label: "จำนวนลูกค้า" },
  { value: "new_vs_returning", label: "ลูกค้าใหม่ / ลูกค้าเก่า" },
  { value: "channel_mix", label: "ช่องทางที่มา" },
  { value: "intent_funnel", label: "ความสนใจจาก AI" },
];

const groupLabels: Record<NonNullable<AnalyticsQuery["groupBy"]>, string> = {
  course: "คอร์ส",
  month: "เดือน",
  week: "สัปดาห์",
  day: "วัน",
  saleRep: "พนักงานขาย",
  channel: "ช่องทาง",
  adOrOrganic: "โฆษณา / Organic",
};

const groupsByMetric: Record<AnalyticsQuery["metric"], Array<AnalyticsQuery["groupBy"]>> = {
  revenue: ["month", "week", "day", "saleRep", undefined],
  seats: ["course", "month", "week", "day", undefined],
  people: ["course", "month", "week", "day", undefined],
  new_vs_returning: [undefined],
  channel_mix: ["channel", "adOrOrganic", undefined],
  intent_funnel: [undefined],
};

const numberFormatter = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2 });
const moneyFormatter = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2, style: "currency", currency: "THB" });
const percentFormatter = new Intl.NumberFormat("th-TH", { maximumFractionDigits: 2, style: "percent" });

function metricValue(metric: string, value: number): string {
  return metric === "revenue" ? moneyFormatter.format(value) : numberFormatter.format(value);
}

function queryResponse(value: unknown): value is AnalyticsResult {
  return Boolean(value && typeof value === "object" && "metric" in value && "rows" in value && "total" in value);
}

function postAnalyticsResponse(value: unknown): value is PostAnalyticsResult {
  return Boolean(value && typeof value === "object" && "summary" in value && "rows" in value && "chartMaxEngagement" in value);
}

interface QuestionResponse {
  ok: boolean;
  llmAvailable: boolean;
  query?: AnalyticsQuery;
  result?: AnalyticsResult;
  answer?: string | null;
  answerVerified?: boolean;
  invented?: string[];
  clarify?: string;
  message?: string;
}

export function AnalyticsResultPanel({
  result,
  answer = null,
  answerVerified = false,
  aiIssue = null,
}: {
  result: AnalyticsResult;
  answer?: string | null;
  answerVerified?: boolean;
  aiIssue?: string | null;
}) {
  return <div className="analytics-results">
    {result.meta.containsSynthetic && <p className="analytics-alert synthetic-alert"><AlertTriangle size={19}/><strong>ตัวเลขนี้มีข้อมูลจำลอง ห้ามใช้ตัดสินใจ</strong></p>}
    {result.meta.isEstimate && <p className="analytics-alert estimate-alert"><Bot size={19}/><strong>ค่าประเมินจาก AI ไม่ใช่ยอดจริง</strong></p>}
    {answer && answerVerified && <section className="ai-answer" aria-label="คำตอบจาก AI"><div><Bot size={20}/><strong>คำตอบจาก Hermes</strong><span><CheckCircle2 size={15}/> ผ่านตัวกันโกหกแล้ว</span></div><p>{answer}</p></section>}
    {aiIssue && <p className="analytics-alert rejected-alert"><AlertTriangle size={19}/><span>{aiIssue}</span></p>}

    <section className="analytics-summary" aria-label="สรุปผล">
      <div><span>ผลรวม</span><strong>{metricValue(result.metric, result.total)}</strong></div>
      <div><span>ช่วงข้อมูล</span><strong>{result.meta.from} ถึง {result.meta.to}</strong></div>
      <div><span>แหล่งข้อมูล</span><strong>{result.meta.sourcesUsed.join(" + ") || "-"}</strong></div>
      <div><span>รายการที่ตรวจ</span><strong>{numberFormatter.format(result.meta.rowsScanned)}</strong></div>
    </section>

    {result.meta.warnings.length > 0 && <section className="analytics-warnings" aria-label="หมายเหตุ"><h2>หมายเหตุจากระบบคำนวณ</h2>{result.meta.warnings.map((warning) => <p key={warning}><AlertTriangle size={16}/>{warning}</p>)}</section>}

    <section className="analytics-chart" aria-labelledby="chart-title">
      <div className="section-heading"><BarChart3 size={20}/><h2 id="chart-title">กราฟเปรียบเทียบ</h2></div>
      {result.rows.length === 0 || result.total === 0
        ? <div className="empty-state"><BarChart3 size={24}/><p>ไม่พบข้อมูลในช่วงที่เลือก</p></div>
        : <div className="bar-list">{result.rows.map((row) => <div className="bar-row" key={row.key}>
          <div><span>{row.label}</span><strong>{metricValue(result.metric, row.value)}</strong></div>
          <svg viewBox={`0 0 ${result.total} 1`} preserveAspectRatio="none" role="img" aria-label={`${row.label} ${metricValue(result.metric, row.value)}`}>
            <rect className="bar-track" width={result.total} height="1"/>
            <rect className="bar-value" width={row.value} height="1"/>
          </svg>
        </div>)}</div>}
    </section>

    <section className="analytics-table" aria-labelledby="table-title">
      <div className="section-heading"><h2 id="table-title">ตารางรายละเอียด</h2></div>
      <div className="table-scroll"><table>
        <thead><tr><th>รายการ</th><th>ค่า</th><th>สัดส่วน</th><th>เทียบช่วงก่อน</th></tr></thead>
        <tbody>{result.rows.map((row) => <tr key={row.key}>
          <td>{row.label}</td>
          <td className="analytics-number">{metricValue(result.metric, row.value)}</td>
          <td className="analytics-number">{row.share === undefined ? "-" : percentFormatter.format(row.share)}</td>
          <td className="analytics-number">{row.delta === undefined ? "-" : numberFormatter.format(row.delta)}</td>
        </tr>)}</tbody>
        <tfoot><tr><th>รวม</th><td className="analytics-number">{metricValue(result.metric, result.total)}</td><td/><td/></tr></tfoot>
      </table></div>
    </section>
  </div>;
}

export function AnalyticsDashboard({ initialQuery, initialResult, initialPostAnalytics, llmAvailable }: {
  initialQuery: AnalyticsQuery;
  initialResult: AnalyticsResult;
  initialPostAnalytics: PostAnalyticsResult;
  llmAvailable: boolean;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState(initialResult);
  const [postAnalytics, setPostAnalytics] = useState(initialPostAnalytics);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [answerVerified, setAnswerVerified] = useState(false);
  const [aiIssue, setAiIssue] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function post(body: unknown): Promise<unknown> {
    const response = await fetch("/api/admin/analytics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as { message?: string };
    if (!response.ok) throw new Error(payload.message ?? "โหลดข้อมูลไม่สำเร็จ");
    return payload;
  }

  async function loadPostAnalytics(from: string, to: string): Promise<PostAnalyticsResult> {
    const response = await fetch(`/api/admin/facebook-posts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const payload = await response.json() as { message?: string };
    if (!response.ok || !postAnalyticsResponse(payload)) throw new Error(payload.message ?? "โหลดข้อมูลโพสต์ไม่สำเร็จ");
    return payload;
  }

  async function applyFilters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setError(null);
    setAnswer(null);
    setAiIssue(null);
    try {
      const [payload, posts] = await Promise.all([post(query), loadPostAnalytics(query.from, query.to)]);
      if (!queryResponse(payload)) throw new Error("รูปแบบผลลัพธ์ไม่ถูกต้อง");
      setResult(payload);
      setPostAnalytics(posts);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "โหลดข้อมูลไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  async function ask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!question.trim()) return;
    setLoading(true);
    setError(null);
    setAnswer(null);
    setAiIssue(null);
    try {
      const payload = await post({ question }) as QuestionResponse;
      if (!payload.llmAvailable) {
        setAiIssue(payload.message ?? "ยังไม่ได้เชื่อม Hermes");
      } else if (payload.clarify) {
        setAiIssue(payload.clarify);
      } else if (payload.result && payload.query) {
        setResult(payload.result);
        setQuery(payload.query);
        setPostAnalytics(await loadPostAnalytics(payload.query.from, payload.query.to));
        setAnswer(payload.answerVerified ? payload.answer ?? null : null);
        setAnswerVerified(payload.answerVerified === true);
        if (!payload.answerVerified) {
          setAiIssue(payload.invented?.length
            ? "ไม่แสดงคำตอบจาก AI เพราะพบตัวเลขที่ไม่มีในผลคำนวณ กรุณาใช้ตารางด้านล่าง"
            : "AI สรุปข้อความไม่สำเร็จ กรุณาใช้ตารางด้านล่าง");
        }
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "ถามข้อมูลไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  const groups = groupsByMetric[query.metric];

  return <>
    <section className="analytics-question" aria-labelledby="question-title">
      <div><Bot size={22}/><div><h2 id="question-title">ถามเป็นภาษาไทย</h2><p>{llmAvailable ? "Hermes จะแปลงคำถามเป็นตัวเลือกและใช้ตัวเลขจากระบบคำนวณ" : "ยังไม่ได้เชื่อม Hermes ใช้ตัวเลือกด้านล่างได้ตามปกติ"}</p></div></div>
      <form onSubmit={ask}><label className="sr-only" htmlFor="analytics-question">คำถาม</label><input id="analytics-question" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="เช่น เดือนสิงหาคม 2026 ขายได้เท่าไร" disabled={!llmAvailable || loading} maxLength={500}/><button className="primary-button" disabled={!llmAvailable || loading || !question.trim()}><Search size={17}/> ถาม</button></form>
    </section>

    <form className="analytics-filters" onSubmit={applyFilters}>
      <div className="section-heading"><Filter size={20}/><h2>ตัวกรอง</h2></div>
      <div className="filter-grid">
        <label>ตัวเลขที่ต้องการดู<select value={query.metric} onChange={(event) => {
          const metric = event.target.value as AnalyticsQuery["metric"];
          setQuery({ ...query, metric, groupBy: groupsByMetric[metric][0], courseCodes: undefined, hesitationReason: undefined });
        }}>{metricOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
        <label>ตั้งแต่<input type="date" value={query.from} onChange={(event) => setQuery({ ...query, from: event.target.value })}/></label>
        <label>ถึง<input type="date" value={query.to} onChange={(event) => setQuery({ ...query, to: event.target.value })}/></label>
        <label>จัดกลุ่ม<select value={query.groupBy ?? ""} onChange={(event) => setQuery({ ...query, groupBy: event.target.value ? event.target.value as AnalyticsQuery["groupBy"] : undefined })}>{groups.map((group) => <option value={group ?? ""} key={group ?? "none"}>{group ? groupLabels[group] : "ตามประเภทของตัวเลข"}</option>)}</select></label>
      </div>
      <div className="filter-actions"><label className="checkbox-label"><input type="checkbox" checked={query.includeSynthetic} onChange={(event) => setQuery({ ...query, includeSynthetic: event.target.checked })}/> รวมข้อมูลจำลอง</label><button className="primary-button" disabled={loading}>{loading ? <LoaderCircle className="spin" size={17}/> : <BarChart3 size={17}/>} แสดงผล</button></div>
    </form>

    {error && <p className="error-notice"><AlertTriangle size={17}/>{error}</p>}
    <AnalyticsResultPanel result={result} answer={answer} answerVerified={answerVerified} aiIssue={aiIssue}/>
    <PostAnalyticsPanel result={postAnalytics}/>
  </>;
}
