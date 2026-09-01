# S13 — สเปกงาน: หน้า Analytics UI

> สเปกสำหรับ Codex · อ่านให้จบก่อนเขียนโค้ด
> อ้างอิง: [docs/29](29-s11-m4-analytics.md) (M4 · D36–D40) · โครงหน้า admin ที่ `apps/web/app/admin/`

---

## 1. เป้าหมาย

M4 มีสมองครบแล้ว (`runAnalytics`, ตัวกันโกหก, insights) แต่ **ตอบผ่าน CLI เท่านั้น** — แอดมินที่ไม่รู้เทคนิคใช้ไม่ได้
S13 เพิ่ม **หน้าเว็บ** ให้เลือกดูตัวเลขและถามคำถามได้ โดยไม่ต้องพิมพ์คำสั่ง

### อยู่ในสโคป
1. หน้า `/admin/analytics` — เลือก metric + ช่วงเวลา + groupBy → เห็นตาราง + กราฟแท่ง
2. `/api/admin/analytics` — endpoint ให้หน้าเรียก (auth เหมือน admin อื่น)
3. ช่องถามภาษาไทย (ถ้าตั้ง Hermes) → แปลงเป็น query → แสดงผล + ป้าย "ผ่านตัวกันโกหกแล้ว"
4. ลิงก์จาก admin nav
5. tests

### ❌ ไม่อยู่ในสโคป
- ไม่ทำ export Excel/PDF · ไม่ทำ dashboard realtime/auto-refresh
- ไม่แก้ logic analytics ใน core (ใช้ `runAnalytics` ตามที่มี)
- ไม่แตะ intake, tagger, workflow
- ไม่เพิ่ม metric ใหม่ (ใช้ 6 ตัวที่มี)

---

## 2. Design Decision

| # | ประเด็น | ตัดสิน |
|---|---|---|
| **D45** | ตัวเลขมาจากไหน | **`runAnalytics` เท่านั้น** — หน้า UI ห้ามคำนวณเลขเอง แม้แต่ผลรวม/เปอร์เซ็นต์ (ใช้ `row.share`, `result.total` ที่ core คืนมา) · ต่อยอดจาก D36 |
| **D46** | ข้อมูล synthetic | ค่าเริ่มต้น `includeSynthetic: false` · ถ้าผลมี `meta.containsSynthetic` → **ขึ้นแถบเตือนสีเด่นทั้งหน้า** "ตัวเลขนี้มีข้อมูลจำลอง ห้ามใช้ตัดสินใจ" |
| **D47** | ค่าประเมิน (intent) | ถ้า `meta.isEstimate` → ติดป้าย "ค่าประเมินจาก AI" + แสดง warnings (รุ่นโมเดล) แยกจากยอดจริงชัดเจน (D39) |
| **D48** | ไม่มี Hermes | ช่องถามภาษาไทยซ่อน/disable · หน้ายังใช้ได้เต็มที่ผ่านตัวเลือก dropdown (เหมือน --no-llm) |
| **D49** | ตัวกันโกหก | คำตอบภาษาไทยจาก LLM ที่ไม่ผ่าน `verifyAnswerNumbers` → **ไม่แสดงข้อความ** โชว์ตารางแทน + บอกว่า AI แต่งตัวเลข |

### ⭐ D45 คือหัวใจ

หน้านี้เห็นตัวเลขจริงของธุรกิจ ถ้า UI คำนวณเองจะเสี่ยงเลขไม่ตรงกับ core (เช่น ปัด % คนละแบบ, รวมยอดผิดเพราะ 1 payment หลายคอร์ส)
**แสดงเฉพาะค่าที่ `runAnalytics` คืนมา** — `rows[].value`, `rows[].share`, `rows[].delta`, `total` · กราฟก็ plot จากค่าเหล่านี้ตรง ๆ

---

## 3. `/api/admin/analytics` — endpoint

```
POST /api/admin/analytics
body: AnalyticsQuery (JSON)  หรือ  { question: string } เมื่อถามภาษาไทย
```

- **auth เหมือน `/api/admin/status`**: `await auth()` + `isAllowedStaffEmail` · ไม่ผ่าน → 401
- ต่อ AI DB ด้วย `getAdminAiDb()` (review_user อ่าน line_crm_ai ได้อยู่แล้ว)
- โหมด query: `analyticsQuerySchema.parse(body)` → `runAnalytics(db, query)` → คืน `AnalyticsResult`
- โหมด question (ถ้ามี Hermes): `parseQuestion` → ถ้า `clarify` คืนให้ถามกลับ · ถ้าได้ query → `runAnalytics` → `renderAnswer` → คืน `{ result, answer, answerVerified, invented }`
- **บันทึกทุกครั้งลง `insights`** ด้วย `saveInsight` (ตรวจย้อนได้ D40)

⚠️ review_user เขียน `insights` ไม่ได้ (สิทธิ์ read line_crm_ai) — **ต้องใช้ `getMirrorAiDb()` เขียน insights** หรือข้าม saveInsight ถ้า mirror ไม่ได้ตั้ง (คืนผลได้ปกติ ไม่ error) · เลือกอย่างหลังถ้าง่ายกว่า แต่ระบุใน report

