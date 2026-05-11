import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteManualDraft, deleteResultForTaskUrl, getTask, listResults, makeEmptyEvidence, saveResult, updateTask } from "@/lib/db";

export const runtime = "nodejs";

const manualScoreSchema = z.object({
  url: z.string().url(),
  scores: z.array(z.union([z.literal(0), z.literal(1)])).min(1),
  reasons: z.array(z.string()).optional(),
  pageFailReason: z.string().optional(),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  if (task.mode !== "manual") return NextResponse.json({ error: "Task is not in manual mode" }, { status: 400 });

  const input = manualScoreSchema.parse(await request.json());
  if (!task.urls.includes(input.url)) return NextResponse.json({ error: "URL does not belong to this task" }, { status: 400 });
  if (input.scores.length !== task.rubrics.length) {
    return NextResponse.json({ error: "Score count must match rubric count" }, { status: 400 });
  }
  if (input.reasons && input.reasons.length !== task.rubrics.length) {
    return NextResponse.json({ error: "Reason count must match rubric count" }, { status: 400 });
  }

  const reasons = input.reasons ?? input.scores.map((score) => (score ? "人工标记符合" : "人工未标记符合"));
  deleteResultForTaskUrl(id, input.url);
  saveResult({
    taskId: id,
    url: input.url,
    scores: input.scores,
    reasons,
    evidence: {
      ...makeEmptyEvidence(input.url),
      errors: [],
      technology: { mode: "manual", pageFailReason: input.pageFailReason?.trim() || undefined },
    },
    rawResponse: "manual",
  });
  deleteManualDraft(id, input.url);

  const results = listResults(id);
  const scoredUrls = new Set(results.map((result) => result.url));
  const allDone = task.urls.every((url) => scoredUrls.has(url));
  const updated = updateTask(id, { status: allDone ? "scored" : "rubrics-ready", error: undefined });

  return NextResponse.json({ task: updated, results });
}
