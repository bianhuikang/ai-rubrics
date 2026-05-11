import { NextResponse } from "next/server";
import { z } from "zod";
import { getSettings, getTask, listResults, migrateManualDraftsAfterRubricRemoval, updateResultScoresAndReasons, updateTask } from "@/lib/db";
import { generateRubrics } from "@/lib/llm";
import { logRubrics, logTaskStep } from "@/lib/server-log";

export const runtime = "nodejs";
export const maxDuration = 600;

const rubricSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  evidenceHints: z.array(z.string()).default([]),
});

const updateRubricsSchema = z.object({
  rubrics: z.array(rubricSchema).min(1),
  removedIndexes: z.array(z.number().int().min(0)).default([]),
  preserveRubricsModified: z.boolean().default(false),
});

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  try {
    const settings = getSettings();
    updateTask(id, { status: "generating-rubrics", error: undefined });
    logTaskStep(id, "开始生成 rubrics");
    const rubrics = await generateRubrics(settings, task.prompt, []);
    logRubrics(id, rubrics);
    logTaskStep(id, "rubrics 生成成功", { count: rubrics.length });
    const updated = updateTask(id, { rubrics, rubricsSource: "generated", status: "rubrics-ready", error: undefined });
    return NextResponse.json(updated);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateTask(id, { status: "error", error: message });
    logTaskStep(id, "rubrics 生成失败", { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  try {
    const input = updateRubricsSchema.parse(await request.json());
    const normalizedRubrics = input.rubrics.map((rubric, index) => ({
      ...rubric,
      id: `R${index + 1}`,
      name: rubric.name?.trim() || `规则 ${index + 1}`,
      description: rubric.description.trim(),
      evidenceHints: rubric.evidenceHints || [],
    }));
    const rubricsChanged = JSON.stringify(normalizedRubrics) !== JSON.stringify(task.rubrics);
    const nextRubricsModified = input.preserveRubricsModified ? task.rubricsModified : task.rubricsModified || rubricsChanged;

    const removedIndexes = Array.from(new Set(input.removedIndexes)).sort((a, b) => b - a);
    if (removedIndexes.length) {
      for (const result of listResults(id)) {
        const nextScores = result.scores.filter((_score, index) => !removedIndexes.includes(index));
        const nextReasons = result.reasons.filter((_reason, index) => !removedIndexes.includes(index));
        updateResultScoresAndReasons(result.id, nextScores, nextReasons);
      }
      migrateManualDraftsAfterRubricRemoval(id, removedIndexes, normalizedRubrics.length);
    }

    const updated = updateTask(id, {
      rubrics: normalizedRubrics,
      rubricsSource: task.rubricsSource === "none" ? "user" : task.rubricsSource,
      rubricsModified: nextRubricsModified,
      error: undefined,
    });
    return NextResponse.json({ task: updated, results: listResults(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
