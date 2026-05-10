"use client";

import { useEffect, useMemo, useState } from "react";
import type { ScoreResult, Task } from "@/lib/types";

type ManualCheckClientProps = {
  taskId: string;
  url: string;
};

type ManualDraft = {
  scores: number[];
  reasons: string[];
  answeredCount: number;
};

export function ManualCheckClient({ taskId, url }: ManualCheckClientProps) {
  const [task, setTask] = useState<Task | null>(null);
  const [results, setResults] = useState<ScoreResult[]>([]);
  const [scores, setScores] = useState<number[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [pendingFailIndex, setPendingFailIndex] = useState<number | null>(null);
  const [pendingPageFail, setPendingPageFail] = useState(false);
  const [failReason, setFailReason] = useState("");
  const [pageFailReason, setPageFailReason] = useState("");
  const [lastChoice, setLastChoice] = useState<number | null>(null);
  const [allDoneFlash, setAllDoneFlash] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    async function load() {
      const [taskResponse, resultsResponse] = await Promise.all([
        fetch(`/api/tasks/${taskId}`),
        fetch(`/api/tasks/${taskId}/results`),
      ]);
      if (!taskResponse.ok) throw new Error(await taskResponse.text());
      if (!resultsResponse.ok) throw new Error(await resultsResponse.text());

      const nextTask = (await taskResponse.json()) as Task;
      const resultData = (await resultsResponse.json()) as { results: ScoreResult[] };
      const existing = resultData.results.find((result) => result.url === url);
      const draft = loadDraft(taskId, url, nextTask.rubrics.length);

      setTask(nextTask);
      setResults(resultData.results);
      setScores(existing?.scores ?? draft?.scores ?? nextTask.rubrics.map(() => 0));
      setReasons(ensureReasonLength(existing?.reasons ?? draft?.reasons, nextTask.rubrics.length));
      setAnsweredCount(existing ? nextTask.rubrics.length : draft?.answeredCount ?? 0);
      setNotice(existing ? "已完成" : draft ? "已恢复本地进度" : "");
    }

    load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, [taskId, url]);

  const scoreSummary = useMemo(() => {
    return `进度 ${answeredCount}/${scores.length}`;
  }, [answeredCount, scores.length]);

  const currentRubric = task?.rubrics[answeredCount];
  const isComplete = Boolean(task?.rubrics.length && answeredCount >= task.rubrics.length);
  const nextUrl = task ? findNextUrl(task.urls, url) : null;

  async function saveManualScore(nextScores: number[], nextReasons: string[], nextPageFailReason?: string) {
    setSaving(true);
    setNotice("保存中...");
    try {
      const response = await fetch(`/api/tasks/${taskId}/manual-score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, scores: nextScores, reasons: nextReasons, pageFailReason: nextPageFailReason }),
      });
      if (!response.ok) throw new Error(await response.text());

      const data = (await response.json()) as { task: Task; results: ScoreResult[] };
      setTask(data.task);
      setResults(data.results);
      clearDraft(taskId, url);
      const nextPageUrl = findNextUrl(data.task.urls, url);
      if (nextPageUrl) {
        setNotice("已完成并保存，打开下一页...");
        window.setTimeout(() => {
          window.location.href = `/manual/${encodeURIComponent(taskId)}?url=${encodeURIComponent(nextPageUrl)}`;
        }, 350);
      } else {
        setNotice("恭喜！所有页面检查完成");
        setAllDoneFlash(true);
        window.setTimeout(() => setAllDoneFlash(false), 1800);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function commitAnswer(score: number, reason: string) {
    if (!task || answeredCount >= task.rubrics.length) return;

    const nextScores = scores.map((current, index) => (index === answeredCount ? score : current));
    const nextReasons = reasons.map((current, index) => (index === answeredCount ? reason : current));
    const nextAnsweredCount = answeredCount + 1;

    setLastChoice(score);
    setScores(nextScores);
    setReasons(nextReasons);
    setAnsweredCount(nextAnsweredCount);
    setPendingFailIndex(null);
    setPendingPageFail(false);
    setFailReason("");
    setPageFailReason("");

    if (nextAnsweredCount >= task.rubrics.length) {
      void saveManualScore(nextScores, nextReasons);
      return;
    }

    saveDraft(taskId, url, { scores: nextScores, reasons: nextReasons, answeredCount: nextAnsweredCount });
    setNotice(score ? "已记录，继续下一条" : "已记录原因，继续下一条");
    window.setTimeout(() => setLastChoice(null), 220);
  }

  function answerPass() {
    commitAnswer(1, "人工标记符合");
  }

  function answerFail() {
    if (!task) return;
    setLastChoice(0);
    setPendingFailIndex(answeredCount);
    setFailReason(reasons[answeredCount] || "");
    setNotice("请填写不符合理由");
  }

  function submitFailReason() {
    const reason = failReason.trim();
    if (!reason) {
      setNotice("请填写不符合理由");
      return;
    }
    if (pendingFailIndex !== answeredCount) return;
    commitAnswer(0, reason);
  }

  function answerAllFail() {
    if (!task) return;
    setLastChoice(0);
    setPendingFailIndex(null);
    setPendingPageFail(true);
    setPageFailReason("");
    setNotice("请填写页面全不符合理由");
  }

  function submitPageFailReason() {
    if (!task) return;
    const reason = pageFailReason.trim();
    if (!reason) {
      setNotice("请填写页面全不符合理由");
      return;
    }
    const nextScores = task.rubrics.map(() => 0);
    const nextReasons = task.rubrics.map(() => reason);
    setScores(nextScores);
    setReasons(nextReasons);
    setAnsweredCount(task.rubrics.length);
    setPendingFailIndex(null);
    setPendingPageFail(false);
    setPageFailReason("");
    void saveManualScore(nextScores, nextReasons, reason);
  }

  function cancelFailReason() {
    setPendingFailIndex(null);
    setPendingPageFail(false);
    setFailReason("");
    setPageFailReason("");
    setLastChoice(null);
    setNotice("");
  }

  function restartCheck() {
    if (!task) return;
    clearDraft(taskId, url);
    setScores(task.rubrics.map(() => 0));
    setReasons(task.rubrics.map(() => ""));
    setAnsweredCount(0);
    setPendingFailIndex(null);
    setPendingPageFail(false);
    setFailReason("");
    setPageFailReason("");
    setNotice("");
  }

  if (!url) {
    return <main className="manual-page-error">缺少 URL。</main>;
  }

  return (
    <main className="manual-check-page">
      <aside className={`manual-check-bar ${allDoneFlash ? "all-done-flash" : ""}`}>
        <div className="manual-check-meta">
          <strong>手动检查</strong>
          <span title={url}>{urlTail(url)}</span>
          <em>{scoreSummary}</em>
        </div>

        <div className="manual-rubrics">
          {currentRubric ? (
            <div className={`manual-rubric-focus ${pendingFailIndex === answeredCount || pendingPageFail ? "with-reason" : ""}`}>
              <p>
                {pendingPageFail ? (
                  "当前页面全部不符合"
                ) : (
                  <>
                    <strong>{answeredCount + 1}.</strong> {currentRubric.description}
                  </>
                )}
              </p>
              {pendingPageFail ? (
                <div className="manual-fail-reason">
                  <input
                    autoFocus
                    value={pageFailReason}
                    onChange={(event) => setPageFailReason(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitPageFailReason();
                    }}
                    placeholder="页面全不符合理由"
                  />
                  <button className="manual-rubric-toggle fail-choice" onClick={submitPageFailReason} disabled={saving} type="button">
                    确认
                  </button>
                  <button className="manual-rubric-toggle" onClick={cancelFailReason} disabled={saving} type="button">
                    取消
                  </button>
                </div>
              ) : pendingFailIndex === answeredCount ? (
                <div className="manual-fail-reason">
                  <input
                    autoFocus
                    value={failReason}
                    onChange={(event) => setFailReason(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") submitFailReason();
                    }}
                    placeholder="不符合理由"
                  />
                  <button className="manual-rubric-toggle fail-choice" onClick={submitFailReason} disabled={saving} type="button">
                    确认
                  </button>
                  <button className="manual-rubric-toggle" onClick={cancelFailReason} disabled={saving} type="button">
                    取消
                  </button>
                </div>
              ) : (
                <div className="manual-answer-buttons">
                  <button
                    className={`manual-rubric-toggle fail-choice ${lastChoice === 0 ? "just-picked" : ""}`}
                    onClick={answerFail}
                    disabled={saving}
                    type="button"
                  >
                    不符合
                  </button>
                  <button
                    className={`manual-rubric-toggle pass-choice ${lastChoice === 1 ? "just-picked" : ""}`}
                    onClick={answerPass}
                    disabled={saving}
                    type="button"
                  >
                    符合
                  </button>
                  <button className="manual-rubric-toggle page-fail-choice" onClick={answerAllFail} disabled={saving} type="button">
                    全不符合
                  </button>
                </div>
              )}
            </div>
          ) : isComplete ? (
            <div className="manual-rubric-focus complete">
              <p>当前页面已检查完成。</p>
              <div className="manual-answer-buttons">
                <button className="manual-rubric-toggle" onClick={restartCheck} disabled={saving} type="button">
                  重新检查
                </button>
                {nextUrl ? (
                  <button
                    className="manual-rubric-toggle"
                    onClick={() => {
                      window.location.href = `/manual/${encodeURIComponent(taskId)}?url=${encodeURIComponent(nextUrl)}`;
                    }}
                    disabled={saving}
                    type="button"
                  >
                    下一个页面
                  </button>
                ) : null}
              </div>
            </div>
          ) : task ? (
            <span className="manual-muted">没有 rubrics。</span>
          ) : (
            <span className="manual-muted">加载 rubrics...</span>
          )}
        </div>

        <div className="manual-check-actions">
          <span>{notice}</span>
          <span>{results.length ? `已完成页面检查：${results.length}/${task?.urls.length ?? 0}` : ""}</span>
        </div>
        {allDoneFlash ? <div className="manual-complete-toast">恭喜！所有页面检查完成</div> : null}
      </aside>

      <iframe className="manual-target-frame" src={url} title="manual target page" />
    </main>
  );
}

function draftKey(taskId: string, url: string) {
  return `manual-check:${taskId}:${url}`;
}

function loadDraft(taskId: string, url: string, rubricCount: number): ManualDraft | null {
  try {
    const raw = window.localStorage.getItem(draftKey(taskId, url));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { scores?: unknown; reasons?: unknown; answeredCount?: unknown };
    if (!Array.isArray(parsed.scores) || typeof parsed.answeredCount !== "number") return null;
    if (parsed.scores.length !== rubricCount) return null;
    return {
      scores: parsed.scores.map((score) => (score ? 1 : 0)),
      reasons: ensureReasonLength(Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : undefined, rubricCount),
      answeredCount: Math.min(Math.max(0, parsed.answeredCount), rubricCount),
    };
  } catch {
    return null;
  }
}

function saveDraft(taskId: string, url: string, draft: ManualDraft) {
  window.localStorage.setItem(draftKey(taskId, url), JSON.stringify(draft));
}

function ensureReasonLength(value: string[] | undefined, count: number) {
  return Array.from({ length: count }, (_item, index) => value?.[index] ?? "");
}

function clearDraft(taskId: string, url: string) {
  window.localStorage.removeItem(draftKey(taskId, url));
}

function findNextUrl(urls: string[], currentUrl: string) {
  const currentIndex = urls.findIndex((item) => item === currentUrl);
  if (currentIndex < 0) return null;
  return urls[currentIndex + 1] ?? null;
}

function urlTail(url: string) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.slice(-2).join("/") || parsed.host;
  } catch {
    return url;
  }
}
