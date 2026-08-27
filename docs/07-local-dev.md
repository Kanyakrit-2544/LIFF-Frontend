# Local Dev Setup — n8n บน Docker (เครื่องตัวเอง)

## 7.1 ปัญหาที่เกิดทันที

Architecture หลัก (docs/01) ให้ **Vercel push ไป n8n**:
```
LINE → Vercel (cloud) ──push──> n8n webhook
```
แต่ถ้า n8n อยู่ใน Docker บนเครื่อง = `http://localhost:5678` → **Vercel บน cloud ยิงเข้ามาไม่ได้**
(ส่วน `LINE → Vercel` ไม่มีปัญหา เพราะ Vercel เป็น public URL อยู่แล้ว)

---

## 7.2 ทางเลือก

| แนวทาง | ข้อดี | ข้อเสีย |
|---|---|---|
| **A. ngrok / cloudflared tunnel** เปิด n8n ออก public | เหมือน production เป๊ะ, latency ต่ำ | URL เปลี่ยนทุกครั้งที่ restart (ngrok free) → ต้องแก้ Vercel env บ่อย; เปิด n8n ออกเน็ต = ต้องมี auth ให้ดี |
| **B. ⭐ Pull mode — n8n cron polls Vercel** | ไม่ต้องเปิด port ออกเน็ตเลย, ไม่มี URL ให้ config, ปลอดภัยกว่า, **ใช้กลไกที่ออกแบบไว้อยู่แล้ว** | latency +0–30 วินาที, เปลือง execution ถ้าย้ายไป n8n Cloud |
| C. รัน Vercel dev บนเครื่องด้วย (`vercel dev`) | ทุกอย่าง localhost | LINE ยิงเข้า localhost ไม่ได้ ต้อง tunnel อยู่ดี |

## 7.3 เลือก B — Pull Mode สำหรับ dev

**ข้อดีที่สำคัญ:** architecture ไม่ต้องเปลี่ยน — WF-A ใน S4 มี Schedule Trigger เป็น pull loop และ reconciler อยู่แล้ว
ตอน dev แค่ **ปิด push** แล้วให้ WF-A schedule ทำงานทุก 15 วินาที เท่านั้น

```
                    ┌─ dev:  (ไม่มี push)
LINE → Vercel → Mongo(inbound_events)
                    └─ prod: push → n8n webhook
                             ↑
              n8n cron ทุก 15 วิ ──pull──> POST /api/internal/events/pending
                    (outbound จากเครื่อง → Vercel = ผ่าน NAT ได้ปกติ)
```

**Config**
```bash
# .env.local (dev)
N8N_PUSH_ENABLED=false        # ปิด push → publisher.ts ข้ามการยิง
# prod
N8N_PUSH_ENABLED=true
N8N_WEBHOOK_LINE=https://n8n.yourdomain.com/webhook/line-event
```

**ในโค้ด** (`packages/core/events/publisher.ts`) — flag เดียว ไม่แตะ logic อื่น:
```ts
export async function publish(topic, payload) {
  if (!env.N8N_PUSH_ENABLED) return { skipped: "pull-mode" }
  waitUntil(signedFetch(env[`N8N_WEBHOOK_${topic}`], payload))
}
```

**S4 actual:** ใช้ WF-A Schedule Trigger ทุก 15 วินาทีเป็น pull loop และ reconciler ในตัว ไม่ต้องมี WF-D event reconciler แยก
**S9 actual:** มี WF-D ใหม่สำหรับ AI mirror เท่านั้น (`workflows/WF-D-ai-mirror.json`)
**ตอนขึ้น prod:** เปลี่ยน env เป็น `true` ได้เพื่อให้ Vercel push มาเร่ง latency แต่ WF-A ยังล้างคิวทั้งหมดเหมือนเดิม — **ไม่ต้องแก้โค้ด**

> นี่คือผลพลอยได้ของ inbound outbox pattern: push เป็นแค่ **การเร่งความเร็ว** ไม่ใช่เส้นทางเดียวที่ข้อมูลไหลได้ ปิดไปก็ยังทำงานถูก

---

## 7.4 docker-compose สำหรับ dev

มีไฟล์จริงที่ราก repo แล้ว: `docker-compose.yml`

