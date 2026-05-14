import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteQualityReviewDraft, getTask, listQualityReviewResults, saveQualityReviewResult } from "@/lib/db";

export const runtime = "nodejs";

const qualityReviewScoreSchema = z.object({
  url: z.string().url(),
  scores: z.array(z.union([z.literal(0), z.literal(1)])).min(1),
  reasons: z.array(z.string()).min(1),
});

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  if (!isQualityReviewConfigured(task)) return NextResponse.json({ error: "Task is not configured for quality review" }, { status: 400 });

  const input = qualityReviewScoreSchema.parse(await request.json());
  if (!task.urls.includes(input.url)) return NextResponse.json({ error: "URL does not belong to this task" }, { status: 400 });
  if (input.scores.length !== task.rubrics.length) {
    return NextResponse.json({ error: "Score count must match rubric count" }, { status: 400 });
  }
  if (input.reasons.length !== task.rubrics.length) {
    return NextResponse.json({ error: "Reason count must match rubric count" }, { status: 400 });
  }

  saveQualityReviewResult({
    taskId: id,
    url: input.url,
    scores: input.scores,
    reasons: input.reasons.map((reason) => reason.trim()),
  });
  deleteQualityReviewDraft(id, input.url);

  const updatedTask = getTask(id);
  if (!updatedTask) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  return NextResponse.json({ task: updatedTask, results: listQualityReviewResults(id) });
}

function isQualityReviewConfigured(task: { qualityReviewEnabled: boolean; qualityReviewScoreMatrix: number[][]; qualityReviewReasonMatrix: string[][]; urls: string[]; rubrics: Array<unknown> }) {
  return (
    task.qualityReviewEnabled &&
    task.qualityReviewScoreMatrix.length === task.urls.length &&
    task.qualityReviewReasonMatrix.length === task.urls.length &&
    task.qualityReviewScoreMatrix.every((row) => row.length === task.rubrics.length) &&
    task.qualityReviewReasonMatrix.every((row) => row.length === task.rubrics.length)
  );
}
