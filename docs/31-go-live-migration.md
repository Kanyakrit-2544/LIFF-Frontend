# S12 — Go-live & ย้ายไปโครงองค์กร

> เอกสารเดียวที่รวม **ทุกค่าที่ต้องเปลี่ยนเมื่อย้ายจากเครื่อง dev ไปโครงองค์กร**
> ทุกอย่างเป็น env หมดแล้ว ไม่มี host/URL ไหน hardcode ในโค้ด (ยกเว้น `graph.facebook.com` ซึ่งเป็น API ของ Meta เอง)
> **ย้าย = แก้ค่าในตารางข้างล่าง ไม่ต้องแตะโค้ด**

---

## 1. จุดสลับทั้งหมด (org-switch surface)

ค่าเหล่านี้ตอนนี้ชี้ "เครื่องคุณ / บริการชั่วคราว" เมื่อย้ายไปองค์กรให้เปลี่ยนตามคอลัมน์ขวา

### 1.1 n8n — **องค์กร host ให้แล้ว (managed)** ที่ `floatlobe-n8n.wisdomme.co.th`

ไม่ต้องตั้ง VPS เอง · ย้ายจาก n8n บนเครื่อง dev ไป n8n ตัวนี้ = **import workflow + ผูก credential ใหม่ในตัว managed**

| สิ่งที่ต้องทำบน n8n managed | หมายเหตุ |
|---|---|
| import 4 workflow จาก `line-crm/workflows/` (WF-A, C, D, E) | ใส่ `id` ของ credential ในไฟล์ JSON ก่อน import ถ้าทำได้ ไม่งั้นผูก MongoDB credential ใหม่ใน UI |
| ตั้ง env บน n8n managed | `API_BASE`, `INTERNAL_HMAC_SECRET`, `MONGODB_URI`, `MONGODB_MIRROR_URI` + `NODE_FUNCTION_ALLOW_BUILTIN=crypto` + `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` |
| `errorWorkflow` ของ WF-A/C/D ชี้ไป WF-E | อ้างด้วย **id** ไม่ใช่ชื่อ |
| เปลี่ยน trigger เป็น push (ถ้า managed เปิด webhook) | ตั้ง `N8N_PUSH_ENABLED=true` ฝั่ง Vercel + ใส่ URL webhook ของ managed — ไม่บังคับ ยังใช้ pull ได้ |

| ค่าที่ต้องตรงกัน | ห้ามลืม |
|---|---|
| `INTERNAL_HMAC_SECRET` | ⚠️ ต้องตรงกับ Vercel เป๊ะ ไม่งั้น n8n ยิง CRM 401 |
| `AI_HASH_PEPPER` | ต้องเป็นค่าเดิม (ใช้ hash ใน AI DB) |

> **n8n บนเครื่อง dev** (`line-crm/.env` + `.n8n-data/`) เก็บไว้เป็นตัวสำรอง/ทดสอบได้
> แต่ **ห้ามเปิดพร้อม managed** — สองตัวจะแย่งกัน claim งานจากคิวเดียวกัน (คนละ instance ดึง `inbound_events` ชุดเดียวกัน)
> เลือกให้ตัวเดียวทำงานกับ Atlas production ณ เวลาหนึ่ง

**⚠️ ย้ายเสร็จต้องปิด n8n เครื่อง dev** — ตอนนี้เครื่อง dev ยิงเข้า production อยู่ ถ้าเปิดทั้งคู่จะประมวลผลซ้ำ

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
| ที่ตั้งของ tagger เอง | `localhost:4300` | Docker Compose บนเครื่ององค์กร + reverse proxy (§1.5) |

### 1.5 เอา tagger ขึ้นเซิร์ฟเวอร์ (Docker Compose)

tagger มี `Dockerfile` + `docker-compose.yml` แล้ว — ยกทั้งชุด (server + worker + mongo) ด้วยคำสั่งเดียว

