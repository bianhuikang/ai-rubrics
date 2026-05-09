import { NextResponse } from "next/server";
import { collectPageEvidence } from "@/lib/collector";
import { deleteResultsForTask, deleteTaskLogsForTask, getSettings, getTask, listResults, saveResult, updateTask } from "@/lib/db";
import { generateRubrics, scorePage } from "@/lib/llm";
import { trimForPrompt } from "@/lib/requirement-parser";
import { logEvidence, logRubrics, logScores, logTaskStep } from "@/lib/server-log";
import type { PageEvidence } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 900;

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const task = getTask(id);
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

  const settings = getSettings();

  try {
    const previousEvidence = new Map(listResults(id).map((result) => [result.url, result.evidence]));
    deleteTaskLogsForTask(id);
    logTaskStep(id, "开始执行任务", { urls: task.urls.length });
    logTaskStep(id, `解析到 URL ${task.urls.length} 个`, { urls: task.urls });
    if (previousEvidence.size) {
      logTaskStep(id, `发现历史页面证据 ${previousEvidence.size} 条，优先复用`, {
        reused: task.urls.filter((url) => previousEvidence.has(url)).length,
      });
    }
    deleteResultsForTask(id);
    updateTask(id, { status: "generating-rubrics", error: undefined });

    const candidates = [];
    const collected: Array<{ url: string; evidence: PageEvidence }> = [];
    for (const [index, url] of task.urls.entries()) {
      try {
        const cached = previousEvidence.get(url);
        if (cached) {
          logTaskStep(id, `复用历史页面证据 ${index + 1}/${task.urls.length}`, { url });
          collected.push({ url, evidence: cached });
          candidates.push({
            url,
            summary: summarizeEvidenceForRubrics(cached),
          });
          continue;
        }

        logTaskStep(id, `抓取候选产物 ${index + 1}/${task.urls.length}`, { url });
        const evidence = await collectPageEvidence({ url, prompt: task.prompt, taskId: task.id, index });
        logEvidence(id, evidence);
        logTaskStep(id, `候选产物抓取成功 ${index + 1}/${task.urls.length}`, { url });
        collected.push({ url, evidence });
        candidates.push({
          url,
          summary: summarizeEvidenceForRubrics(evidence),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logTaskStep(id, `候选产物抓取失败 ${index + 1}/${task.urls.length}`, {
          url,
          error: message,
        });
        collected.push({ url, evidence: failedEvidence(url, message) });
        candidates.push({
          url,
          summary: {
            errors: [message],
          },
        });
      }
    }

    logTaskStep(id, "开始生成 rubrics");
    const rubrics = await generateRubrics(settings, task.prompt, candidates);
    logRubrics(id, rubrics);
    logTaskStep(id, "rubrics 生成成功", { count: rubrics.length });
    const taskWithRubrics = updateTask(id, { rubrics, status: "scoring", error: undefined });

    for (const [index, collectedItem] of collected.entries()) {
      const { url, evidence } = collectedItem;
      logTaskStep(id, `开始对 URL ${index + 1}/${collected.length} 打分`, { url });
      logTaskStep(id, `复用已抓取页面证据 ${index + 1}/${collected.length}`, { url });
      logTaskStep(id, `调用模型评分 ${index + 1}/${taskWithRubrics.urls.length}`, { url });
      const scored = await scorePage({
        settings,
        prompt: taskWithRubrics.prompt,
        rubrics: taskWithRubrics.rubrics,
        evidence,
      });
      saveResult({
        taskId: id,
        url,
        evidence,
        scores: scored.scores,
        reasons: scored.reasons,
        rawResponse: scored.rawResponse,
      });
      logScores(id, url, scored.scores, scored.reasons);
      logTaskStep(id, `URL ${index + 1}/${collected.length} 打分完成`, {
        url,
        scores: scored.scores,
        total: scored.scores.reduce((sum, score) => sum + score, 0),
      });
    }

    const updated = updateTask(id, { status: "scored", error: undefined });
    logTaskStep(id, "任务执行完成", {
      urls: updated.urls.length,
      rubrics: updated.rubrics.length,
      results: listResults(id).length,
    });
    return NextResponse.json({ task: updated, results: listResults(id) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateTask(id, { status: "error", error: message });
    logTaskStep(id, "任务执行失败", { error: message });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function summarizeEvidenceForRubrics(evidence: PageEvidence) {
  return {
    title: evidence.title,
    visibleText: trimForPrompt(evidence.visibleText, 4000),
    requirements: evidence.requirements,
    requiredElements: evidence.requiredElements,
    controls: evidence.controls.slice(0, 60),
    layout: evidence.layout,
    visual: evidence.visual,
    technology: evidence.technology,
    responsive: evidence.responsive,
    motion: evidence.motion,
    interactions: evidence.interactions,
    errors: evidence.errors,
  };
}

function failedEvidence(url: string, error: string): PageEvidence {
  return {
    url,
    finalUrl: url,
    title: "",
    htmlSample: "",
    visibleText: "",
    requirements: { ids: [], classes: [] },
    requiredElements: [],
    importantElements: [],
    controls: [],
    layout: {},
    visual: {},
    technology: {},
    responsive: {},
    motion: {},
    interactions: [],
    errors: [`Collection failed: ${error}`],
  };
}
