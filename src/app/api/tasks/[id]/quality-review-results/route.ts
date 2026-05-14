import { NextResponse } from "next/server";
import { getTask, listQualityReviewResults, resetQualityReviewProgress } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  return NextResponse.json({ results: listQualityReviewResults(id) });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
  if (!task.qualityReviewEnabled) {
    return NextResponse.json({ error: "Task is not configured for quality review" }, { status: 400 });
  }

  const updatedTask = resetQualityReviewProgress(id);
  return NextResponse.json({ task: updatedTask, results: listQualityReviewResults(id) });
}
