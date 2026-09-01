# S12 — Go-live & ย้ายไปโครงองค์กร

> เอกสารเดียวที่รวม **ทุกค่าที่ต้องเปลี่ยนเมื่อย้ายจากเครื่อง dev ไปโครงองค์กร**
> ทุกอย่างเป็น env หมดแล้ว ไม่มี host/URL ไหน hardcode ในโค้ด (ยกเว้น `graph.facebook.com` ซึ่งเป็น API ของ Meta เอง)
> **ย้าย = แก้ค่าในตารางข้างล่าง ไม่ต้องแตะโค้ด**

---

## 1. จุดสลับทั้งหมด (org-switch surface)

ค่าเหล่านี้ตอนนี้ชี้ "เครื่องคุณ / บริการชั่วคราว" เมื่อย้ายไปองค์กรให้เปลี่ยนตามคอลัมน์ขวา

### 1.1 n8n — ไฟล์ `line-crm/.env` (docker-compose อ่านอัตโนมัติ)

| ตัวแปร | ตอนนี้ | เมื่อย้ายไป VPS องค์กร |
|---|---|---|
| `API_BASE` | `https://liff-frontend-three.vercel.app` | โดเมน production (ถ้าเปลี่ยนโดเมนด้วย) |
| `MONGODB_URI` | Atlas (app_user) | เหมือนเดิม เว้นแต่ย้าย DB |
| `MONGODB_MIRROR_URI` | Atlas (mirror_user) | เหมือนเดิม |
| `INTERNAL_HMAC_SECRET` | ⚠️ ต้องตรงกับ Vercel เป๊ะ | ห้ามเปลี่ยนฝั่งเดียว |
| ที่ตั้งของ n8n เอง | Docker บนเครื่องคุณ | ย้าย container + `.n8n-data/` ไป VPS · ตั้ง `N8N_PUSH_ENABLED=true` ได้ถ้าอยากลด latency (D8) |

**ย้าย n8n**: ก๊อป `.n8n-data/` (มี workflow + credential + encryption key) ไปเครื่องใหม่ · ตั้ง env ชุดเดิม · `docker compose up -d`
⚠️ `N8N_ENCRYPTION_KEY` ต้องตัวเดิม ไม่งั้น credential ที่เก็บไว้อ่านไม่ออก

### 1.2 tagger — ไฟล์ `tagger/.env`

| ตัวแปร | ตอนนี้ | เมื่อย้ายไปองค์กร |
|---|---|---|
| `CRM_INTAKE_URL` | production URL ของ CRM | เหมือนเดิม (เว้นแต่เปลี่ยนโดเมน CRM) |
| `PARTNER_SECRET` | ตรงกับ CRM แล้ว | ห้ามเปลี่ยนฝั่งเดียว |
| `TAGGER_MONGO_URI` | Mongo ของ tagger | Mongo ขององค์กร (คนละ instance กับ CRM — D1/D3) |
| `LINE_CHANNEL_SECRET` | ตรงกับ CRM | ห้ามเปลี่ยนฝั่งเดียว (ใช้ตรวจลายเซ็นที่ส่งต่อมา) |
| `INTENT_PROVIDER` | `stub` | `openai-compatible` **หลังตัดสิน PDPA แล้วเท่านั้น** |
| `LLM_BASE_URL` | ว่าง | endpoint ของ Hermes องค์กร |
| `LLM_API_KEY` / `LLM_MODEL` | ว่าง | ตามที่ Hermes กำหนด |
| ที่ตั้งของ tagger เอง | `localhost:4300` | ต้องมี **URL สาธารณะ** (Docker/PM2 บน VPS) |

### 1.3 CRM — Vercel env (แก้ที่ Vercel dashboard หรือ `vercel.env.txt` แล้ว redeploy)

| ตัวแปร | ตอนนี้ | เมื่อพร้อม |
|---|---|---|
| `TAGGER_FORWARD_URL` | **ว่าง** (localhost ยิงไม่ถึง) | `https://<tagger org>/line/webhook` เมื่อ tagger มี URL |
| `LLM_BASE_URL` / `LLM_MODEL` | ว่าง | endpoint Hermes (สำหรับ `insights:ask` ถามภาษาไทย) |
| `FACEBOOK_*` (5 ตัว) | ว่าง | เมื่อได้ token จาก Meta |
| `ALLOWED_LIFF_ORIGINS` | โดเมน production | เปลี่ยนถ้าเปลี่ยนโดเมน |

### 1.4 สคริปต์บนเครื่อง — `apps/web/.env.local`

รันจากเครื่องไหนก็ได้ที่มีไฟล์นี้ · ค่า Atlas ชุดเดียวกับ production
`MONGODB_MIRROR_URI` ใช้เมื่อรัน `legacy:scrub` / `partner:scrub` / `insights:ask` / `match:build` กับ Atlas จริง

---

## 2. กฎการเปลี่ยน secret (ท่องไว้)

