# LINE CRM Integration Platform — POC → Production

ระบบเก็บข้อมูลลูกค้าจาก LINE OA / LIFF เข้าสู่ MongoDB และแสดงผลใน Google Sheets
ออกแบบให้ขยายไป Meta / Facebook API และ AI Pipeline ได้โดยไม่ต้องรื้อระบบ

```
LINE OA ──webhook──> Vercel ──> MongoDB line_crm_dev (Source of Truth)
                        │            ↑
LINE User ──> LIFF ──> Vercel ───────┘
                        │
                        └──> n8n ──> Google Sheets (Operational View)
                        └──> n8n WF-D ──> MongoDB line_crm_ai (AI-safe Mirror)
```

## เอกสาร

| # | เอกสาร | เนื้อหา |
|---|---|---|
| 00 | [Requirements & Risks](docs/00-requirements-risks.md) | สรุป requirement, ข้อที่ยังไม่ชัด, assumption, technical risk 8 ข้อ |
| 01 | [Architecture](docs/01-architecture.md) | component diagram, data flow A–D, responsibility matrix, API boundary |
| 02 | [Database Design](docs/02-database.md) | collections, index, identity strategy, merge algorithm, plaintext + AI mirror |
| 03 | [API Design](docs/03-api.md) | endpoint map, request/response schema, env vars, rate limit |
| 04 | [n8n Workflows](docs/04-n8n-workflows.md) | WF-A ถึง WF-F แบบ node-by-node, idempotency matrix |
| 05 | [Project Structure](docs/05-project-structure.md) | โครง monorepo + ลำดับ implement S1–S11 |
| 06 | [Testing Checklist](docs/06-testing.md) | 90+ เคส ครอบคลุม security, duplicate, merge, recovery |
| 07 | [Local Dev Setup](docs/07-local-dev.md) | n8n บน Docker → pull mode, docker-compose, checklist ขึ้น prod |
| 08 | [LIFF Fields & Sheets](docs/08-liff-fields-and-sheets.md) | โครงสร้าง field ลูกค้า, ร่างฟอร์ม LIFF, layout Google Sheets |
| 09 | [PII Service](docs/09-pii-service.md) | แนวทาง Presidio สำหรับอนาคตเมื่อ mirror คำตอบปลายเปิด / free text |
| 10 | [MongoDB Compression](docs/10-mongodb-compression.md) | network + storage compression, ตัวเลขวัดจริง |
| 11 | [S2 — LINE Webhook](docs/11-s2-webhook.md) | inbound outbox, idempotency, ผลทดสอบ end-to-end |
| 12 | [S3 — Customer Identity (รีวิว)](docs/12-s3-review.md) | resolve/merge/upsert + บั๊ก 4 จุดที่แก้ |
| 13 | [S4 — สเปกงาน](docs/13-s4-spec.md) | n8n WF-A: endpoint ที่ต้องสร้าง, workflow node-by-node, เกณฑ์ผ่านงาน |
| 15 | [S4 — ผลรีวิว](docs/15-s4-review.md) | บั๊ก 8 จุดที่เจอตอนรัน n8n จริง + ผลทดสอบ |
| 16 | [S5 — LIFF Auth + Form Schema](docs/16-s5-liff-auth.md) | id_token verify, session cookie, form schema จาก DB |
| 17 | [S6+S7 — หน้า LIFF + รับข้อมูล](docs/17-s6-s7-liff-form.md) | UI, merge, idempotency, ผลทดสอบจริง |
| 18 | [S7 — ตรวจความปลอดภัย](docs/18-s7-security-review.md) | injection, ช่องโหว่ดูดข้อมูลด้วยเบอร์, rate limit, logging |
| 19 | [S8 — Google Sheets Sync](docs/19-s8-sheets-sync.md) | นิยามคอลัมน์, คิวซิงก์, WF-C, ผลทดสอบจริง |
| 20 | [S9 — Plaintext DB + AI Mirror](docs/20-s9-plaintext-ai-mirror.md) | plaintext phone/email, scrubbed AI DB, WF-D, ผลทดสอบจริง |
| 21 | [S11 — ฐาน legacy (mock) + จับคู่ด้วย AI](docs/21-legacy-mock-and-ai-matching.md) | ข้อมูล synthetic จากสถิติชีตขาย, โครง persons/payments/enrollments, กติกาให้ LLM |
| 22 | [S11-M2 — สเปก scrub legacy](docs/22-s11-m2-spec.md) | scrub deterministic เข้า AI DB, queue, index, verify |
| 23 | [S11-M2 — Implementation Report](docs/23-s11-m2-report.md) | ผลรันจริง: scrub/verify/idempotency + hash parity |
| 24 | [S11-M3 — สเปก Match Engine](docs/24-s11-m3-spec.md) | จับคู่ลูกค้า LINE ↔ ประวัติซื้อ, กติกา hash, ขอบเขตที่ LLM เห็นได้ |
| 25 | [S11-M3 — Implementation Report](docs/25-s11-m3-report.md) | ผลรันจริง + ผลรีวิว (ตรวจ PII ระดับ wire) |
| 26 | [S11-M3.5 — สัญญาเชื่อมต่อระบบติด Tag](docs/26-purchase-intake-contract.md) | **§A ข้อกำหนดให้ระบบ tag · §B สเปกฝั่งรับ** |
| 27 | [S11-M3.5 — Implementation Report](docs/27-s11-m35-report.md) | ผลรันจริง + ผลรีวิว (ทดสอบด้วย payload ที่จงใจโกหก) |
| 28 | [S11-M6 — Facebook Lead Ads](docs/28-s11-m6-facebook-lead.md) | webhook, attribution, consent, ผลรันจริง |
| 25 | [S11-M3 — Implementation Report](docs/25-s11-m3-report.md) | ผลรัน match engine, fixture 25, privacy tests และข้อจำกัด LLM |
| 14 | [S4 — Implementation Report](docs/14-s4-report.md) | endpoint, workflow export, smoke/integration test result |

