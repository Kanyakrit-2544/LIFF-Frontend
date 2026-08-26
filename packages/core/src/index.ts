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
  encrypt,
  decrypt,
  hashValue,
  maskPhone,
  maskEmail,
  packPhone,
  packEmail,
  forSheet,
  type PiiTriple,
} from "./security/pii";

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
export { applyFormSubmission, type ApplyFormInput, type ApplyFormResult } from "./customers/applyFormSubmission";
export { upsertFromLine, type UpsertFromLineInput, type UpsertFromLineResult } from "./customers/upsertFromLine";
export * from "./db/models";
