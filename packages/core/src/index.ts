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
export { personToken, phoneHash, emailHash, ageBand, slipGroupId, nameKeys } from "./ai/tokens";
export {
  scrubLegacyPerson,
  scrubLegacyPayment,
  scrubLegacyEnrollment,
  safeSessionLabel,
  type ScrubbedLegacyPerson,
  type ScrubbedLegacyPayment,
  type ScrubbedLegacyEnrollment,
} from "./ai/scrubLegacy";
export {
  scrubPurchase,
  scrubPurchaseItem,
  scrubCustomerIntent,
  type ScrubbedPurchase,
  type ScrubbedPurchaseItem,
  type ScrubbedCustomerIntent,
} from "./ai/scrubPartner";
export { ensureAiIndexes, verifyAiIndexes, aiIndexMatchesSpec, AI_INDEX_SPECS, type AiIndexSpec } from "./ai/indexes";
export {
  claimLegacyAiSync,
  ackLegacyAiSync,
  LEGACY_AI_LEASE_MS,
  LEGACY_AI_MAX_ATTEMPTS,
  type LegacyAiPendingRow,
  type LegacyAiAckItem,
} from "./legacy/aiQueue";
export { legacyMirrorCountsOk, type LegacyMirrorCount } from "./legacy/verify";
export { decideByRules, type MatchCandidate, type RuleDecision } from "./match/rules";
export {
  buildMatchCandidates,
  customerRowId,
  toLlmFeatures,
  type CandidatePair,
  type LlmPairFeatures,
  type MatchCustomerRow,
  type MatchLegacyRow,
} from "./match/candidates";
export { createLlmProvider, type LlmProvider } from "./ai/llm/provider";
export { evaluateLlmPairs, llmDecisionToRule, serializeLlmBatch, type LlmMatchDecision, type LlmPairResult } from "./ai/llm/match";
export { buildCustomerLinks, verifyCustomerLinks, type MatchBuildOptions, type MatchBuildReport, type MatchVerifyReport } from "./match/engine";
export { plantMatchFixtures, unplantMatchFixtures, type PlantReport } from "./match/fixtures";

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
export {
  mergePairKey,
  isMergePairRejected,
  rejectPendingMerge,
  confirmPendingMerge,
} from "./review/pendingMerge";
export {
  listPendingMergeReviews,
  listCustomerLinkReviews,
  listPartnerReviews,
  decideCustomerLink,
  correctPartnerEvent,
  rejectPartnerEvent,
  assignPartnerIdentity,
  type PendingMergeReviewItem,
  type CustomerLinkReviewItem,
  type PartnerReviewItem,
  type PartnerReviewCandidate,
  type PartnerCorrection,
} from "./review/service";
export {
  getCustomerProfile,
  type CustomerProfile,
  type CustomerPurchaseRow,
} from "./review/customerProfile";
export { checkRateLimit, ensureRateLimitIndex, type RateLimitResult } from "./security/rateLimit";
export { applyFormSubmission, type ApplyFormInput, type ApplyFormResult } from "./customers/applyFormSubmission";
export { toSheetRow, SHEET_COLUMNS, SYSTEM_COLUMNS, HEADERS, COLUMN_IDS, columnLetter, systemRange, type SheetColumn } from "./customers/toSheetRow";
export { claimDirtyCustomers, ackSheetSync, sheetSyncStats, type SheetPendingRow, type SheetAckItem } from "./customers/sheetQueue";
export { upsertFromLine, type UpsertFromLineInput, type UpsertFromLineResult } from "./customers/upsertFromLine";
export { scrubCustomer, type ScrubbedCustomer } from "./ai/scrubCustomer";
export { claimAiMirrorCustomers, ackAiMirror, aiMirrorStats, type AiMirrorPendingRow, type AiMirrorAckItem } from "./ai/aiMirror";
export { partnerSecretFor, partnerLineChannelId } from "./partner/auth";
export { parsePartnerEvent, type ParsedPartnerEvent, type PartnerParseResult } from "./partner/schema";
export { intakePartnerEvents, type PartnerIntakeReport } from "./partner/intake";
export { reconcilePartnerIdentities, type PartnerReconcileReport } from "./partner/reconcile";
export { recomputeIntentCurrent, currentIntent, intentRejectionReason } from "./partner/intents";
export * from "./partner/models";
export * from "./db/models";

export { verifyMetaSignature } from "./security/metaSignature";
export {
  extractLeadgenNotifications,
  type MetaWebhookBody,
  type LeadgenNotification,
  type GraphLead,
} from "./leads/types";
export { mapLead, type MappedLead, type LeadConsentField } from "./leads/mapLead";
export {
  pickMapping,
  buildAttribution,
  loadMappings,
  upsertLeadMapping,
  ensureLeadIndexes,
  LEAD_COLLECTIONS,
  type LeadFormMappingDoc,
  type LeadAttribution,
  type LeadMatchOn,
} from "./leads/attribution";
export { fetchLead, facebookConfigured, type FetchLeadResult } from "./leads/fetchLead";
export { upsertFromLead, type UpsertFromLeadInput, type UpsertFromLeadResult } from "./leads/upsertFromLead";

export {
  analyticsQuerySchema,
  bangkokRange,
  previousRange,
  bangkokKey,
  withDerived,
  METRICS,
  GROUP_BY,
  type AnalyticsQuery,
  type AnalyticsResult,
  type AnalyticsRow,
} from "./analytics/query";
export { runAnalytics } from "./analytics/aggregate";
export { verifyAnswerNumbers, type VerifyResult as AnswerVerifyResult } from "./analytics/verify";
export { parseQuestion, renderAnswer, PROMPT_VERSION, type ParseOutcome, type RenderOutcome } from "./analytics/ask";
export { saveInsight, ensureInsightIndexes, type InsightDoc } from "./analytics/insights";
export { forwardChatToTagger, type ForwardResult } from "./events/forwardChat";
export { eraseCustomer, type EraseResult } from "./partner/erase";
export {
  evaluateDataStatus,
  statusThresholds,
  type StatusIssue,
  type StatusSeverity,
  type StatusThresholds,
  type SystemStatus,
} from "./status/evaluate";
export {
  ConsoleStatusSink,
  updateStatusIncidents,
  type StatusSink,
  type IncidentUpdateResult,
} from "./status/incidents";
export { checkSystemStatus } from "./status/check";
