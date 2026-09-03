# S17 — Facebook Content + Attribution + ชีตการตลาด — spec สำหรับ Codex

## เป้าหมาย
ตอบโจทย์ผู้บริหาร "ลูกค้ามาจากโพสต์ไหน" + วิเคราะห์คอนเทนต์เพื่อยิง ad คุ้มขึ้น
โดย **hashtag ในโพสต์ = ชื่อคอร์ส** เป็นตัวเชื่อม · และแยกชีตให้ทีมการตลาดดูต่างหากจากทีมขาย

## สถาปัตยกรรมชีต (ยึดตามนี้)
มี **2 Google Sheet แยกกัน** (คนละ id เพื่อคุมสิทธิ์ต่างทีม):
- **ทีมขาย** = `GOOGLE_SHEET_ID` (เดิม) → tab `Customers` + `สรุปการขาย` (มีแล้ว ห้ามแตะ logic เดิม)
- **ทีมการตลาด** = `GOOGLE_SHEET_ID_MARKETING` (env ใหม่) → tab `Customers` (มิเรอร์เดียวกัน) + `FB Leads` + `FB Posts`

> `Customers` ปรากฏทั้ง 2 ชีตได้ (ต่างทีมเปิดไฟล์ตัวเอง) — เขียนซ้ำ 2 ที่ ไม่ใช่ย้าย

## Part A — ดึงโพสต์ (`facebook_posts`)
- collection ใหม่ `facebook_posts` (ใน `line_crm_dev`):
  `postId · message · hashtags[] · courseCode(จาก hashtag) · createdTime · permalink · engagement{reactions,comments,shares,reach} · adIds[] · unmapped(bool)`
- **พจนานุกรม hashtag → คอร์ส** ใน core (เช่น `packages/core/src/facebook/hashtags.ts`) แบบเดียวกับ `legacy/courses.ts` (มี alias, คืน null ถ้าไม่รู้จัก)
- **hashtag ที่ไม่รู้จัก → เก็บโพสต์ไว้ แต่ flag `unmapped:true`** (เหมือน `unknownCourseHeaders`) ไม่ทิ้งข้อมูล
- ดึงผ่าน Graph API (`/{PAGE_ID}/posts` + `/{post}/insights`) — token มี `pages_read_engagement` + `read_insights` แล้ว
- **รอบแรก**: ดึงย้อนหลัง ~12 เดือน · **cron**: prod วันละครั้ง **07:00 Asia/Bangkok** (workflow ใหม่ WF-J) · dev: `npm run fb:posts`
- **refresh engagement**: cron ดึงซ้ำเฉพาะโพสต์ **90 วันล่าสุด** (ตัวเลข like/reach โตเรื่อย ๆ) · เก่ากว่านั้น freeze
- logic แปลง/แกะ hashtag อยู่ core + เทส · การเรียก Graph API อยู่ script (ชั้น IO)

## Part B — Attribution (lead → โพสต์ → คอร์ส)
- ลูกค้าจาก facebook_lead มี `leadAttribution.adId` → resolve `ad_id → creative → โพสต์ → hashtag → courseCode`
  แล้วเติม `leadAttribution.courseCode` + เคลียร์ `attributionPending`
- **ทำเท่าที่ resolve ได้** (เฉพาะ lead จากโฆษณา) — organic ไม่มี adId ข้ามไป ไม่ error
- resolve ไม่ได้/ไม่มี hashtag → คง `attributionPending:true` (ให้คนมา map ทีหลัง) — อย่าเดา
- ใส่เป็นขั้นใน `leads:sync` (หรือ job แยกที่รันหลัง) — reuse `leadAttribution` เดิม ไม่เพิ่ม field ใหม่ถ้าเลี่ยงได้

## Part C — วิเคราะห์คอนเทนต์
- core: `buildPostAnalytics(posts, range)` → ต่อคอร์ส: จำนวนโพสต์/ช่วงเวลา + engagement รวม/เฉลี่ย + reach
- โผล่ในหน้า **admin analytics** (ส่วนใหม่ "โพสต์/คอร์ส") — ตัวเลขจาก aggregation เท่านั้น (D45/D49 เหมือน S13)
- ป้าย `unmapped` โชว์ให้เห็นถ้ามีโพสต์ที่ยัง map hashtag ไม่ได้

## Part D — ชีตการตลาด (output)
- env ใหม่ `GOOGLE_SHEET_ID_MARKETING` · reuse ท่อ sheet เดิม (route `/api/internal/sheets/pending` + WF-C หรือ WF ใหม่)
- เขียน 3 tab ลงชีตการตลาด:
  - **Customers** — ชุดคอลัมน์เดียวกับชีตขาย (reuse `toSheetRow`)
  - **FB Leads** — ลูกค้า source=facebook_lead: ชื่อ·เบอร์·คอร์ส·**มาจากโพสต์ไหน (permalink/หัวข้อ)**·วันที่
  - **FB Posts** — ต่อโพสต์: คอร์ส·วันที่·engagement·reach·permalink (จาก `facebook_posts`)
- อ่านอย่างเดียว (ระบบเขียน) · **ห้ามมีข้อความแชท** (PDPA) · ชีตขายของเดิม **ห้ามเปลี่ยน**

## Seed
- ต่อ `seed-local.ts`: ใส่ `facebook_posts` ตัวอย่าง (มี hashtag→คอร์ส + บางอัน unmapped) + ลูกค้า facebook_lead ที่ผูก adId → post ให้ attribution/analytics/ชีต มีของโชว์

## กติกา
- logic ใน core + **เทส** (hashtag→course, unmapped, attribution resolve/ไม่ resolve, post analytics)
- ห้ามแตะ logic ชีตขาย/สรุปการขายเดิม · ห้ามปิดเทสเดิม
- ห้ามแตะ `AI_HASH_PEPPER`/`INTERNAL_HMAC_SECRET` · ทุก URI local เติม `/?directConnection=true`
- ผ่าน `npm test` + `tsc --noEmit` + `next build`
- ถ้า chain `ad_id → post` ซับซ้อนเกินไปในบางเคส → รองรับ **fallback map (adId/campaign → courseCode)** แบบ dictionary แทน แล้ว flag ให้คนเติม

## ทีมเราจัดการเอง (ไม่ใช่ Codex)
- ใส่ `GOOGLE_SHEET_ID_MARKETING` + FB token บน Vercel · แชร์ชีตการตลาดให้ service account
- import WF-J + WF-C ใหม่เข้า n8n · รัน `setup:sheet` สร้าง tab จริง

## ส่งกลับให้ตรวจ
ไฟล์ที่แตะ · ผล seed:local (จำนวนโพสต์/unmapped/lead ที่ attribute ได้) · ผลเทส core facebook · ผล test/build