```bash
npm run n8n:up
open http://localhost:5678
```
เพิ่ม `.n8n-data/` ลง `.gitignore` — ในนั้นมี credential ที่เข้ารหัสไว้

env ที่ n8n ต้องมี:
```bash
N8N_PASSWORD=
N8N_ENCRYPTION_KEY=          # openssl rand -base64 32
INTERNAL_HMAC_SECRET=        # ค่าเดียวกับ apps/web/.env.local
API_BASE=http://host.docker.internal:3000
LINE_CHANNEL_ACCESS_TOKEN=   # เก็บใน env/credential เท่านั้น ห้าม commit
```

คำสั่งช่วย:
```bash
npm run n8n:logs
npm run n8n:down
```

---

## 7.5 Dev Environment ทั้งชุด

| ส่วน | dev | หมายเหตุ |
|---|---|---|
| LIFF + API | **Vercel Preview deploy** (ทุก push ได้ URL ใหม่) | LINE webhook + LIFF endpoint ต้องเป็น HTTPS public — preview URL ใช้ได้เลย |
| MongoDB | **Atlas M0 free** (dev cluster แยกจาก prod) | อย่าใช้ Mongo local — n8n ใน Docker กับ Vercel ต้องเห็นตัวเดียวกัน |
| n8n | Docker local, pull mode | เข้าถึง Atlas + Vercel แบบ outbound ได้ปกติ |
| Google Sheets | Sheet แยกสำหรับ dev | Service Account เดียวกันได้ แค่คนละ `GOOGLE_SHEET_ID` |
| LINE | **Messaging API + Login channel ชุด dev แยก** | อย่าใช้ OA จริงทดสอบ — user จริงจะได้ welcome message มั่ว |

**Workflow การทำงาน:** แก้โค้ด → `git push` → Vercel preview URL → เอา URL ไปตั้ง LINE webhook + LIFF endpoint (ครั้งเดียวถ้าใช้ branch เดิม) → ทดสอบใน LINE app จริง

**ทางเลือกถ้าอยาก hot-reload:** `vercel dev` + `cloudflared tunnel --url http://localhost:3000` → ได้ HTTPS URL ชี้เครื่องตัวเอง แก้โค้ดเห็นผลทันที (แต่ URL เปลี่ยนทุกครั้งที่ restart tunnel)

---

## 7.6 Checklist ก่อนย้ายขึ้น Production

- [ ] `N8N_PUSH_ENABLED=true` + ตั้ง `N8N_WEBHOOK_*` ให้ครบ
- [ ] WF-A schedule ปรับจากทุก 15 วินาทีเป็นทุก 1 นาทีถ้าต้องการประหยัด execution
- [ ] n8n มี HTTPS + reverse proxy + basic auth (หรือ SSO)
- [ ] `N8N_ENCRYPTION_KEY` backup แล้ว
- [ ] Mongo prod cluster แยก + IP allowlist (Vercel ใช้ `0.0.0.0/0` + strong password หรือ Atlas Private Endpoint)
- [ ] secret ทุกตัว rotate ใหม่ ไม่ใช้ตัวเดียวกับ dev
- [ ] LINE channel prod + LIFF endpoint ชี้ production domain
- [ ] รัน `scripts/create-indexes.ts` บน prod cluster

---

## 7.7 จะ Host n8n ที่ไหนตอน Test

### ข้อสังเกตก่อน: ตอน test คุณ **ไม่จำเป็นต้อง host n8n ที่ไหนเลย**

ด้วย pull mode (§7.3) n8n ต้องการแค่ **outbound internet** เท่านั้น — ไม่ต้องมี public URL, ไม่ต้องเปิด port
`docker compose up` บนเครื่องตัวเอง แล้วต่อ Atlas + Vercel ได้ครบทุกอย่าง **ฟรี 100% และ setup 2 นาที**

ข้อจำกัดจริงข้อเดียว: **ปิดเครื่อง = workflow หยุด** ถ้าไม่ได้จะ demo ให้คนอื่นดูตอนคุณไม่อยู่ ก็ไม่ต้องหา host

---

### ถ้าต้องการให้รันตลอด 24 ชม.

> ⚠️ ข้อมูล free tier เปลี่ยนบ่อย — ตรวจเงื่อนไขล่าสุดก่อนสมัครทุกครั้ง

