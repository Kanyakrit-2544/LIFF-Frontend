# S15 — หน้า "โอกาสการขาย" (รายการแนะนำให้ human รีวิว) — spec สำหรับ Codex

## เป้าหมาย
ปิดลูปที่ขาด: ระบบ "รู้" ว่าลูกค้าสนใจ/เคยซื้ออะไร แต่ยังไม่มีตัว "บอกทีมขายว่าควรทำอะไรต่อ"
งานนี้ = **หน้าใหม่ที่วิเคราะห์ออกมาเป็น "รายการแนะนำ" ให้คนอ่านแล้วตัดสินใจเอง** (human-in-the-loop)

**สำคัญ: ไม่ส่งอะไรอัตโนมัติ** — ไม่ยิงข้อความ ไม่ยิง ad ไม่ broadcast มีแค่ "แนะนำ + ปุ่มทำแล้ว/ข้าม" เท่านั้น
เหตุผล: PDPA (ส่งการตลาดต้องมี consent) + tagger ยังไม่ validate ความแม่น → คนต้องกลั่นกรองก่อน

## ขอบเขต 2 กล่อง (เท่านี้ก่อน)

### กล่อง 1 — คนลังเล → ควรตามผล/ส่งโปร
- **แหล่งข้อมูล**: `customer_intents` (main DB, `COLLECTIONS.customerIntents`) ที่ `status:"hesitant"`, ไม่ `voidedAt`/`supersededAt`, และลูกค้า **ยังไม่ซื้อคอร์สนั้น**
- **กรองด้วย consent**: เอาเฉพาะ `customer.consent?.marketing === true` — คนที่ไม่ยอมรับการตลาด **ไม่แสดง** (หรือแสดงแยกกลุ่มพร้อมป้าย "ยังไม่ยอมรับการตลาด — ห้ามส่งโปร")
- **แต่ละแถวโชว์**: ชื่อลูกค้า, คอร์สที่สนใจ, เหตุผลที่ลังเล (`hesitationReason`), ความมั่นใจ AI (`confidence`), การกระทำที่แนะนำ
- **แมปเหตุผล → คำแนะนำ** (mock ปรับได้):
  - `budget` → "เสนอผ่อน / ส่วนลด"
  - `timing` / `not_ready` → "เตือนรอบถัดไป"
  - อื่น ๆ / `null` → "ตามผลทั่วไป"

### กล่อง 2 — เรียนจบแล้ว → ชวนต่อคอร์สถัดไป (upsell)
- **แหล่งข้อมูล**: ประวัติซื้อรวม (partner purchases + legacy ผ่าน **confirmed** `customer_links` เท่านั้น — D23)
- **นิยาม "เรียนจบ"**: `countsAsSeat === true` **และ** `sessionStart` เป็นอดีต (วันคอร์สผ่านไปแล้ว)
- **เส้นทางคอร์ส (mock — ใส่ใน `courseLadder.ts` ติดป้ายชัดว่าสมมุติ ปรับได้)**:
  ```
  INNER → COMMU → PRESENT → TTRT        (ต่อเป็นเส้นตรง)
  DEEPIN, INNERCAMP = คอร์สเสริม → แนะนำหลังเรียน INNER (ถ้ายังไม่เคยเรียน)
  ```
- **เงื่อนไข**: ลูกค้าเรียนคอร์ส A จบ + **ยังไม่เคยซื้อ** คอร์สถัดไป B (เช็คจากเซ็ตคอร์สทั้งหมดของลูกค้า partner+legacy-confirmed)
- **แต่ละแถวโชว์**: ชื่อลูกค้า, คอร์สที่จบ, คอร์สถัดไปที่แนะนำ, จบเมื่อไร

## สถาปัตยกรรม (ตามกฎเดิม)
- **logic อยู่ core** (`packages/core/src/recommend/`) — pure functions ทดสอบได้ ไม่แตะ IO:
  - `courseLadder.ts` — นิยามเส้นทาง (mock) + helper `nextCourses(code): string[]`
  - `followUp.ts` — `buildFollowUpRecommendations(intents, customersById, purchasedByCustomer): FollowUpReco[]`
  - `upsell.ts` — `buildUpsellRecommendations(completedByCustomer, customersById): UpsellReco[]`
  - แต่ละ reco มี `recoId` **deterministic** = `${type}:${customerId}:${courseCode}` (ไว้ผูกสถานะ done/skip)
