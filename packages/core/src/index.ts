export { env, validateAllEnv, __resetEnvCache } from "./env";
export { log, redact } from "./logger";
export { newId, newCustomerId, newIdentityId, newProfileId, isId, type IdKind } from "./ids";

export {
  normalizePhone,
  normalizeEmail,
  normalizeName,
  normalizeBirthYearBE,
  ageFromBirthYearBE,
  toLocalPhone,
} from "./identity/normalize";

export {
  hashValue,
  maskPhone,
  maskEmail,
} from "./security/pii";
export { personToken, phoneHash, emailHash, ageBand, slipGroupId } from "./ai/tokens";
export {
  scrubLegacyPerson,
  scrubLegacyPayment,
  scrubLegacyEnrollment,
  safeSessionLabel,
  type ScrubbedLegacyPerson,
  type ScrubbedLegacyPayment,
  type ScrubbedLegacyEnrollment,
} from "./ai/scrubLegacy";
export { ensureAiIndexes, verifyAiIndexes, AI_INDEX_SPECS } from "./ai/indexes";
export {
  claimLegacyAiSync,
  ackLegacyAiSync,
  LEGACY_AI_LEASE_MS,
  LEGACY_AI_MAX_ATTEMPTS,
  type LegacyAiPendingRow,
  type LegacyAiAckItem,
} from "./legacy/aiQueue";
export { legacyMirrorCountsOk, type LegacyMirrorCount } from "./legacy/verify";

export { getClient, getDb, closeClient, pingDb } from "./db/client";
export { ensureIndexes, verifyIndexes, INDEX_SPECS, type EnsureResult } from "./db/indexes";

export { verifyLineSignature, signLineBody } from "./security/lineSignature";
export { redactLineEvent, redactLineEvents } from "./events/redact";
export type { LineEvent, LineWebhookBody, LineMessage, LineSource } from "./events/lineTypes";
export {
  enqueueEvents,
  claimPending,
  releaseStaleClaims,
  ackEvents,
  failEvent,
  queueStats,
  type EnqueueInput,
  type EnqueueResult,
  type ClaimOptions,
} from "./events/inbox";
export { publish, signInternal, verifyInternal, type Topic, type PublishResult } from "./events/publisher";

export { verifyLineIdToken, type LineIdTokenPayload, type VerifyResult } from "./security/lineIdToken";
export {
  createSession,
  readSession,
  SESSION_COOKIE,
  sessionCookieOptions,
  type SessionPayload,
  type SessionResult,
} from "./security/session";
export { buildZodFromSchema, normalizeAnswers, collectFields } from "./forms/buildZod";
export { getPublishedSchema, getSchemaVersion, upsertSchema, DEFAULT_FORM_ID } from "./forms/schemaStore";
export type { FormSchemaDoc, FormSection, FormField, FieldType, FieldOption, Localized, FieldValidation, VisibleIf } from "./forms/types";
export { resolveCustomer, type ResolveCustomerInput, type ResolveCustomerResult } from "./identity/resolve";
export { resolveLiffCustomer } from "./identity/resolveLiff";
export { mergeCustomers, pickWinner, type MergeResult } from "./identity/merge";
export { checkRateLimit, ensureRateLimitIndex, type RateLimitResult } from "./security/rateLimit";
export { applyFormSubmission, type ApplyFormInput, type ApplyFormResult } from "./customers/applyFormSubmission";
export { toSheetRow, SHEET_COLUMNS, SYSTEM_COLUMNS, HEADERS, COLUMN_IDS, columnLetter, systemRange, type SheetColumn } from "./customers/toSheetRow";
export { claimDirtyCustomers, ackSheetSync, sheetSyncStats, type SheetPendingRow, type SheetAckItem } from "./customers/sheetQueue";
export { upsertFromLine, type UpsertFromLineInput, type UpsertFromLineResult } from "./customers/upsertFromLine";
export { scrubCustomer, type ScrubbedCustomer } from "./ai/scrubCustomer";
export { claimAiMirrorCustomers, ackAiMirror, aiMirrorStats, type AiMirrorPendingRow, type AiMirrorAckItem } from "./ai/aiMirror";
export * from "./db/models";
