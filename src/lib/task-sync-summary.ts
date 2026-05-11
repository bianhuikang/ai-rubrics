import type { ScoreResult, Task } from "./types";

export type TaskSyncSummary = {
  taskId: string;
  status: Task["status"];
  scoreText: string;
  remarkText: string;
  rubricsText: string;
  resultCount: number;
  urlCount: number;
  rubricsModified: boolean;
  updatedAt: string;
};

export function buildTaskSyncSummary(task: Task, results: ScoreResult[]): TaskSyncSummary {
  const orderedResults = task.urls
    .map((url) => results.find((result) => result.url === url))
    .filter((result): result is ScoreResult => Boolean(result));
  const remarkItems = summarizeFailReasons(task, results);

  return {
    taskId: task.id,
    status: task.status,
    scoreText: JSON.stringify(orderedResults.map((result) => result.scores)),
    remarkText: remarkItems.map((item, index) => `${index + 1}. ${item}`).join("\n"),
    rubricsText: task.rubrics.map((rubric, index) => `${index + 1}.${stripRubricListMarker(rubric.description)}`).join("\n"),
    resultCount: orderedResults.length,
    urlCount: task.urls.length,
    rubricsModified: task.rubricsModified,
    updatedAt: task.updatedAt,
  };
}

function summarizeFailReasons(task: Task, results: ScoreResult[]) {
  const summaries: string[] = [];
  const resultByUrl = new Map(results.map((result) => [result.url, result]));

  task.urls.forEach((url, urlIndex) => {
    const result = resultByUrl.get(url);
    if (!result) return;
    const pageFailReason = getPageFailReason(result);
    if (pageFailReason) {
      summaries.push(`\u7b2c${urlIndex + 1}\u4e2a\u9875\u9762->${pageFailReason}`);
      return;
    }

    task.rubrics.forEach((_rubric, rubricIndex) => {
      if (result.scores[rubricIndex] !== 0) return;
      const reason = normalizeFailReason(result.reasons[rubricIndex]);
      summaries.push(`\u7b2c${urlIndex + 1}\u4e2a\u9875\u9762->\u7b2c${rubricIndex + 1}\u6761rubrics->${reason}`);
    });
  });

  return summaries;
}

function getPageFailReason(result: ScoreResult) {
  const technology = result.evidence?.technology;
  if (!technology || typeof technology !== "object") return "";
  const reason = (technology as { pageFailReason?: unknown }).pageFailReason;
  return typeof reason === "string" ? reason.trim() : "";
}

function normalizeFailReason(reason: string | undefined) {
  const value = reason?.trim();
  if (!value || value === "\u4eba\u5de5\u672a\u6807\u8bb0\u7b26\u5408") return "\u672a\u586b\u5199\u539f\u56e0";
  return value;
}

function stripRubricListMarker(value: string) {
  return value.trim().replace(/^\d+\s*(?:[\u3001\u3002\uff0e)\uff09]|\.(?=\s|[^\d]))\s*/, "").trim();
}