---

## 4. หน้า `/admin/analytics/page.tsx`

- Server Component ตรวจ auth เอง (redirect `/admin/login` ถ้าไม่ผ่าน) เหมือนหน้า review/customer
- ส่วนเลือก (form GET params หรือ client component):
  - metric: revenue / seats / people / new_vs_returning / channel_mix / intent_funnel
  - from / to (date input · ค่าเริ่มต้น = เดือนนี้ตาม Asia/Bangkok)
  - groupBy: (course/month/week/saleRep/channel/adOrOrganic ตาม metric)
  - includeSynthetic: checkbox (ค่าเริ่มต้นปิด)
- ผลลัพธ์:
  - **การ์ดสรุป**: total (+ delta ถ้ามี)
  - **กราฟแท่ง**: จาก `rows[].value` · **เขียนเองด้วย div/SVG ไม่ใช้ lib ภายนอก** (มี lucide-react อยู่แล้ว ไม่ต้องเพิ่ม chart lib)
  - **ตาราง**: label · value · share(%) · delta
  - **แถบเตือน** เมื่อ `containsSynthetic` (แดง) หรือ `isEstimate` (เหลือง) + warnings
- ช่องถามภาษาไทย (ถ้า Hermes) อยู่บนสุด: พิมพ์ → เห็นคำตอบ (ถ้าผ่านตัวกันโกหก) + ตารางประกอบ

**ดีไซน์**: ใช้ `admin.css` เดิม ให้กลมกลืนกับหน้า review/customer · ตัวเลขเงินใส่ `toLocaleString("th-TH")` · เดือนแสดง Asia/Bangkok

---

## 5. Tests

**endpoint (web integration)**
- ⭐ ไม่ล็อกอิน / อีเมลนอก allowlist → 401
- query ถูก → 200 + โครง AnalyticsResult
- query ผิด schema (from > to) → 400 พร้อมเหตุผล
- `includeSynthetic: false` (ค่าเริ่มต้น) → ผลไม่รวม synthetic
- โหมด question ที่ไม่มี Hermes → บอกว่าใช้ dropdown แทน (ไม่ error)

**หน้า (web)**
- ไม่ล็อกอิน → redirect
- render ตารางจากค่าที่ runAnalytics คืน (mock core หรือ integration)
- ⭐ ผลที่ containsSynthetic → มีแถบเตือนใน HTML

**ตัวกันโกหก (ถ้าทำโหมด question)**
- LLM ตอบเลขที่ไม่มีใน result → `answerVerified: false` → หน้าไม่โชว์ข้อความนั้น

---

## 6. เกณฑ์ผ่านงาน
- [ ] `RUN_MONGO_INTEGRATION=true npm test` ผ่าน skipped 0 (ฐาน core 318 · web 83)
- [ ] `npm run typecheck` + `build --workspace @line-crm/web` ผ่าน
- [ ] หน้า `/admin/analytics` กันคนไม่ล็อกอิน
- [ ] ทุกตัวเลขบนหน้ามาจาก `runAnalytics` (ไม่คำนวณใน UI) — มีเทส/รีวิวยืนยัน
- [ ] ข้อมูล synthetic ขึ้นแถบเตือน
- [ ] ไม่เพิ่ม dependency chart lib
- [ ] เขียน `docs/35-s13-report.md` พร้อมผลรันจริง + screenshot ถ้าทำได้

## 7. กฎห้ามละเมิด
1. ตัวเลขจาก `runAnalytics` เท่านั้น (D45) · UI ห้ามคำนวณเอง
2. auth ทุกทางเข้า (หน้า + endpoint) เหมือน admin เดิม
3. อ่านอย่างเดียวจากมุมมองผู้ใช้ (ยกเว้นบันทึก insights)
4. ข้อมูล synthetic ต้องเตือน · ค่าประเมินต้องแยกจากยอดจริง
5. ไม่เพิ่ม chart lib ภายนอก (CSP ของ artifact/Next + กันบวม)
6. ห้ามลด/ปิด test เดิม

## 8. ใช้ซ้ำได้เลย
| ของ | ที่อยู่ |
|---|---|
| `runAnalytics` · `analyticsQuerySchema` · METRICS · GROUP_BY | `packages/core/src/analytics/` |
| `parseQuestion` · `renderAnswer` · `verifyAnswerNumbers` | `packages/core/src/analytics/ask.ts` · `verify.ts` |
| `saveInsight` | `packages/core/src/analytics/insights.ts` |
| auth guard | `apps/web/lib/adminAuth.ts` · หน้า review เป็นตัวอย่าง |
| ต่อ AI DB | `getAdminAiDb()` (อ่าน) · `getMirrorAiDb()` (เขียน insights ถ้าจำเป็น) |
| LLM provider | `createLlmProvider()` คืน null ถ้าไม่ตั้ง env |
| CSS | `apps/web/app/admin/admin.css` |
