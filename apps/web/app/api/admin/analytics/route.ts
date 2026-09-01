import { auth } from "@/auth";
import { isAllowedStaffEmail } from "@/lib/adminAuth";
import { getAdminAiDb } from "@/lib/adminDb";
import { getMirrorAiDb, mirrorConfigured } from "@/lib/mirrorDb";
import {
  PROMPT_VERSION,
  analyticsQuerySchema,
  createLlmProvider,
  parseQuestion,
  renderAnswer,
  runAnalytics,
  saveInsight,
  type AnalyticsQuery,
  type AnalyticsResult,
  type LlmProvider,
} from "@line-crm/core";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function todayBangkok(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function llmProvider(): LlmProvider | null {
  try {
    return createLlmProvider();
  } catch {
    return null;
  }
}

async function saveInsightIfConfigured(input: {
  question: string | null;
  query: AnalyticsQuery;
  result: AnalyticsResult;
  answer: string | null;
  answerVerified: boolean;
  invented: string[];
  model: string | null;
  startedAt: number;
}): Promise<void> {
  if (!mirrorConfigured()) return;
  try {
    await saveInsight(await getMirrorAiDb(), {
      question: input.question,
      params: input.query,
      result: input.result,
      answer: input.answer,
      answerVerified: input.answerVerified,
      invented: input.invented,
      model: input.model,
      promptVersion: PROMPT_VERSION,
      runAt: new Date(),
      elapsedMs: Date.now() - input.startedAt,
    });
  } catch {
    // Analytics remains available when the optional audit writer is not configured or temporarily unavailable.
  }
}

function invalid(message: string) {
  return NextResponse.json({ ok: false, error: "INVALID_QUERY", message }, { status: 400 });
}

export async function POST(request: Request) {
  const session = await auth();
  if (!isAllowedStaffEmail(session?.user?.email)) {
    return NextResponse.json({ ok: false, error: "UNAUTHORIZED" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalid("body ต้องเป็น JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return invalid("body ไม่ถูกต้อง");

  const startedAt = Date.now();
  const record = body as Record<string, unknown>;
  if ("question" in record) {
    if (typeof record.question !== "string" || !record.question.trim() || record.question.length > 500) {
      return invalid("question ต้องเป็นข้อความ 1–500 ตัวอักษร");
    }
    const question = record.question.trim();
    const provider = llmProvider();
    if (!provider) {
      return NextResponse.json({
        ok: true,
        mode: "question",
        llmAvailable: false,
        answer: null,
        answerVerified: false,
        invented: [],
        message: "ยังไม่ได้เชื่อม Hermes กรุณาใช้ตัวเลือกด้านล่างแทน",
      });
    }

    const parsed = await parseQuestion(provider, question, todayBangkok());
    if (!parsed.ok) {
      return NextResponse.json({ ok: true, mode: "question", llmAvailable: true, clarify: parsed.clarify });
    }

    const result = await runAnalytics(await getAdminAiDb(), parsed.query);
    const rendered = await renderAnswer(provider, parsed.query, result);
    const answer = rendered.verified ? rendered.answer : null;
    await saveInsightIfConfigured({
      question,
      query: parsed.query,
      result,
      answer,
      answerVerified: rendered.verified,
      invented: rendered.invented,
      model: provider.name,
      startedAt,
    });
    return NextResponse.json({
      ok: true,
      mode: "question",
      llmAvailable: true,
      query: parsed.query,
      result,
      answer,
      answerVerified: rendered.verified,
      invented: rendered.invented,
    });
  }

  const parsed = analyticsQuerySchema.safeParse(body);
  if (!parsed.success) return invalid(parsed.error.issues[0]?.message ?? "พารามิเตอร์ไม่ถูกต้อง");

  const result = await runAnalytics(await getAdminAiDb(), parsed.data);
  await saveInsightIfConfigured({
    question: null,
    query: parsed.data,
    result,
    answer: null,
    answerVerified: false,
    invented: [],
    model: null,
    startedAt,
  });
  return NextResponse.json(result);
}
