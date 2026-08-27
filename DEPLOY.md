# Deploy ขึ้น Vercel — คู่มือสำหรับรอบแรก

## 1. เพิ่ม Environment Variables ใน Vercel

### วิธีเร็ว: ให้สคริปต์สร้างไฟล์พร้อมวาง

```bash
cd "/Users/kanyakritbowornsuwan/Desktop/Claude Code/line-crm" && npm run env:vercel -- --domain your-project.vercel.app
```

ได้ไฟล์ `vercel.env.txt` (17 ตัวแปร ครบทุกตัว, gitignored) → เปิดไฟล์ → คัดลอกทั้งหมด
→ Vercel → **Settings → Environment Variables** → คลิกช่อง **Key** แล้ววางทั้งก้อน
Vercel จะแตกเป็นรายตัวให้เอง → ติ๊ก **Production / Preview / Development** ทั้งสามช่อง → Save

> ใส่ `--keep-secrets` ถ้าอยากใช้ secret ชุดเดียวกับ dev (ไม่แนะนำถ้าจะรับข้อมูลลูกค้าจริง)

---

### ที่มาของแต่ละค่า (ถ้าอยากทำเองทีละตัว)

#### 🟢 กลุ่ม A — มีอยู่แล้วในเครื่อง คัดลอกจาก `apps/web/.env.local`

```bash
cd "/Users/kanyakritbowornsuwan/Desktop/Claude Code/line-crm" && open -e apps/web/.env.local
```

| ตัวแปร | ค่าที่ควรใช้ |
|---|---|
| `MONGODB_URI` | ค่าเดิม |
| `MONGODB_DB` | `line_crm_dev` — ค่าเดิม (index + form schema อยู่ในนี้แล้ว) |
| `MONGODB_COMPRESSORS` | `zstd,zlib` |
| `MONGODB_BLOCK_COMPRESSOR` | `zstd` |
| `LINE_CHANNEL_SECRET` | ค่าเดิม |
| `LINE_CHANNEL_ACCESS_TOKEN` | ค่าเดิม |
| `LINE_CHANNEL_ID` | `2011262829` |
| `LINE_LOGIN_CHANNEL_ID` | `2011263761` |
| `NEXT_PUBLIC_LIFF_ID` | `2011263761-R1cpqPt3` |
| `LINE_LOGIN_SCOPES` | `openid profile email` — ตัด `email` ออกถ้า permission ยังไม่อนุมัติ |
| `N8N_PUSH_ENABLED` | `false` (n8n ยังอยู่บนเครื่อง) |
| `AI_HASH_PEPPER` | ค่าเดิมหรือค่าสุ่มใหม่จาก `npm run env:vercel` |

