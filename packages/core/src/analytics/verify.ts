import type { AnalyticsResult } from "./query";

/**
 * ⭐ ตัวกันโกหก (docs/29 §6.3)
 *
 * LLM เขียนสรุปแล้วแต่งตัวเลขได้ เช่น "เดือนนี้โต 23%" ทั้งที่ไม่มีเลข 23 อยู่ในข้อมูลเลย
 * และไม่มีใครจับได้ — เพราะข้อความอ่านแล้วดูน่าเชื่อถือ
 *
 * ตัวนี้ดึงตัวเลขทุกตัวออกจากข้อความแล้วเทียบกับค่าที่คำนวณไว้จริง
 * เจอตัวที่ไม่มีอยู่จริง = ไม่ส่งคำตอบนั้นออกไป
 *
 * นี่คือเหตุผลที่ share/delta ต้องคำนวณในชั้น aggregation —
 * ถ้าปล่อยให้ LLM คิดเปอร์เซ็นต์เอง ตัวนี้จะจับผิดทุกครั้งจนใช้งานไม่ได้
 */

export interface VerifyResult {
  ok: boolean;
  invented: string[];
  allowedCount: number;
}

/** ตัวเลขที่ไม่ได้มาจากข้อมูล แต่ยอมให้ปรากฏได้ — ปี, ลำดับข้อ, วันที่ */
function isStructural(token: string, result: AnalyticsResult): boolean {
  if (/^(19|20)\d{2}$/.test(token)) return true;                       // ปี
  if (result.rows.some((r) => r.key.includes(token) || r.label.includes(token))) return true; // ส่วนหนึ่งของคีย์ เช่น "2026-08"
  return `${result.meta.from} ${result.meta.to}`.includes(token);
}

function candidateValues(result: AnalyticsResult): Set<string> {
  const out = new Set<string>();
  const add = (n: number | undefined) => {
    if (n === undefined || Number.isNaN(n)) return;
    const abs = Math.abs(n);
    out.add(String(n));
    out.add(String(abs));
    out.add(String(Math.round(abs)));
    out.add(abs.toFixed(1));
    out.add(abs.toFixed(2));
    out.add(Math.round(abs).toLocaleString("en-US"));
    // สัดส่วน 0–1 มักถูกเขียนเป็นเปอร์เซ็นต์
    if (abs <= 1) {
      const pct = abs * 100;
      out.add(String(Math.round(pct)));
      out.add(pct.toFixed(1));
      out.add(pct.toFixed(2));
    }
  };
  for (const r of result.rows) {
    add(r.value);
    add(r.share);
    add(r.delta);
  }
  add(result.total);
  add(result.rows.length);
  add(result.meta.rowsScanned);
  return out;
}

export function verifyAnswerNumbers(answer: string, result: AnalyticsResult): VerifyResult {
  const allowed = candidateValues(result);
  // จับตัวเลขที่มีคอมมาและทศนิยม เช่น 1,234.5
  const tokens = answer.match(/\d[\d,]*(?:\.\d+)?/g) ?? [];
  const invented: string[] = [];

  for (const raw of tokens) {
    const plain = raw.replace(/,/g, "");
    if (allowed.has(raw) || allowed.has(plain)) continue;
    // ตัดศูนย์ท้ายทศนิยมแล้วลองอีกครั้ง เช่น "17.0" กับ "17"
    const trimmed = plain.includes(".") ? plain.replace(/\.?0+$/, "") : plain;
    if (allowed.has(trimmed)) continue;
    if (isStructural(raw, result)) continue;
    invented.push(raw);
  }

  return { ok: invented.length === 0, invented: [...new Set(invented)], allowedCount: allowed.size };
}
