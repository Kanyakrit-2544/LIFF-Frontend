import { newId } from "../ids";
import { normalizePhone } from "../identity/normalize";
import { courseByHeader } from "./courses";
import { parseCourseCell } from "./courseCell";
import {
  LEGACY_SCHEMA_VERSION,
  type LegacyEnrollmentDoc,
  type LegacyPaymentDoc,
  type LegacyPersonDoc,
} from "./models";
import { sheetYear, type LegacyProfile, type LegacySheetProfile } from "./profile";

/**
 * ปั้นฐาน legacy แบบ synthetic จาก "รูปทรง" ของชีตขายจริง
 *
 * ทำไมไม่ import ของจริง: ชีตมี PII ลูกค้า 10,615 แถวที่ไม่ได้ผ่าน consent ของระบบนี้
 * การพัฒนา/ทดสอบ/ส่งให้ LLM ไม่จำเป็นต้องใช้ตัวจริง ใช้ข้อมูลที่มี "การกระจายเหมือนกัน" ก็พอ
 * วันที่จะสลับเป็นของจริง เปลี่ยนแค่ชั้น source — โครง doc ปลายทางเป็นตัวเดียวกัน
 *
 * ทุก doc ติดธง synthetic: true — analytics ต้องกำกับป้ายนี้ในคำตอบเสมอ
 */

