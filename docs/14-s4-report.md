# S4 — Implementation Report

วันที่ทดสอบ: 2026-08-26

## สิ่งที่ทำ

- เพิ่ม `channelId` ลง `inbound_events` โดยใช้ `destination` จาก LINE webhook body
- เพิ่ม index `ix_providerChannelStatus`
- เพิ่ม internal endpoints:
  - `POST /api/internal/events/pending`
  - `POST /api/internal/events/ack`
  - `POST /api/internal/events/dead`
  - `POST /api/internal/logs/n8n-error`
- เพิ่ม `deadCount` ใน `/api/health`
- เพิ่ม `docker-compose.yml` สำหรับ n8n local
- เพิ่ม workflow exports:
  - `workflows/WF-A-line-event.json`
  - `workflows/WF-E-error-handler.json`
- เพิ่ม `npm run smoke:s4`
- อัปเดต docs/03, docs/04, docs/07, README

## Design Notes

- WF-A มี Schedule Trigger และ Webhook Trigger แต่ทั้งคู่ล้างคิวทั้งหมดเหมือนกัน
- ไม่มี WF-D แยกใน S4 เพราะ `/events/pending` ปลด stale claim ก่อน claim และ WF-A schedule ทำหน้าที่ reconciler แล้ว
- ยังไม่ส่ง welcome/reply/push กลับไปหาลูกค้า ตาม D20
- ยังไม่ต่อ Slack/LINE Notify/email ตาม D21; WF-E log เข้า `audit_logs` เท่านั้น
- ไม่ฝัง credential จริงใน `workflows/*.json`, `docker-compose.yml`, หรือ source code

## ผลทดสอบจริง

### Typecheck

```text
npm run typecheck
@line-crm/core tsc --noEmit ✅
@line-crm/web  tsc --noEmit ✅
```

### Unit Tests ปกติ

```text
npm test
core: 64 passed, 22 skipped integration
web:  15 skipped integration
```

### Atlas Integration

```text
RUN_MONGO_INTEGRATION=true node --env-file=apps/web/.env.local ./node_modules/vitest/vitest.mjs run --workspace=vitest.workspace.ts

Test Files  11 passed
Tests       101 passed
```

ครอบคลุม:
- S2 inbound outbox 15 เคส
- S3 customer LINE upsert 7 เคส
- S4 internal event routes 15 เคส
- unit tests เดิมทั้งหมด

### Production Build

```text
npm run build --workspace @line-crm/web
Compiled successfully
Routes:
  /api/internal/events/pending
  /api/internal/events/ack
  /api/internal/events/dead
  /api/internal/logs/n8n-error
```

### S4 Smoke

```text
npm run smoke:s4 -- http://127.0.0.1:3101

✅ 1. webhook รับ follow event
✅ 2. pending คืน event พร้อม channelId
✅ 3. upsert สร้าง customer
✅ 4. ack ปิด event
✅ 5. Mongo มี customer/identity/interaction/inbound ครบ
✅ 6. webhook ซ้ำไม่สร้างลูกค้า/interaction เพิ่ม
```

ก่อน smoke มี pending events เก่าจาก `smoke-line` (`eventId` prefix `S-...`) 4 รายการที่ไม่มี `channelId` เพราะถูกสร้างก่อน S4; ลบเฉพาะรายการ dev test เหล่านั้นแล้วจึงรัน smoke S4 ผ่าน

## ยังไม่ได้ทดสอบในรอบนี้

- ยังไม่ได้ import workflow เข้า n8n UI และกด Execute Workflow จริง
- ยังไม่ได้ทดสอบ LINE Profile API จริงผ่าน n8n node; workflow ใช้ `LINE_CHANNEL_ACCESS_TOKEN` จาก env และตั้ง Continue On Fail ไว้แล้ว

## ความเสี่ยง/ข้อควรระวัง

- `LINE_CHANNEL_ACCESS_TOKEN` ต้องอยู่ใน env/credential ของ n8n เท่านั้น ห้าม export workflow พร้อม credential จริง
- `N8N_ENCRYPTION_KEY` ต้อง backup; ถ้าหาย credential ใน n8n จะอ่านไม่ได้
- ถ้า dev queue มี provider `line` pending events เก่าก่อน S4 ที่ไม่มี `channelId`, `/events/pending` จะ fail/backoff ตามสเปก ไม่ควรเดา channelId ย้อนหลัง