| ตัวเลือก | ฟรีจริงไหม | เหมาะกับ n8n ไหม | หมายเหตุ |
|---|---|---|---|
| **Oracle Cloud — Always Free (ARM Ampere)** | ✅ ฟรีถาวร | ⭐ ดีที่สุด | 4 vCPU / 24GB RAM / 200GB — เกินพอสำหรับ n8n หลายตัว **น่าจะเป็นตัวที่คุณเคยใช้** ข้อเสีย: ARM capacity เต็มบ่อยมาก ต้องกดขอซ้ำหลายรอบ (บางคนใช้เวลาเป็นสัปดาห์) |
| **Google Cloud — e2-micro Always Free** | ✅ ฟรีถาวร (1 เครื่อง, บาง region) | 🟡 พอไหว | 1GB RAM — n8n รันได้แต่ตึง ต้องเพิ่ม swap; workflow หนัก ๆ OOM ได้ |
| **AWS EC2 t2/t3.micro** | 🟡 ฟรี 12 เดือนแรก | 🟡 พอไหว | 1GB RAM เหมือนกัน; หมดปีแล้วเริ่มคิดเงิน |
| **Fly.io** | 🟡 มี free allowance | ✅ ดี | มี persistent volume, deploy จาก Dockerfile ง่าย, scale-to-zero ได้ แต่ cron จะไม่ทำงานถ้า sleep |
| **Railway** | ❌ ไม่มี free tier ถาวรแล้ว (มี trial credit) | ⭐ ง่ายที่สุด | มี n8n template กด deploy ได้เลย ~$5/เดือน — **ถ้ายอมจ่าย $5 นี่คือตัวที่ประหยัดเวลาที่สุด** |
| **Render** | 🟡 free web service มี | ❌ **อย่าใช้** | free tier ไม่มี persistent disk + sleep หลังไม่มี traffic 15 นาที → **credential และ workflow หายหมด** และ cron ไม่ทำงาน |
| **n8n Cloud** | 🟡 trial ~14 วัน | ✅ | ไม่ต้องดูแลอะไรเลย แต่หมด trial ต้องจ่าย และคิดตาม execution (WF-A schedule ทุกนาที = 1,440/วัน) |

### คำแนะนำของผม

| สถานการณ์ | ใช้อะไร |
|---|---|
| **ตอนนี้ — dev/test คนเดียว** | Docker บนเครื่อง + pull mode (§7.3) ไม่ต้อง host |
| **ต้อง demo ให้ลูกค้า/ทีมดูตลอด** | Railway $5/เดือน (ประหยัดเวลาที่สุด) หรือ Oracle Always Free ถ้ามีเวลารอ capacity |
| **Production** | VPS ที่จ่ายเงิน (DigitalOcean/Hetzner ~$6/เดือน) หรือ n8n Cloud — **อย่าใช้ free tier กับข้อมูลลูกค้าจริง** |

### ⚠️ ไม่ว่าจะเลือกอันไหน ต้องทำ 4 อย่างนี้

1. **`N8N_ENCRYPTION_KEY` ตั้งเองและ backup ไว้** — ถ้าหาย = credential ทั้งหมดใน n8n อ่านไม่ได้ ต้องตั้งใหม่หมด
2. **Persistent volume** สำหรับ `/home/node/.n8n` — ไม่มี = restart ทีเดียวหายหมด (นี่คือสาเหตุที่ Render free ใช้ไม่ได้)
3. **Basic auth หรือ reverse proxy + HTTPS** — n8n ที่เปิด public โดยไม่มี auth = ใครก็แก้ workflow และอ่าน credential ได้
4. **`EXECUTIONS_DATA_MAX_AGE`** สั้น ๆ (7 วัน) — execution log เก็บ payload ที่มีข้อมูลลูกค้า

### ทางลัดตอนย้ายขึ้น host จริง
ไม่ต้องแก้ architecture อะไรเลย — แค่:
```bash
N8N_PUSH_ENABLED=true
N8N_WEBHOOK_LINE=https://n8n.yourdomain.com/webhook/line-event
N8N_WEBHOOK_FORM=https://n8n.yourdomain.com/webhook/form-submitted
```
แล้วเปลี่ยน WF-A Schedule Trigger จากทุก 15 วินาที → ทุก 1 นาทีถ้าต้องการประหยัด execution