| secret | ถ้าเปลี่ยนต้องเปลี่ยนที่ไหนพร้อมกัน | ถ้าลืม |
|---|---|---|
| `INTERNAL_HMAC_SECRET` | Vercel + `line-crm/.env` (n8n) | n8n ยิง CRM ได้ 401 ทั้งหมด |
| `PARTNER_SECRET` / `PARTNER_HMAC_SECRETS_JSON` | `tagger/.env` + Vercel | tagger ส่งข้อมูลเข้า CRM ไม่ได้ |
| `LINE_CHANNEL_SECRET` | Vercel + `tagger/.env` | ท่อส่งต่อแชทตรวจลายเซ็นไม่ผ่าน |
| `AI_HASH_PEPPER` | **ห้ามเปลี่ยน** | การจับคู่ลูกค้าเก่า/ใหม่พังทันที (hash คนละชุด) |
| `N8N_ENCRYPTION_KEY` | **ห้ามเปลี่ยน** | credential ใน n8n อ่านไม่ออก |
| `SESSION_JWT_SECRET` | Vercel (ที่เดียว) | ลูกค้าที่กรอกฟอร์มค้างถูกเตะออก (เกิดครั้งเดียว) |

---

## 3. Checklist งานที่เหลือ

### 🔴 ความเสี่ยง / กฎหมาย — ทำก่อน

- [ ] **ย้าย n8n ไป VPS องค์กร** (§1.1) — ปิดเครื่อง dev = ชีต + AI mirror หยุด · ข้อมูลไม่หาย ค้าง `dirty` รอ
- [ ] **กรอกชื่อธุรกิจ + อีเมลใน `apps/web/app/privacy/page.tsx`** — หน้า PDPA จริงยังเป็น `TODO`
- [ ] **ตัดสิน PDPA 4 ข้อ** ก่อนต่อ Hermes อ่านแชท:
  - [ ] เก็บบทสนทนากี่วันแล้วลบ (`CHAT_RETENTION_DAYS` ใน tagger)
  - [ ] ยอมให้ข้อความออกไป Hermes/ChatGPT ไหม
  - [ ] แก้ข้อความ consent ในฟอร์ม LIFF ให้ครอบคลุมการวิเคราะห์ไหม
  - [ ] ลูกค้าขอลบ → มีเส้นทางลบครบไหม (CRM มี `erase` แล้ว · legacy ยังต้องทำมือ)

### 🟠 เปิดใช้งานจริงเต็มระบบ

- [ ] **เอา tagger ขึ้นเซิร์ฟเวอร์องค์กร** → ได้ URL สาธารณะ (ทำคู่กับย้าย n8n)
- [ ] **เติม `TAGGER_FORWARD_URL` ใน Vercel** แล้ว redeploy → แชทเริ่มไหลเข้า tagger
- [ ] **ต่อ Hermes**: ตั้ง `LLM_BASE_URL` + `LLM_MODEL` ทั้งใน `tagger/.env` (`INTENT_PROVIDER=openai-compatible`) และ Vercel (สำหรับ `insights:ask`)
- [ ] **ขอ token Facebook Lead** ตาม `docs/28` §10 → ใส่ `FACEBOOK_*` ใน Vercel
- [ ] **สร้างชุดเทียบความแม่นของ AI tagger** — สุ่มแชท 50–100 เคสให้คนตรวจเทียบกับที่ AI ตัดสิน (§C ข้อ 9) ไม่งั้นตัวเลข "คนสนใจ N คน" ไม่มีใครรู้ว่าเชื่อได้แค่ไหน

### 🟡 ข้อมูลจริง

- [ ] **ตัดสินเรื่องข้อมูลลูกค้าเก่า** — เอา `raw input/Inner.xlsx` เข้าจริงไหม (10,998 แถว) · ถ้าไม่เอา ตัวเลข analytics เป็น synthetic ตลอดไป
- [ ] ถ้าเอาเข้า: เขียน ETL จากชีตจริง (ตอนนี้ใช้ generator ปั้น synthetic) แล้วรัน `legacy:scrub` กับ Atlas

### 🟢 งานพัฒนาที่เหลือ (รอเงื่อนไขข้างบน)

- [ ] **M5 — แสดงประวัติซื้อรายบุคคล** — รอพนักงานเคลียร์ `customer_links` ที่ `needs_review` ก่อน (D23)
- [ ] **เลือกช่องทางแจ้งเตือน** (D42) — ตอนนี้ status:check เขียน log อย่างเดียว · เพิ่ม sink ใหม่เมื่อเลือกได้
- [ ] Presidio scrub — เมื่อฟอร์มมีคำถามปลายเปิด

### ✅ เสร็จแล้ว (ยืนยันบน production 1 ก.ย. 2026)

- [x] หน้า admin + Google login (เข้าได้เฉพาะ allowlist · ทดสอบ 401/307 แล้ว)
- [x] partner intake + secret ตรงกันข้ามระบบ (ทดสอบ 200/401 บน production)
- [x] ท่อส่งต่อแชท (ทดสอบกับ tagger จริง)
- [x] `erase` (PDPA) · review 3 แบบ · status:check · WF-E เก็บ error จริง
- [x] Mongo user แยกสิทธิ์ครบ 4 ตัว (app/review/mirror/ai — ทดสอบสิทธิ์แล้ว)
- [x] secret ทุกตัวเป็นค่าจริง ไม่มี placeholder

---

## 4. ลำดับที่แนะนำ

1. **ย้าย n8n + tagger ขึ้น VPS พร้อมกัน** (§1.1, §1.2) — แก้ความเสี่ยงใหญ่สุดและปลดล็อก `TAGGER_FORWARD_URL` ในคราวเดียว
2. **กรอก privacy + ตัดสิน PDPA** — ปลดล็อกการต่อ Hermes
3. **ต่อ Hermes + Facebook token** — ระบบครบเครื่อง
4. **ตัดสินข้อมูลเก่า** — ทำให้ตัวเลขเป็นของจริง
5. **M5 + แจ้งเตือน** — ปิดงานพัฒนาที่เหลือ