```bash
# บนเครื่ององค์กร
git clone <repo ของ tagger>   # หรือ copy โฟลเดอร์ไป
cd tagger
cp .env.example .env          # แล้วกรอกค่าจริง (ดูตาราง §1.2)
docker compose up -d          # ได้ server + worker + mongo ครบ
```

ต้องมีในไฟล์ `.env` อย่างน้อย: `PARTNER_SECRET`, `LINE_CHANNEL_SECRET` (ตรงกับ CRM),
`CRM_INTAKE_URL=https://liff-frontend-three.vercel.app/api/partner/intake`
`TAGGER_MONGO_URI` **ไม่ต้องแก้** — compose ตั้งให้ชี้ mongo ในตัวเองอัตโนมัติ

จุดที่ต้องระวัง
- **รัน 2 process เสมอ** — compose มี `server` (รับแชท) + `worker` (ส่ง outbox เข้า CRM) · ถ้าขาด worker ข้อมูลกองไม่ถูกส่ง
- **อย่าเปิดพอร์ต 4300 ให้อินเทอร์เน็ตตรง** — วาง reverse proxy + TLS หน้า (เหมือนที่ wisdomme ทำให้ n8n) ให้ได้ URL แบบ `https://tagger.<โดเมนองค์กร>/line/webhook`
- **Mongo ของ tagger เป็นคนละตัวกับ CRM** (D1/D3) — compose สร้าง volume แยก อย่าชี้ไป Atlas ของ CRM
- ทดสอบแล้วว่า build + up + รับ webhook (200) ได้จริง (1 ก.ย. 2026)

**พอได้ URL สาธารณะ** → เอาไปใส่ `TAGGER_FORWARD_URL` ใน Vercel → redeploy → แชทเริ่มไหลเข้า tagger

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

- [ ] **ย้าย workflow ไป n8n managed ขององค์กร** (§1.1) — องค์กร host ให้แล้วที่ `floatlobe-n8n.wisdomme.co.th` ไม่ต้องตั้ง VPS เอง · import 4 workflow + ตั้ง env + **ปิด n8n เครื่อง dev** (ห้ามเปิดสองตัวพร้อมกัน จะประมวลผลซ้ำ)
- [ ] **กรอกชื่อธุรกิจ + อีเมลใน `apps/web/app/privacy/page.tsx`** — หน้า PDPA จริงยังเป็น `TODO`
- [ ] **ตัดสิน PDPA 4 ข้อ** ก่อนต่อ Hermes อ่านแชท:
  - [ ] เก็บบทสนทนากี่วันแล้วลบ (`CHAT_RETENTION_DAYS` ใน tagger)
  - [ ] ยอมให้ข้อความออกไป Hermes/ChatGPT ไหม
  - [ ] แก้ข้อความ consent ในฟอร์ม LIFF ให้ครอบคลุมการวิเคราะห์ไหม
  - [ ] ลูกค้าขอลบ → มีเส้นทางลบครบไหม (CRM มี `erase` แล้ว · legacy ยังต้องทำมือ)

### 🟠 เปิดใช้งานจริงเต็มระบบ

- [ ] **เอา tagger ขึ้นเซิร์ฟเวอร์องค์กร** (§1.5) — `docker compose up -d` + reverse proxy → ได้ URL สาธารณะ
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

1. **ย้าย workflow ไป n8n managed** (§1.1) + **เอา tagger ขึ้นเซิร์ฟเวอร์** (§1.5) — n8n ไม่ต้องตั้ง VPS แล้ว (managed) · tagger ขึ้นแล้วปลดล็อก `TAGGER_FORWARD_URL`
2. **กรอก privacy + ตัดสิน PDPA** — ปลดล็อกการต่อ Hermes
3. **ต่อ Hermes + Facebook token** — ระบบครบเครื่อง
4. **ตัดสินข้อมูลเก่า** — ทำให้ตัวเลขเป็นของจริง
5. **M5 + แจ้งเตือน** — ปิดงานพัฒนาที่เหลือ
