import { ObjectId } from "mongodb";
import { getDb } from "../db/client";
import { COLLECTIONS, type CustomerDoc, type InteractionDoc, type InteractionType } from "../db/models";
import { resolveCustomer } from "../identity/resolve";

export type LineUpsertEventType = "follow" | "message" | "unfollow";

export interface UpsertFromLineInput {
  eventId: string;
  provider?: "line";
  channelId: string;
  lineUserId: string;
  eventType: LineUpsertEventType;
  occurredAt: Date | string;
  profile?: {
    displayName?: string | null;
    pictureUrl?: string | null;
  } | null;
  message?: {
    type?: string | null;
  } | null;
}

export interface UpsertFromLineResult {
  customerId: string;
  isNew: boolean;
  interactionCreated: boolean;
  milestone: "follow" | "first_message" | null;
}

function toDate(value: Date | string): Date {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error("occurredAt ไม่ถูกต้อง");
  return d;
}

function isDuplicateKey(e: unknown): boolean {
  return (e as { code?: number }).code === 11000;
}

function cleanProfile(profile: UpsertFromLineInput["profile"]) {
  return {
    displayName: profile?.displayName?.trim() || null,
    pictureUrl: profile?.pictureUrl || null,
  };
}

async function insertInteraction(input: {
  customerId: string;
  type: InteractionType;
  occurredAt: Date;
  sourceEventId: string;
  payload: Record<string, unknown>;
}): Promise<boolean> {
  try {
    await (await getDb()).collection<InteractionDoc>(COLLECTIONS.interactions).insertOne({
      _id: new ObjectId(),
      customerId: input.customerId,
      type: input.type,
      channel: "line",
      occurredAt: input.occurredAt,
      sourceEventId: input.sourceEventId,
      payload: input.payload,
      createdAt: new Date(),
    });
    return true;
  } catch (e) {
    if (isDuplicateKey(e)) return false;
    throw e;
  }
}

async function setFirstInteractionAt(customerId: string, occurredAt: Date, now: Date): Promise<boolean> {
  const r = await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
    {
      _id: customerId,
      $or: [
        { firstInteractionAt: { $exists: false } },
        { firstInteractionAt: null },
        { firstInteractionAt: { $gt: occurredAt } },
      ],
    },
    { $set: { firstInteractionAt: occurredAt, "sheetSync.dirty": true, updatedAt: now } }
  );
  return r.modifiedCount === 1;
}

async function updateLineCustomer(input: {
  customerId: string;
  eventType: LineUpsertEventType;
  occurredAt: Date;
  now: Date;
  profile: { displayName: string | null; pictureUrl: string | null };
  setDirty: boolean;
}) {
  const set: Record<string, unknown> = {
    updatedAt: input.now,
  };
  if (input.eventType === "unfollow") set.customerStatus = "inactive";

  // lineDisplayName = กระจกสะท้อนค่าจาก LINE → อัปเดตได้ตลอด
  // displayName      = ชื่อที่ระบบใช้แสดง ซึ่งลูกค้าแก้เองได้ในฟอร์ม LIFF (docs/08)
  //                    → ห้ามทับ ไม่งั้นข้อความที่ลูกค้าส่งมาทีหลังจะลบชื่อจริงทิ้ง
  if (input.profile.displayName) set.lineDisplayName = input.profile.displayName;
  if (input.profile.pictureUrl) set.pictureUrl = input.profile.pictureUrl;
  if (input.setDirty) set["sheetSync.dirty"] = true;

  await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
    { _id: input.customerId },
    {
      $set: set,
      $max: { lastInteractionAt: input.occurredAt },
      $addToSet: {
        sources: "line",
        ...(input.eventType === "follow" ? { tags: "line-follower" } : {}),
      },
    }
  );

  // เติมชื่อให้เฉพาะตอนที่ยังว่าง (fill-forward) — ไม่ทับของเดิม
  if (input.profile.displayName) {
    await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
      { _id: input.customerId, $or: [{ displayName: { $exists: false } }, { displayName: null }, { displayName: "" }] },
      { $set: { displayName: input.profile.displayName, updatedAt: input.now, "sheetSync.dirty": true } }
    );
  }

  if (input.eventType === "follow") {
    await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
      { _id: input.customerId, customerStatus: "inactive" },
      { $set: { customerStatus: "lead", updatedAt: input.now, "sheetSync.dirty": true } }
    );
  }
}

