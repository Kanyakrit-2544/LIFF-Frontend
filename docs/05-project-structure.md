# Phase 5 — Project Structure

## 5.1 โครงสร้างที่เสนอ

```
line-crm/
├── docs/                                # เอกสารชุดนี้
│   ├── 00-requirements-risks.md
│   ├── 01-architecture.md
│   ├── 02-database.md
│   ├── 03-api.md
│   ├── 04-n8n-workflows.md
│   ├── 05-project-structure.md
│   └── 06-testing.md
│
├── apps/
│   └── web/                             # Next.js 15 (App Router) — Deploy ตัวเดียวบน Vercel
│       ├── app/
│       │   ├── liff/
│       │   │   ├── page.tsx             # LIFF entry — Phase 5
│       │   │   ├── LiffProvider.tsx     # liff.init / login gate
│       │   │   └── components/
│       │   │       ├── ExistingInfo.tsx
│       │   │       ├── DynamicForm.tsx  # render จาก form_schemas
│       │   │       ├── fields/          # TextField / SelectField / RadioField / CheckboxField
│       │   │       ├── ConsentBox.tsx
│       │   │       └── States.tsx       # Loading / Success / Error
│       │   └── api/
│       │       ├── webhook/line/route.ts
│       │       ├── webhook/meta/route.ts        # stub
│       │       ├── webhook/n8n/route.ts
│       │       ├── liff/session/route.ts
│       │       ├── liff/bootstrap/route.ts
│       │       ├── liff/customer/profile/route.ts
│       │       ├── internal/
│       │       │   ├── customers/upsert-from-line/route.ts
│       │       │   ├── customers/[id]/route.ts
│       │       │   ├── customers/merge/route.ts
│       │       │   ├── sheets/pending/route.ts
│       │       │   ├── sheets/ack/route.ts
│       │       │   └── events/{pending,ack,retry}/route.ts
│       │       └── health/route.ts
│       ├── middleware.ts                # CORS + rate limit + requestId
│       ├── next.config.ts
│       └── vercel.json
│
├── packages/
│   ├── core/                            # ⭐ Business Logic — ไม่ผูกกับ HTTP, unit test ได้ล้วน ๆ
│   │   ├── src/
│   │   │   ├── env.ts                   # zod validate env ตอน boot
│   │   │   ├── db/
│   │   │   │   ├── client.ts            # Mongo connection + cache (สำคัญมากบน serverless)
│   │   │   │   ├── models.ts            # TypeScript types ของทุก collection
│   │   │   │   └── migrations/          # index creation + lazy migration
│   │   │   ├── identity/
│   │   │   │   ├── resolve.ts           # §2.4
│   │   │   │   ├── merge.ts             # §2.5
│   │   │   │   └── normalize.ts         # phone → E.164, email → lowercase
│   │   │   ├── customers/
│   │   │   │   ├── upsertFromLine.ts
│   │   │   │   ├── applyFormSubmission.ts
│   │   │   │   └── toSheetRow.ts        # plaintext → จัดคอลัมน์ชีต
│   │   │   ├── ai/
│   │   │   │   ├── scrubCustomer.ts     # CustomerDoc → scrubbed AI payload
│   │   │   │   └── aiMirror.ts          # claim / ack คิว line_crm_ai
│   │   │   ├── forms/
│   │   │   │   ├── schemaStore.ts
│   │   │   │   └── buildZod.ts          # JSON schema → zod (มี test ครบ)
│   │   │   ├── security/
│   │   │   │   ├── lineSignature.ts     # timing-safe verify
│   │   │   │   ├── lineIdToken.ts       # verify + cache
│   │   │   │   ├── internalHmac.ts      # sign + verify + replay window
│   │   │   │   ├── session.ts           # JWT cookie
│   │   │   │   └── pii.ts               # hash / mask สำหรับ AI mirror
│   │   │   ├── events/
│   │   │   │   ├── inbox.ts             # enqueue / claim / ack
│   │   │   │   └── publisher.ts         # ยิง n8n + waitUntil
│   │   │   ├── ratelimit.ts
│   │   │   └── logger.ts                # structured + redact PII อัตโนมัติ
│   │   └── tests/
│   │
│   └── ai/                              # ยังไม่ใช้ — รอ S10/S11 หรือ Presidio จริง
│
├── services/
│   └── pii/                             # Python — ⚠️ critical path ของ WF-C
│       ├── api/
│       │   ├── scrub.py                 # Vercel Python Function
│       │   └── restore.py
│       ├── lib/
│       │   ├── scrubber.py              # ⬅️ script เดิมของคุณ
│       │   ├── restorer.py              # ⬅️ script เดิมของคุณ
│       │   └── vault.py                 # อ่าน/เขียน pii_tokens
│       ├── tests/
│       └── requirements.txt
│
├── workflows/                           # n8n export (commit ลง git)
│   ├── WF-A-line-event.json
│   ├── WF-B-form-submitted.json
│   ├── WF-C-sheets-sync.json
│   ├── WF-D-ai-mirror.json
│   ├── WF-E-error-handler.json
│   └── scripts/strip-credentials.mjs
│
├── scripts/
│   ├── seed-form-schema.ts              # ใส่ form_schemas ตัวแรก
│   ├── create-indexes.ts                # รันก่อน production
│   └── smoke-test.ts                    # ยิงทั้ง flow end-to-end
│
├── .env.example
├── package.json                         # npm workspaces
├── turbo.json                           # (ถ้าต้องการ)
└── README.md
```