- **หน้า/route บาง** — ดึงข้อมูลจาก DB แล้วเรียก core:
  - หน้าใหม่ `apps/web/app/admin/opportunities/page.tsx` (หน้าแยก ไม่ใช่แท็บใน review) + ลิงก์ใน `AdminNav`
  - อ่าน: intents + customers + purchases/items (main), confirmed links (ai) + legacy enrollments (legacy) — reuse pattern จาก `getCustomerProfile` / `getAdminReviewDbs`
- **สถานะ human-in-the-loop**: collection ใหม่ `recommendation_reviews` (main DB) — `{_id: recoId, type, customerId, courseCode, status: "done"|"skipped", staffEmail, at}` · รายการที่มี recoId อยู่แล้ว = ตัดออกจากลิสต์
  - server action `markRecommendation(recoId, status)` — บันทึกสถานะ (ตรวจ session admin เหมือน `review/actions.ts`)

## ต้องกันให้ดี (trust + PDPA)
- **ติดป้าย synthetic** — ถ้าข้อมูลลูกค้า/ประวัติเป็น synthetic ต้องมีป้ายในแถว (analytics ทำแบบนี้อยู่แล้ว)
- **โชว์ความมั่นใจ AI** ในกล่องลังเล — เพราะ tagger ยังไม่ validate คนรีวิวต้องเห็นเพื่อกลั่นกรอง
- **consent.marketing** — กล่อง 1 ต้องเคารพ ไม่โผล่คนที่ไม่ยอมรับ (หรือแยกกลุ่ม + ห้ามส่ง)
- **D23** — upsell ใช้ประวัติ legacy เฉพาะจาก confirmed links
- **ไม่มีปุ่มส่ง/ยิงอะไรทั้งสิ้น** — มีแค่ [ทำแล้ว] [ข้าม]

## Seed ให้ 2 กล่องมีของโชว์
- **ต่อยอด `scripts/seed-local.ts`**: เพิ่ม intents `hesitant` (เหตุผลคละ budget/timing/null) กับลูกค้าที่มี `consent.marketing` คละ + ลูกค้าที่ "เรียน A จบ (sessionStart อดีต) ยังไม่ซื้อ B" อย่างละ ≥3 → กล่อง 1 และ 2 ต้องไม่ว่าง
- **seed ลง Atlas dev สำหรับทดสอบบนเว็บจริง** (`scripts/seed-demo-atlas.ts` + `npm run seed:demo-atlas`):
  - เขียนเฉพาะ doc ที่ติด `seedTag:"sales-demo"` + `synthetic:true` เท่านั้น · มี cleanup ลบเฉพาะ tag นี้
  - **ต้องมี flag ยืนยันชัด** (เช่น `--confirm-atlas`) ไม่งั้น refuse — กันเผลอ · ห้ามแตะ/ลบ doc ที่ไม่ใช่ tag นี้
  - พิมพ์สรุปว่าใส่อะไรไปกี่ตัว ไว้ลบทีหลังได้

## กติกา
- logic ใน core + **เทส** (followUp/upsell/ladder อย่างน้อยกล่องละ 3–4 เคส: ไม่ซ้ำคอร์สที่ซื้อแล้ว, เคารพ consent, จบ=sessionStart อดีต, ปุ่ม done ตัดออกจากลิสต์)
- ห้ามปิดเทสเดิม · ห้ามแตะความหมาย `AI_HASH_PEPPER`/`INTERNAL_HMAC_SECRET`
- ต้องผ่าน `npm test` (core+web) + `tsc --noEmit` + `next build`
- ทุก URI local เติม `/?directConnection=true`

## ส่งกลับให้ตรวจ
ไฟล์ที่แตะ · ผลรัน seed:local (จำนวนในกล่อง 1/กล่อง 2) · ผลเทส core ของ recommend · ผล test/build · วิธีรัน `seed:demo-atlas` + วิธีลบ