## Design Decisions (ยืนยันแล้ว)

| # | ประเด็น | ตัดสินใจ |
|---|---|---|
| D1 | Sheets sync latency | รับได้ 0–2 นาที → ใช้ batch reconcile ทุก 2 นาที |
| D2 | ทิศทาง Sheets | **One-way เท่านั้น** (Mongo → Sheets) พนักงานไม่แก้กลับ |
| D3 | Customer merge | ~~Auto-merge~~ → **ตั้งธง `pendingMerge` ให้คนตรวจ** — auto-merge เปิดช่องยึดข้อมูลด้วยเบอร์ (docs/18) |
| D4 | เก็บบทสนทนา | **ไม่เก็บ** — บันทึกเฉพาะ `follow` + `first_message` เท่านั้น, redact ข้อความตั้งแต่ webhook |
| D5 | PDPA consent | **จำเป็น** — มี consent object + หลักฐานการยินยอม |
| D6 | ลำดับ implement | S1 → S11 ตาม docs/05 |
| D7 | n8n dev | Docker บนเครื่อง + **pull mode** (ไม่ต้อง host, ไม่ต้อง tunnel) |
| D8 | n8n prod | Cloud-hosted — เปลี่ยนแค่ `N8N_PUSH_ENABLED=true` |
| D9 | Privacy layer | S9: DB หลักเป็น plaintext, AI เห็นเฉพาะ `line_crm_ai` ที่ scrub/mask/hash แล้ว |
| D10 | หน้าที่ AI | ~~AI match Column ID~~ → **ไม่ใช้ AI** map ตรงจาก `SHEET_COLUMNS` (docs/19) |
| D11 | AI model | ~~OpenAI~~ → **ไม่ใช้** — ไม่มี AI จึงไม่ต้อง scrub/restore ในเส้นทางนี้ |
| D12 | restore ก่อนเขียนชีต | ไม่ใช้แล้วใน WF-C — Sheets อ่านจาก Mongo ตรงและเห็นข้อมูลเต็ม |
| D13 | flow LINE ผ่าน AI ไหม | ❌ ไม่ผ่าน — follow/first_message ไม่มี free text |
| D14 | deploy `services/pii` | พักไว้จนเริ่ม mirror `customer_profiles` หรือ free text ที่ต้องใช้ Presidio |
| D15 | เบอร์/อีเมล ในชีต | **แสดงเต็ม ไม่ mask** จาก plaintext ใน DB หลัก |
| D16 | อายุ | เก็บ **`birthYear` เป็น พ.ศ.** ลูกค้ากรอกเอง (LINE ไม่มี API วันเกิด) |
| D17 | FB / IG | แยก 3 ช่องจาก LINE — ไม่บังคับกรอก |
| D18 | Email จาก LINE | **ยื่นขอ Email permission** — ได้แล้ว prefill ให้, ไม่ได้ก็ให้กรอกเอง |
| D19 | MongoDB compression | network `zstd,zlib` ✅ ใช้งานได้ · block compressor `zstd` ⚠️ Atlas shared tier ไม่อนุญาต → ได้ snappy (docs/10) |
| D20 | ข้อความต้อนรับตอน follow | **ยังไม่ส่ง** — รอ S6 ที่มีปุ่มเปิดฟอร์ม LIFF |
| D21 | ปลายทาง alert เวลาระบบพัง | **เก็บ log ในระบบ** ยังไม่ต่อช่องทางภายนอก |
| D22 | ค่าของ `channelId` | ใช้ `destination` จาก LINE webhook body |
| D31 | webhook ของ Facebook เก็บอะไร | **เก็บแค่ id** — Meta ไม่ส่งข้อมูลลูกค้ามากับ webhook จึงไม่มี PII ใน `inbound_events` |
| D32 | ไม่มี env ของ Facebook | route ตอบ **404** เหมือนไม่มีอยู่ · ระบบส่วนอื่นทำงานปกติ |
| D33 | consent จากฟอร์มโฆษณา | **ห้ามสมมติว่ายินยอม** ไม่มีคำถาม consent = ไม่มี consent |
| D34 | attribution ที่ไม่รู้จัก | เก็บ id ดิบ + `attributionPending` **ห้ามเดาคอร์สจากชื่อแอด** |
| D35 | ข้อมูลดิบจาก Graph API | **ห้ามเก็บทั้งก้อน** map เป็นฟิลด์ที่ใช้จริงแล้วทิ้ง |
| D23 | เอา `customer_links` ไปใช้ยังไง | **สถิติรวมเท่านั้น** — โชว์ประวัติซื้อรายบุคคลต้องมีคนกดยืนยันก่อน เพราะเบอร์ที่ผู้ใช้พิมพ์เองไม่ได้ verify (docs/21) |
| D24 | legacy scrub เดินด้วยอะไร | **สคริปต์** ไม่ใช่ n8n เพราะข้อมูล legacy เป็น batch ที่นิ่ง |
| D25 | `raw` ของเซลล์คอร์ส | **ห้ามออกจาก `line_crm_legacy`** เพราะอาจมีชื่อคนจริงฝังอยู่ |
| D26 | อายุใน AI DB | ส่งเป็นช่วง 10 ปี (`ageBand`) ไม่ส่งอายุเต็ม |
| D27 | เลขสลิปใน AI DB | ส่ง `slipGroupId` แบบ hash 12 ตัวแทนเลขสลิปจริง |
| D28 | ข้อมูลที่ LLM เห็น | เห็นเฉพาะ feature แบบตัวเลข/boolean ห้ามส่งชื่อ เบอร์ อีเมล ID หรือ person token |
| D29 | hash ตรงหลายคน | **ห้าม auto-link** ทุกคู่ต้องเป็น `needs_review` |
| D30 | ไม่มี LLM | deterministic matching ยังทำงานได้ครบ และรายงานคู่ที่ข้าม |