---

## 5.2 เหตุผลของโครงสร้างนี้

| การตัดสินใจ | ทำไม | Alternative | Trade-off |
|---|---|---|---|
| **Monorepo (workspaces)** | LIFF frontend + API + core logic แชร์ type เดียวกัน — เปลี่ยน schema แล้ว compile พังทันทีถ้าลืมแก้ที่ใดที่หนึ่ง | แยก repo | monorepo build ช้ากว่านิดหน่อย, Vercel ต้องตั้ง root directory |
| **Next.js App Router ตัวเดียว** | LIFF + API deploy ครั้งเดียว, ไม่มีปัญหา CORS ระหว่างกัน | Vite SPA + แยก API project | Vite เบากว่า แต่ต้องจัดการ CORS/2 deployment |
| **`packages/core` แยกจาก route** | route handler = 10 บรรทัด (parse → เรียก core → format), business logic ทดสอบได้โดยไม่ต้องมี HTTP | เขียนใน route ตรง ๆ | ไฟล์เยอะขึ้น แต่นี่คือข้อกำหนดในโจทย์ ("อย่าเอา logic ไปกองใน n8n") |
| **Python แยกเป็น `services/pii`** | รันคนละ runtime, scale/ปิดได้อิสระ, ของเดิมของคุณย้ายมาแทบไม่ต้องแก้ | rewrite เป็น TS | rewrite เสี่ยงพฤติกรรมเปลี่ยน; แยกไว้ = เอาไป deploy ที่อื่น (Cloud Run) ได้ถ้า Vercel Python ไม่พอ |
| **`workflows/` ใน git** | n8n UI ไม่มี version control — แก้แล้วพังจะย้อนไม่ได้ | ไม่ commit | ต้องมีวินัย export ทุกครั้ง |

---

## 5.3 ลำดับการ Implement ที่แนะนำ

| Step | สิ่งที่ทำ | พิสูจน์อะไร | ใช้เวลาโดยประมาณ |
|---|---|---|---|
| **S1** | `packages/core` — env, db client, models, pii, normalize + `scripts/create-indexes.ts` | ฐานรากถูกต้อง, index มีจริง | 0.5 วัน |
| **S2** | `/api/webhook/line` + `inbound_events` + `/api/health` | LINE ยิงเข้ามาแล้วไม่หาย, signature กันได้ | 0.5 วัน |
| **S3** | `identity/resolve` + `upsertFromLine` + `/internal/customers/upsert-from-line` | ลูกค้าไม่ซ้ำ, firstInteraction ถูก | 1 วัน |
| **S4** | WF-A ใน n8n + WF-E | end-to-end: add friend → เห็นใน Mongo | 0.5 วัน |
| **S5** | `/liff/session` + `/liff/bootstrap` + form_schemas + seed | auth แน่นหนา, form config-driven | 1 วัน |
| **S6** | **LIFF UI** (Phase 5 ของโจทย์) | ผู้ใช้จริงกรอกได้ | 1.5 วัน |
| **S7** | `/liff/customer/profile` + merge logic | ข้อมูลเข้า Mongo + merge ลูกค้าเก่าได้ | 1 วัน |
| **S8** | WF-C: Mongo → `toSheetRow` → Sheets | พนักงานเห็นข้อมูล | เสร็จแล้ว |
| **S9** | Plaintext DB + scrubbed AI mirror + WF-D | AI อ่านได้เฉพาะ DB ปลอดภัย | เสร็จแล้ว |
| **S10** | *(ว่าง — เดิมคือ services/pii ย้ายไป S8a แล้ว)* | | |
| **S11** | Meta stub + `/internal/leads/ingest` | พิสูจน์ว่าขยายได้ | 0.5 วัน |

**เหตุผลของลำดับ:** เดินจาก "ข้อมูลเข้าระบบไม่หาย" → "ระบุตัวตนถูก" → "UI" → "เผยแพร่ออก" → "ทนทาน" → "ขยาย"
ทุก step มีของที่ demo ได้จริง ไม่ใช่ build 2 อาทิตย์แล้วค่อยรู้ว่าพัง
