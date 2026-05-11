import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteManualDraft, getManualDraft, getTask, saveManualDraft } from "@/lib/db";

export const runtime = "nodejs";

const scoreSchema = z.union([z.literal(0), z.literal(1)]);

const manualDraftSchema = z.object({
  url: z.string().url(),
  scores: z.array(scoreSchema),
  reasons: z.array(z.string()),
  answeredCount: z.number().int().min(0).optional(),
});

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  if (task.mode !== "manual") return NextResponse.json({ error: "Task is not in manual mode" }, { status: 400 });

  const url = new URL(request.url).searchParams.get("url") ?? "";
  if (!url || !task.urls.includes(url)) return NextResponse.json({ error: "URL does not belong to this task" }, { status: 400 });

  const draft = getManualDraft(id, url);
  return NextResponse.json({ draft: draft ? normalizeDraft(draft, task.rubrics.length) : null });
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  if (task.mode !== "manual") return NextResponse.json({ error: "Task is not in manual mode" }, { status: 400 });

  const input = manualDraftSchema.parse(await request.json());
  if (!task.urls.includes(input.url)) return NextResponse.json({ error: "URL does not belong to this task" }, { status: 400 });
  if (input.scores.length !== task.rubrics.length) {
    return NextResponse.json({ error: "Score count must match rubric count" }, { status: 400 });
  }
  if (input.reasons.length !== task.rubrics.length) {
    return NextResponse.json({ error: "Reason count must match rubric count" }, { status: 400 });
  }

  const reasons = ensureReasonLength(input.reasons, task.rubrics.length);
  const answeredCount = Math.min(input.answeredCount ?? firstUnansweredIndex(reasons, task.rubrics.length), task.rubrics.length);
  const draft = saveManualDraft({
    taskId: id,
    url: input.url,
    scores: input.scores,
    reasons,
    answeredCount,
  });
  return NextResponse.json({ draft });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  if (task.mode !== "manual") return NextResponse.json({ error: "Task is not in manual mode" }, { status: 400 });

  const url = new URL(request.url).searchParams.get("url") ?? "";
  if (!url || !task.urls.includes(url)) return NextResponse.json({ error: "URL does not belong to this task" }, { status: 400 });

  deleteManualDraft(id, url);
  return NextResponse.json({ ok: true });
}

function normalizeDraft(
  draft: { taskId: string; url: string; scores: number[]; reasons: string[]; answeredCount: number; createdAt: string; updatedAt: string },
  rubricCount: number,
) {
  const reasons = ensureReasonLength(draft.reasons, rubricCount);
  return {
    ...draft,
    scores: Array.from({ length: rubricCount }, (_item, index) => (draft.scores[index] ? 1 : 0)),
    reasons,
    answeredCount: firstUnansweredIndex(reasons, rubricCount),
  };
}

function ensureReasonLength(value: string[], count: number) {
  return Array.from({ length: count }, (_item, index) => value[index] ?? "");
}

function firstUnansweredIndex(reasons: string[], count: number) {
  const index = reasons.findIndex((reason, reasonIndex) => reasonIndex < count && !reason.trim());
  return index >= 0 ? index : count;
}