export async function upsertFromLine(input: UpsertFromLineInput): Promise<UpsertFromLineResult> {
  if (!input.eventId || !input.channelId || !input.lineUserId) {
    throw new Error("eventId, channelId และ lineUserId จำเป็นต้องมี");
  }
  if (!["follow", "message", "unfollow"].includes(input.eventType)) {
    throw new Error("eventType ไม่รองรับ");
  }

  const occurredAt = toDate(input.occurredAt);
  const now = new Date();
  const profile = cleanProfile(input.profile);

  const resolved = await resolveCustomer({
    provider: input.provider ?? "line",
    channelId: input.channelId,
    externalId: input.lineUserId,
    verified: true,
    meta: { source: "line_webhook" },
    create: {
      now,
      firstInteractionAt: occurredAt,
      lastInteractionAt: occurredAt,
      displayName: profile.displayName,
      lineDisplayName: profile.displayName,
      pictureUrl: profile.pictureUrl,
      sourceChannel: "line",
      tags: input.eventType === "follow" ? ["line-follower"] : [],
    },
  });

  const firstInteractionUpdated = await setFirstInteractionAt(resolved.customerId, occurredAt, now);

  if (input.eventType === "follow") {
    const interactionCreated = await insertInteraction({
      customerId: resolved.customerId,
      type: "follow",
      occurredAt,
      sourceEventId: input.eventId,
      payload: {},
    });
    await updateLineCustomer({
      customerId: resolved.customerId,
      eventType: input.eventType,
      occurredAt,
      now,
      profile,
      setDirty: interactionCreated || firstInteractionUpdated,
    });
    if (interactionCreated) {
      await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
        { _id: resolved.customerId },
        { $inc: { "counters.milestones": 1 } }
      );
    }
    return { customerId: resolved.customerId, isNew: resolved.isNew, interactionCreated, milestone: interactionCreated ? "follow" : null };
  }

  if (input.eventType === "message") {
    const first = await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
      { _id: resolved.customerId, $or: [{ firstMessageAt: { $exists: false } }, { firstMessageAt: null }] },
      {
        $set: { firstMessageAt: occurredAt, "sheetSync.dirty": true, updatedAt: now },
        $addToSet: { tags: "engaged" },
        $max: { lastInteractionAt: occurredAt },
      }
    );

    if (first.modifiedCount === 1) {
      // โปรไฟล์อาจเพิ่งดึงได้ตอนนี้ (ตอน follow อาจโดน 404 เพราะผู้ใช้บล็อกบอทอยู่)
      // ถ้าไม่อัปเดตตรงนี้ ลูกค้าที่ทักก่อนจะไม่มีชื่อ/รูปเลย
      await updateLineCustomer({
        customerId: resolved.customerId,
        eventType: input.eventType,
        occurredAt,
        now,
        profile,
        setDirty: true,
      });

      const interactionCreated = await insertInteraction({
        customerId: resolved.customerId,
        type: "first_message",
        occurredAt,
        sourceEventId: input.eventId,
        payload: { messageType: input.message?.type ?? null },
      });
      if (interactionCreated) {
        await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
          { _id: resolved.customerId },
          { $inc: { "counters.milestones": 1 } }
        );
      }
      return { customerId: resolved.customerId, isNew: resolved.isNew, interactionCreated, milestone: interactionCreated ? "first_message" : null };
    }

    await updateLineCustomer({
      customerId: resolved.customerId,
      eventType: input.eventType,
      occurredAt,
      now,
      profile,
      setDirty: firstInteractionUpdated,
    });
    return { customerId: resolved.customerId, isNew: resolved.isNew, interactionCreated: false, milestone: null };
  }

  const interactionCreated = await insertInteraction({
    customerId: resolved.customerId,
    type: "unfollow",
    occurredAt,
    sourceEventId: input.eventId,
    payload: {},
  });
  await updateLineCustomer({
    customerId: resolved.customerId,
    eventType: input.eventType,
    occurredAt,
    now,
    profile,
    setDirty: interactionCreated || firstInteractionUpdated,
  });
  if (interactionCreated) {
    await (await getDb()).collection<CustomerDoc>(COLLECTIONS.customers).updateOne(
      { _id: resolved.customerId },
      { $inc: { "counters.milestones": 1 } }
    );
  }
  return { customerId: resolved.customerId, isNew: resolved.isNew, interactionCreated, milestone: null };
}