/** PRNG แบบ seed ได้ — ต้อง reproduce ชุดเดิมได้ ไม่งั้น debug/test ไม่ได้ */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TH_FIRST = [
  "ณัฐวุฒิ", "ศิริพร", "ธนกร", "พิมพ์ชนก", "กิตติพงษ์", "อรวรรณ", "ชยพล", "ปวีณา", "สุทธิพงศ์", "มณีรัตน์",
  "อนุชา", "จิราภรณ์", "วรเมธ", "เบญจวรรณ", "ภาณุพงศ์", "สุพรรษา", "ทศพล", "กนกวรรณ", "ปิยะพงษ์", "ศศิธร",
  "รัชพล", "นภัสสร", "อธิวัฒน์", "ชลธิชา", "เอกรัตน์", "พรทิพย์", "ณภัทร", "วิภาดา", "กฤตเมธ", "สุนิสา",
];
const TH_LAST = [
  "แสงทอง", "ใจงาม", "บุญมาก", "ศรีสุข", "วงศ์ไทย", "พรหมมา", "ทองดี", "รุ่งเรือง", "อินทรีย์", "สายสมร",
  "ชูเกียรติ", "มณีวงศ์", "เพชรรัตน์", "จันทรา", "ภูผา", "กาญจนา", "สุขสวัสดิ์", "ธารทอง", "วีระชัย", "นาคทอง",
];
const TH_NICK = [
  "ปอ", "มิ้นท์", "บิว", "แนน", "ต้น", "ฟ้า", "กิ๊ฟ", "เจ", "หมิว", "โอ๊ต", "แพร", "ตูน", "นิว", "อ้อม", "บอส",
  "พลอย", "เอิร์ธ", "จูน", "แบงค์", "ปุ๊ก",
];
const EN_FIRST = ["Nattawut", "Siriporn", "Thanakorn", "Pimchanok", "Kittipong", "Orawan", "Chayapon", "Paweena", "Suttipong", "Maneerat"];
const EN_LAST = ["Saengthong", "Jaingam", "Boonmak", "Srisuk", "Wongthai", "Prommaa", "Thongdee", "Rungrueang", "Insi", "Saisamorn"];
const MAIL = ["gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "icloud.com"];

export interface GenerateLegacyOptions {
  profile: LegacyProfile;
  importRunId: string;
  /** seed เดิม = ข้อมูลชุดเดิมเป๊ะ */
  seed?: number;
  /** ย่อขนาดลงเพื่อทดสอบเร็ว ๆ (0–1) */
  scale?: number;
  now?: Date;
}

export interface GeneratedLegacy {
  persons: LegacyPersonDoc[];
  payments: LegacyPaymentDoc[];
  enrollments: LegacyEnrollmentDoc[];
  unknownCourseHeaders: string[];
}

interface Weighted<T> {
  items: T[];
  cum: number[];
  total: number;
}

function weighted<T>(entries: [T, number][]): Weighted<T> {
  const items: T[] = [];
  const cum: number[] = [];
  let total = 0;
  for (const [item, w] of entries) {
    if (w <= 0) continue;
    total += w;
    items.push(item);
    cum.push(total);
  }
  return { items, cum, total };
}

function pick<T>(w: Weighted<T>, rnd: () => number): T {
  const x = rnd() * w.total;
  for (let i = 0; i < w.cum.length; i++) if (x <= w.cum[i]!) return w.items[i]!;
  return w.items[w.items.length - 1]!;
}

const int = (rnd: () => number, min: number, max: number) => min + Math.floor(rnd() * (max - min + 1));

/** ค่าเงินในชีตเกาะกลุ่มที่ราคาคอร์ส — สุ่มจาก bucket แล้วปัดให้ดูเหมือนราคาจริง */
function amountFrom(buckets: Weighted<string>, rnd: () => number): number {
  const [lo, hi] = pick(buckets, rnd).split("-").map(Number) as [number, number];
  const raw = lo + rnd() * (Math.min(hi, lo * 3 + 1000) - lo);
  return Math.round(raw / 10) * 10;
}

function slipNo(year: number, month: number, seq: number): string {
  const be = String(year + 543).slice(2);
  return `IN-${be}${String(month).padStart(2, "0")}-${String(seq).padStart(5, "0")}`;
}

function generateSheet(
  sp: LegacySheetProfile,
  rnd: () => number,
  ctx: { importRunId: string; now: Date; scale: number; usedPhones: Set<string> },
  out: GeneratedLegacy
): void {
  const year = sheetYear(sp.sheet);
  const rowTarget = Math.max(1, Math.round(sp.rows * ctx.scale));

  const months = weighted(Object.entries(sp.monthWeights).map(([m, w]) => [Number(m), w] as [number, number]));
  const amounts = weighted(Object.entries(sp.amountBuckets));
  const reps = weighted(Object.entries(sp.saleReps).filter(([r]) => r !== "-"));
  const perRow = weighted(Object.entries(sp.coursesPerRow).map(([n, w]) => [Number(n), w] as [number, number]));
  const courses = weighted(Object.entries(sp.courseHits));
  const sessionsOf = new Map(
    Object.entries(sp.courseSessions).map(([label, dist]) => [label, weighted(Object.entries(dist))])
  );
  // ลูกค้าซื้อกี่ครั้ง — จาก repeatByPhone ของจริง (1 ครั้ง 742 คน, 2 ครั้ง 153 คน, …)
  const repeats = weighted(Object.entries(sp.repeatByPhone).map(([n, w]) => [Number(n), w] as [number, number]));

  const fill = (key: string) => sp.fillRate[key] ?? 0;
  let seq = 0;
  let rows = 0;

  while (rows < rowTarget) {
    const payCount = Math.min(pick(repeats, rnd), rowTarget - rows);
    const personId = newId("legacyPerson");

    const first = TH_FIRST[int(rnd, 0, TH_FIRST.length - 1)]!;
    const last = TH_LAST[int(rnd, 0, TH_LAST.length - 1)]!;

    let phone: string | null = null;
    if (rnd() < fill("phone")) {
      for (let tries = 0; tries < 20 && !phone; tries++) {
        // มือถือไทย = 0 + (6|8|9) + อีก 8 หลัก รวม 10 ตัว
        const candidate = normalizePhone(`0${[6, 8, 9][int(rnd, 0, 2)]}${String(int(rnd, 0, 99999999)).padStart(8, "0")}`);
        if (candidate && !ctx.usedPhones.has(candidate)) phone = candidate;
      }
      if (phone) ctx.usedPhones.add(phone);
    }

    const person: LegacyPersonDoc = {
      _id: personId,
      fullNameTh: `${first} ${last}`,
      fullNameEn: rnd() < fill("fullNameEn")
        ? `${EN_FIRST[int(rnd, 0, EN_FIRST.length - 1)]} ${EN_LAST[int(rnd, 0, EN_LAST.length - 1)]}`
        : null,
      nickname: rnd() < fill("nickname") ? TH_NICK[int(rnd, 0, TH_NICK.length - 1)]! : null,
      phone,
      email: rnd() < fill("email")
        ? `${EN_FIRST[int(rnd, 0, EN_FIRST.length - 1)]!.toLowerCase()}.${int(rnd, 10, 9999)}@${MAIL[int(rnd, 0, MAIL.length - 1)]}`
        : null,
      socialHandle: rnd() < fill("social") ? `${TH_NICK[int(rnd, 0, TH_NICK.length - 1)]}_${int(rnd, 100, 9999)}` : null,
      ageAtImport: rnd() < fill("age") && sp.age ? int(rnd, Math.round(sp.age.p25) - 6, Math.round(sp.age.p75) + 8) : null,
      firstPaidAt: null,
      lastPaidAt: null,
      totalPaid: 0,
      paymentCount: 0,
      seatCount: 0,
      courseCodes: [],
      sourceRefs: [],
      synthetic: true,
      importRunId: ctx.importRunId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
      schemaVersion: LEGACY_SCHEMA_VERSION,
      aiSync: { dirty: true, syncedAt: null, lockedAt: null, attempts: 0 },
    };

    for (let i = 0; i < payCount; i++) {
      rows++;
      seq++;
      const month = pick(months, rnd);
      const paidAt = new Date(Date.UTC(year, month - 1, int(rnd, 1, 28)));
      const amount = rnd() < fill("amount") ? amountFrom(amounts, rnd) : null;
      const source = { sheet: sp.sheet, row: sp.headerRow + 1 + rows };

      const payment: LegacyPaymentDoc = {
        _id: newId("legacyPayment"),
        personId,
        slipNo: slipNo(year, month, seq),
        slipShared: false,
        amount,
        paidAt,
        year,
        saleRep: reps.total > 0 ? pick(reps, rnd) : null,
        source,
        synthetic: true,
        importRunId: ctx.importRunId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
        schemaVersion: LEGACY_SCHEMA_VERSION,
        aiSync: { dirty: true, syncedAt: null, lockedAt: null, attempts: 0 },
      };
      out.payments.push(payment);

      const wanted = Math.max(1, pick(perRow, rnd));
      const chosen = new Set<string>();
      for (let k = 0; k < wanted * 2 && chosen.size < wanted; k++) chosen.add(pick(courses, rnd));

      for (const label of chosen) {
        const def = courseByHeader(label);
        if (!def) {
          if (!out.unknownCourseHeaders.includes(label)) out.unknownCourseHeaders.push(label);
          continue;
        }
        const dist = sessionsOf.get(label);
        if (!dist || dist.total === 0) continue;
        const cell = pick(dist, rnd);
        const parsed = parseCourseCell(cell, year);
        if (!parsed) continue;

        out.enrollments.push({
          _id: newId("legacyEnrollment"),
          personId,
          paymentId: payment._id,
          courseCode: def.code,
          courseLabel: label,
          kind: parsed.kind,
          countsAsSeat: parsed.countsAsSeat,
          sessionLabel: parsed.sessionLabel,
          sessionStart: parsed.sessionStart,
          sessionPrecision: parsed.sessionPrecision,
          sessionYear: parsed.sessionYear,
          refSlip: parsed.refSlip,
          substitute: parsed.substitute,
          raw: parsed.raw,
          source,
          synthetic: true,
          importRunId: ctx.importRunId,
          createdAt: ctx.now,
          updatedAt: ctx.now,
          schemaVersion: LEGACY_SCHEMA_VERSION,
          aiSync: { dirty: true, syncedAt: null, lockedAt: null, attempts: 0 },
        });

        if (parsed.countsAsSeat) {
          person.seatCount++;
          if (!person.courseCodes.includes(def.code)) person.courseCodes.push(def.code);
        }
      }

      person.paymentCount++;
      person.totalPaid += amount ?? 0;
      person.sourceRefs.push(source);
      if (!person.firstPaidAt || paidAt < person.firstPaidAt) person.firstPaidAt = paidAt;
      if (!person.lastPaidAt || paidAt > person.lastPaidAt) person.lastPaidAt = paidAt;
    }

    out.persons.push(person);
  }
}

export function generateLegacy(opts: GenerateLegacyOptions): GeneratedLegacy {
  const rnd = mulberry32(opts.seed ?? 20260828);
  const now = opts.now ?? new Date();
  const scale = opts.scale ?? 1;
  const out: GeneratedLegacy = { persons: [], payments: [], enrollments: [], unknownCourseHeaders: [] };
  const ctx = { importRunId: opts.importRunId, now, scale, usedPhones: new Set<string>() };

  for (const sp of opts.profile.sheets) generateSheet(sp, rnd, ctx, out);

  // เลขสลิปที่ใช้ซ้ำ = จ่ายรวมกันมาหลายคน (พบจริงในชีต) ต้องมีในข้อมูลจำลองด้วย
  // ไม่งั้น analytics จะไม่เคยเจอเคสยอดซ้อน แล้วไปพังตอนใช้ข้อมูลจริง
  const byYear = new Map<number, LegacyPaymentDoc[]>();
  for (const p of out.payments) (byYear.get(p.year) ?? byYear.set(p.year, []).get(p.year)!).push(p);
  for (const [, list] of byYear) {
    const shareCount = Math.floor(list.length * 0.08);
    for (let i = 0; i + 1 < shareCount; i += 2) {
      const a = list[int(rnd, 0, list.length - 1)]!;
      const b = list[int(rnd, 0, list.length - 1)]!;
      if (a === b || a.personId === b.personId) continue;
      b.slipNo = a.slipNo;
      a.slipShared = true;
      b.slipShared = true;
    }
  }

  return out;
}
