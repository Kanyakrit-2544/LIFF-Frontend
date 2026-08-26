/** subset ของ LINE webhook ที่ระบบนี้ใช้จริง — ไม่ดึง SDK ทั้งก้อนมาเพื่อ parse */

export interface LineSource {
  type: "user" | "group" | "room";
  userId?: string;
  groupId?: string;
  roomId?: string;
}

export interface LineMessage {
  id: string;
  type: "text" | "image" | "video" | "audio" | "file" | "location" | "sticker";
  text?: string;
  fileName?: string;
  packageId?: string;
  stickerId?: string;
  [k: string]: unknown;
}

export interface LineEvent {
  type: string; // follow | unfollow | message | postback | join | leave | ...
  webhookEventId?: string;
  deliveryContext?: { isRedelivery: boolean };
  timestamp?: number;
  source?: LineSource;
  replyToken?: string;
  message?: LineMessage;
  [k: string]: unknown;
}

export interface LineWebhookBody {
  destination?: string;
  events?: LineEvent[];
}