**ถ้าค่า LINE หายหรืออยากออกใหม่** — [LINE Developers Console](https://developers.line.biz/console/)

| ต้องการ | ไปที่ |
|---|---|
| `LINE_CHANNEL_SECRET` | Provider → channel **2011262829** (Messaging API) → แท็บ **Basic settings** → *Channel secret* |
| `LINE_CHANNEL_ACCESS_TOKEN` | channel เดิม → แท็บ **Messaging API** → เลื่อนล่างสุด *Channel access token (long-lived)* → **Issue** |
| `LINE_CHANNEL_ID` | channel เดิม → **Basic settings** → *Channel ID* |
| `LINE_LOGIN_CHANNEL_ID` | channel **2011263761** (LINE Login) → **Basic settings** → *Channel ID* |
| `NEXT_PUBLIC_LIFF_ID` | channel 2011263761 → แท็บ **LIFF** → คอลัมน์ *LIFF ID* |

> ⚠️ ออก access token ใหม่ = ตัวเก่าใช้ไม่ได้ทันที ต้องอัปเดตทั้ง Vercel และ `.env` ของ n8n

**`MONGODB_URI` ถ้าหาย** — [MongoDB Atlas](https://cloud.mongodb.com/) → cluster `line-crm-dev` → **Connect** → *Drivers* → Node.js → คัดลอก แล้วแทน `<password>` ด้วยรหัสของ `kanyakritbo_db_user`

> ⚠️ ต้องตั้ง **Network Access → Add IP → `0.0.0.0/0`** ด้วย เพราะ Vercel ไม่มี IP คงที่ ไม่งั้นต่อไม่ติด

#### 🔵 กลุ่ม B — ต้องสร้างใหม่ ไม่ใช่ค่าจากที่ไหน

ค่าที่ใช้อยู่เป็นค่า dev ที่ผมสร้างให้ ควรใช้คนละชุดกับ production

```bash
openssl rand -base64 48   # AI_HASH_PEPPER
openssl rand -base64 48   # SESSION_JWT_SECRET
openssl rand -base64 48   # INTERNAL_HMAC_SECRET
```

| ตัวแปร | ข้อควรระวัง |
|---|---|
| `AI_HASH_PEPPER` | มีผลกับ hash ใน `line_crm_ai` — เปลี่ยนแล้ว hash ชุดเก่าจะเปลี่ยน |
| `SESSION_JWT_SECRET` | เปลี่ยนได้ ผลคือทุกคนที่เปิด LIFF ค้างอยู่ต้อง login ใหม่ |
| `INTERNAL_HMAC_SECRET` | ⚠️ ต้องใส่ **ค่าเดียวกัน** ใน `.env` ที่รากโปรเจกต์ (n8n อ่านไปใช้) ไม่งั้น n8n โดน 401 |

#### ⚠️ ถ้าอยากแยก DB production ต่างหาก

เปลี่ยน `MONGODB_DB` เป็นชื่อใหม่แล้วต้องรันสองอย่างนี้กับ DB ใหม่ ไม่งั้น LIFF พังเพราะไม่มี form schema

```bash
cd "/Users/kanyakritbowornsuwan/Desktop/Claude Code/line-crm" && MONGODB_DB=line_crm npm run create-indexes && MONGODB_DB=line_crm npm run seed:form
```

### 🟡 กลุ่ม C — ได้หลัง deploy รอบแรก

`ALLOWED_LIFF_ORIGINS` = `https://<domain ที่ Vercel ให้มา>`
ยังไม่รู้ domain ก็ deploy ไปก่อน แล้วค่อยกลับมาแก้แล้ว redeploy

## 2. Deploy

```bash
cd "/Users/kanyakritbowornsuwan/Desktop/Claude Code/line-crm" && npx vercel --prod
```
Root Directory ใน Vercel ต้องตั้งเป็น `apps/web` (หรือปล่อยว่างถ้า Vercel ตรวจ workspace เจอเอง)

## 3. ตั้งค่าใน LINE Developers Console

**Messaging API channel (2011262829)**
- Webhook URL: `https://<domain>.vercel.app/api/webhook/line`
- Use webhook: **เปิด**
- Auto-reply messages: **ปิด** · Greeting messages: ปิด (D20 — ยังไม่ส่งข้อความ)
- กด **Verify** ต้องขึ้นเขียว

**LINE Login channel (2011263761) → LIFF**
- Endpoint URL: `https://<domain>.vercel.app/liff`
- Size: **Full**
- Scopes: `profile`, `openid` (+ `email` ถ้าอนุมัติแล้ว)

## 4. ตรวจหลัง deploy

```bash
curl -s https://<domain>.vercel.app/api/health
```
ต้องได้ `"ok": true` และ `db.ok: true`

จากนั้น **แอดเพื่อน LINE OA ด้วยมือถือตัวเอง** แล้วเช็ค:
1. `inbound_events` มี event ใหม่ (ยิง `/api/internal/events/dead` หรือดูใน Atlas)
2. เปิด LIFF จากลิงก์ `https://liff.line.me/2011263761-R1cpqPt3` → ต้องเห็นฟอร์ม ไม่ใช่ 401
3. กรอกแล้วส่ง → ข้อมูลเข้า `customers`

> ⚠️ ข้อ 2 คือจุดที่ยังไม่เคยพิสูจน์ — ถ้า `aud` ของ id_token ไม่ตรงกับ `LINE_LOGIN_CHANNEL_ID`
> จะได้ 401 ทั้งหมด แก้โดยเช็คว่า LIFF app อยู่ใต้ channel ไหนกันแน่

## 5. n8n

`.env` ที่รากโปรเจกต์ → `API_BASE=https://<domain>.vercel.app` แล้ว `docker compose restart n8n`
`INTERNAL_HMAC_SECRET` ต้องตรงกับที่ตั้งใน Vercel