## สถานะ

- [x] Phase 0 — Requirement analysis + risk
- [x] Phase 1 — Architecture
- [x] Phase 2 — Database design
- [x] Phase 3 — API design
- [x] Phase 4 — n8n workflow design
- [x] **S1 — `packages/core` + create-indexes** ✅
- [x] **S2 — `/api/webhook/line` + inbound_events + `/api/health`** ✅
- [x] **S3 — identity resolve + upsertFromLine + internal API** ✅ 86 tests ผ่าน (รีวิว+แก้บั๊ก 4 จุด)
- [x] **S4 — n8n WF-A + internal event queue APIs** ✅
- [x] **S5 — LIFF session + bootstrap + form_schemas** ✅ 145 tests ผ่าน
- [x] **S6+S7 — หน้า LIFF + รับข้อมูลเข้าระบบ + merge** ✅ 159 tests ผ่าน
- [x] **S8 — Google Sheets sync + WF-C** ✅ 175 tests ผ่าน
- [x] **S9 — Plaintext DB + AI Mirror + WF-D** ✅ 178 integration tests ผ่านบน Atlas dev
- [x] **S11-M2 — Scrub legacy เข้า AI mirror** ✅ integration + verify ผ่านบน Mongo local
- [x] **S11-M3 — Match Engine** ✅ fixture 25, deterministic build/verify และ privacy tests ผ่านบน Mongo local
- [ ] Phase 5 — Implementation (S10 → S11)
- [ ] Phase 6 — Testing

## ขอบเขตงานนี้

เก็บข้อมูลลูกค้าจาก **การแอดเพื่อน + การทักครั้งแรก** → LIFF form → MongoDB → Google Sheets

**นอกสโคป (ไว้คิดทีหลัง):** ประวัติการซื้อ/คอร์ส, ข้อมูลการเงิน, ใบกำกับภาษี, การ import ไฟล์ลูกค้าเดิม

## สิ่งที่ยังต้องการจากเจ้าของโปรเจกต์

1. ยืนยัน[ร่างฟอร์ม LIFF](docs/08-liff-fields-and-sheets.md) — เพิ่ม/ตัด/เปลี่ยน field ได้
2. LINE Login channel สำหรับ LIFF (Messaging API dev มีค่า local แล้ว)
3. **`NEXT_PUBLIC_LIFF_ID`** + **LINE Login Channel ID ตัวจริง** (ตอนนี้ซ้ำกับ Messaging API channel — ดู docs/16 §16.5)
4. เพิ่ม env vars ใน **Vercel** — local (`apps/web/.env.local`) ครบแล้ว แต่ Vercel project ยังว่าง
4. ตั้ง LINE webhook URL ชี้ Vercel deployment + ปิด auto-reply
