import { monotonicFactory } from "ulid";

/**
 * ID ภายในทั้งหมดเป็น prefix + ULID
 * - เรียงตามเวลาได้ (ต่างจาก UUIDv4) → index locality ดี, ไม่กระจายทั่ว B-tree
 * - เดาไม่ได้ ต่างจาก ObjectId ที่เปิดเผย timestamp + machine + counter เมื่อโผล่ใน URL/Sheets
 *
 * ใช้ monotonicFactory ไม่ใช่ ulid() เปล่า ๆ:
 * ulid() สองครั้งใน millisecond เดียวกันได้ random suffix คนละค่า → เรียงลำดับไม่ได้
 * monotonic รับประกันว่า ID ที่สร้างทีหลังมากกว่าเสมอ ภายใน process เดียวกัน
 */
const next = monotonicFactory();

const PREFIX = {
  customer: "cus",
  identity: "idn",
  profile: "prf",
  job: "job",
} as const;

export type IdKind = keyof typeof PREFIX;

export function newId(kind: IdKind): string {
  return `${PREFIX[kind]}_${next()}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^${PREFIX[kind]}_[0-9A-HJKMNP-TV-Z]{26}$`).test(value);
}

export const newCustomerId = () => newId("customer");
export const newIdentityId = () => newId("identity");
export const newProfileId = () => newId("profile");
