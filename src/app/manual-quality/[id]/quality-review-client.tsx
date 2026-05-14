"use client";

import { useEffect, useMemo, useState } from "react";
import type { KeyboardEvent } from "react";
import type { QualityReviewResult, Task } from "@/lib/types";

type ManualQualityReviewClientProps = {
  taskId: string;
  url: string;
};

type QualityReviewDraft = {
  scores: number[];
  reasons: string[];
  answeredCount: number;
  updatedAt?: string;
};

const MANUAL_TARGET_FRAME_ALLOW = [
  "accelerometer *",
  "ambient-light-sensor *",
  "autoplay *",
  "camera *",
  "clipboard-read *",
  "clipboard-write *",
  "compute-pressure *",
  "display-capture *",
  "document-domain *",
  "encrypted-media *",
  "execution-while-not-rendered *",
  "execution-while-out-of-viewport *",
  "fullscreen *",
  "gamepad *",
  "geolocation *",
  "gyroscope *",
  "hid *",
  "identity-credentials-get *",
  "idle-detection *",
  "local-fonts *",
  "magnetometer *",
  "microphone *",
  "midi *",
  "otp-credentials *",
  "payment *",
  "picture-in-picture *",
  "publickey-credentials-get *",
  "screen-wake-lock *",
  "serial *",
  "speaker-selection *",
  "storage-access *",
  "sync-xhr *",
  "usb *",
  "web-share *",
  "window-management *",
  "xr-spatial-tracking *",
].join("; ");

export function ManualQualityReviewClient({ taskId, url }: ManualQualityReviewClientProps) {
  const [task, setTask] = useState<Task | null>(null);
  const [results, setResults] = useState<QualityReviewResult[]>([]);
  const [scores, setScores] = useState<number[]>([]);
  const [reasons, setReasons] = useState<string[]>([]);
  const [answeredCount, setAnsweredCount] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [pendingWrongIndex, setPendingWrongIndex] = useState<number | null>(null);
  const [wrongReason, setWrongReason] = useState("");
  const [lastChoice, setLastChoice] = useState<"correct" | "wrong" | null>(null);
  const [allDoneFlash, setAllDoneFlash] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    async function load() {
      if (!url) return;

      const [taskResponse, resultsResponse] = await Promise.all([
        fetch(`/api/tasks/${taskId}`),
        fetch(`/api/tasks/${taskId}/quality-review-results`),
      ]);
      if (!taskResponse.ok) throw new Error(await taskResponse.text());
      if (!resultsResponse.ok) throw new Error(await resultsResponse.text());

      const nextTask = (await taskResponse.json()) as Task;
      const resultData = (await resultsResponse.json()) as { results: QualityReviewResult[] };
      if (!nextTask.urls.includes(url)) {
        setTask(nextTask);
        setResults(resultData.results);
        setScores([]);
        setReasons([]);
        setAnsweredCount(0);
        setCurrentIndex(0);
        setNotice("当前 URL 不属于这个任务，已停止手工质检。");
        return;
      }
      if (!isQualityReviewConfigured(nextTask)) {
        setTask(nextTask);
        setResults(resultData.results);
        setScores([]);
        setReasons([]);
        setAnsweredCount(0);
        setCurrentIndex(0);
        setNotice("当前任务没有配置质检核对。");
        return;
      }

      const draftResponse = await fetch(`/api/tasks/${taskId}/quality-review-draft?url=${encodeURIComponent(url)}`);
      if (!draftResponse.ok) throw new Error(await draftResponse.text());

      const draftData = (await draftResponse.json()) as { draft: QualityReviewDraft | null };
      const existing = resultData.results.find((result) => result.url === url);
      const draft = draftData.draft;
      const useDraft = Boolean(draft && (!existing || new Date(draft.updatedAt ?? 0).getTime() > new Date(existing.updatedAt).getTime()));
      const nextScores = (useDraft ? draft?.scores : existing?.scores) ?? nextTask.rubrics.map(() => 0);
      const nextReasons = ensureReasonLength((useDraft ? draft?.reasons : existing?.reasons) ?? undefined, nextTask.rubrics.length);
      const nextAnsweredCount = useDraft || !existing ? firstUnansweredIndex(nextReasons, nextTask.rubrics.length) : nextTask.rubrics.length;

      setTask(nextTask);
      setResults(resultData.results);
      setScores(nextScores);
      setReasons(nextReasons);
      setAnsweredCount(nextAnsweredCount);
      setCurrentIndex(Math.min(nextAnsweredCount, nextTask.rubrics.length));
      if (useDraft && !existing && nextTask.rubrics.length > 0 && nextAnsweredCount >= nextTask.rubrics.length) {
        void saveQualityReviewScore(nextScores, nextReasons);
      }
      setNotice(existing && !useDraft ? "已完成" : useDraft ? "已恢复服务端进度" : "");
    }

    load().catch((error) => setNotice(error instanceof Error ? error.message : String(error)));
  }, [taskId, url]);

  const completedCount = useMemo(() => reasons.filter((reason) => reason.trim()).length, [reasons]);
  const scoreSummary = useMemo(() => `进度 ${completedCount}/${scores.length}`, [completedCount, scores.length]);
  const pageSummary = useMemo(() => {
    if (!task) return "";
    const pageIndex = task.urls.findIndex((item) => item === url);
    return pageIndex < 0 ? `第 ?/${task.urls.length} 个页面` : `第 ${pageIndex + 1}/${task.urls.length} 个页面`;
  }, [task, url]);
  const currentRubric = task?.rubrics[currentIndex];
  const isComplete = Boolean(task?.rubrics.length && completedCount >= task.rubrics.length && currentIndex >= task.rubrics.length);
  const nextUrl = task ? findNextUrl(task.urls, url) : null;
  const sourceZipUrl = getSourceZipUrl(url);
  const pageIndex = task?.urls.findIndex((item) => item === url) ?? -1;
  const baselineScores = pageIndex >= 0 ? task?.qualityReviewScoreMatrix[pageIndex] ?? [] : [];
  const baselineReasons = pageIndex >= 0 ? task?.qualityReviewReasonMatrix[pageIndex] ?? [] : [];
  const currentBaselineScore = baselineScores[currentIndex] ?? 0;
  const currentBaselineReason = baselineReasons[currentIndex] ?? "";
  const failReasonSuggestions = useMemo(() => {
    if (!task || pendingWrongIndex !== currentIndex) return [];
    const currentUrlIndex = task.urls.findIndex((item) => item === url);
    if (currentUrlIndex <= 0) return [];

    const uniqueReasons: string[] = [];
    const seen = new Set<string>();
    for (const taskUrl of task.urls.slice(0, currentUrlIndex)) {
      const result = results.find((item) => item.url === taskUrl);
      if (!result) continue;
      const baselineScore = task.qualityReviewScoreMatrix[task.urls.findIndex((item) => item === taskUrl)]?.[currentIndex];
      if (result.scores[currentIndex] === baselineScore) continue;
      const reason = result.reasons[currentIndex]?.trim();
      if (!reason || seen.has(reason)) continue;
      seen.add(reason);
      uniqueReasons.push(reason);
    }
    return uniqueReasons.slice(0, 12);
  }, [currentIndex, pendingWrongIndex, results, task, url]);

  async function saveQualityReviewScore(nextScores: number[], nextReasons: string[]) {
    setSaving(true);
    setNotice("保存中...");
    try {
      const response = await fetch(`/api/tasks/${taskId}/quality-review-score`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, scores: nextScores, reasons: nextReasons }),
      });
      if (!response.ok) throw new Error(await response.text());

      const data = (await response.json()) as { task: Task; results: QualityReviewResult[] };
      setTask(data.task);
      setResults(data.results);
      const nextPageUrl = findNextUrl(data.task.urls, url);
      if (nextPageUrl) {
        setNotice("已完成并保存，打开下一页...");
        window.setTimeout(() => {
          window.location.href = buildManualQualityReviewHref(data.task, nextPageUrl);
        }, 350);
      } else {
        setNotice("恭喜，所有页面质检完成");
        setAllDoneFlash(true);
        window.setTimeout(() => setAllDoneFlash(false), 1800);
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function saveQualityReviewDraft(nextScores: number[], nextReasons: string[], nextAnsweredCount: number) {
    const response = await fetch(`/api/tasks/${taskId}/quality-review-draft`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, scores: nextScores, reasons: nextReasons, answeredCount: nextAnsweredCount }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = (await response.json()) as { draft: QualityReviewDraft };
    return data.draft;
  }

  async function commitAnswer(nextScore: number, nextReason: string, choice: "correct" | "wrong") {
    if (!task || currentIndex >= task.rubrics.length) return;

    const nextScores = scores.map((current, index) => (index === currentIndex ? nextScore : current));
    const nextReasons = reasons.map((current, index) => (index === currentIndex ? nextReason : current));
    const nextAnsweredCount = Math.max(answeredCount, firstUnansweredIndex(nextReasons, task.rubrics.length));
    const nextIndex = firstUnansweredIndex(nextReasons, task.rubrics.length);

    try {
      setSaving(true);
      setLastChoice(choice);
      setNotice("保存中...");

      if (nextIndex >= task.rubrics.length) {
        setScores(nextScores);
        setReasons(nextReasons);
        setAnsweredCount(nextAnsweredCount);
        setCurrentIndex(nextIndex);
        setPendingWrongIndex(null);
        setWrongReason("");
        await saveQualityReviewScore(nextScores, nextReasons);
        return;
      }

      const savedDraft = await saveQualityReviewDraft(nextScores, nextReasons, nextAnsweredCount);
      const savedReasons = ensureReasonLength(savedDraft.reasons, task.rubrics.length);
      const savedIndex = firstUnansweredIndex(savedReasons, task.rubrics.length);
      setScores(savedDraft.scores);
      setReasons(savedReasons);
      setAnsweredCount(savedDraft.answeredCount);
      setCurrentIndex(savedIndex);
      setPendingWrongIndex(null);
      setWrongReason("");
      setNotice(choice === "correct" ? "已记录正确并保存，继续下一条" : "已记录错误原因并保存，继续下一条");
      window.setTimeout(() => setLastChoice(null), 220);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function answerCorrect() {
    void commitAnswer(currentBaselineScore, currentBaselineReason, "correct");
  }

  function answerWrong() {
    setLastChoice("wrong");
    setPendingWrongIndex(currentIndex);
    setWrongReason(reasons[currentIndex] || "");
    setNotice("请填写错误原因");
  }

  function submitWrongReason() {
    const reason = wrongReason.trim();
    if (!reason) {
      setNotice("请填写错误原因");
      return;
    }
    if (pendingWrongIndex !== currentIndex) return;
    void commitAnswer(currentBaselineScore ? 0 : 1, reason, "wrong");
  }

  function cancelWrongReason() {
    setPendingWrongIndex(null);
    setWrongReason("");
    setLastChoice(null);
    setNotice("");
  }

  function jumpToRubric(index: number) {
    if (!task || index < 0 || index >= task.rubrics.length) return;
    setCurrentIndex(index);
    setPendingWrongIndex(null);
    setWrongReason("");
    setLastChoice(null);
    setNotice(`已回到第 ${index + 1} 条`);
  }

  async function restartCheck() {
    if (!task) return;
    const nextScores = task.rubrics.map(() => 0);
    const nextReasons = task.rubrics.map(() => "");
    try {
      setSaving(true);
      await saveQualityReviewDraft(nextScores, nextReasons, 0);
      setScores(nextScores);
      setReasons(nextReasons);
      setAnsweredCount(0);
      setCurrentIndex(0);
      setPendingWrongIndex(null);
      setWrongReason("");
      setNotice("已重置并保存服务端进度");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  function suppressSpaceActivation(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === " " || event.key === "Spacebar") {
      event.preventDefault();
    }
  }

  if (!url) {
    return <main className="manual-page-error">缺少 URL。</main>;
  }

  if (!task) {
    return <main className="manual-page-error">{notice || "加载任务..."}</main>;
  }

  if (!task.urls.includes(url)) {
    return <main className="manual-page-error">当前 URL 不属于任务 {task.id}，已停止手工质检。</main>;
  }

  if (!isQualityReviewConfigured(task)) {
    return <main className="manual-page-error">当前任务没有配置质检核对。</main>;
  }

  return (
    <main className="manual-check-page quality-review-page">
      <aside className={`manual-check-bar quality-review-bar ${pendingWrongIndex === currentIndex ? "with-fail-reason" : ""} ${allDoneFlash ? "all-done-flash" : ""}`}>
        <div className="manual-check-meta">
          <div className="manual-meta-title">
            <a className="manual-source-link" href={url} target="_blank" rel="noreferrer">
              打开原页面
            </a>
            {sourceZipUrl ? (
              <a className="manual-source-link" href={sourceZipUrl} download target="_blank" rel="noreferrer">
                下载源码
              </a>
            ) : null}
          </div>
          {pageSummary ? <em>{pageSummary}</em> : null}
          <span title={taskId}>{taskId}</span>
          <em>{scoreSummary}</em>
          {task.rubrics.length ? (
            <div className="manual-score-dots" aria-label="当前页面质检进度">
              {task.rubrics.map((rubric, index) => {
                const done = Boolean(reasons[index]?.trim());
                const score = scores[index] ? 1 : 0;
                return (
                  <button
                    key={rubric.id}
                    className={["manual-score-dot", done ? (score ? "pass" : "fail") : "todo", currentIndex === index ? "active" : ""].filter(Boolean).join(" ")}
                    onClick={() => jumpToRubric(index)}
                    title={`第 ${index + 1} 条：${done ? score : "未质检"}`}
                    type="button"
                  >
                    {done ? score : ""}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>

        <div className={`manual-rubrics ${pendingWrongIndex === currentIndex ? "with-fail-reason" : ""}`}>
          {currentRubric ? (
            <div className={["manual-rubric-focus", pendingWrongIndex === currentIndex ? "with-reason" : "", "quality-review-focus"].filter(Boolean).join(" ")}>
              <div className="quality-review-content">
                <p>
                  <strong>{currentIndex + 1}.</strong> {currentRubric.description}
                </p>
                <div className="quality-review-baseline">
                  <span>作答人评分：{currentBaselineScore}</span>
                  {currentBaselineScore === 0 ? <span>作答人理由：{currentBaselineReason || "未填写"}</span> : null}
                </div>
              </div>
              {pendingWrongIndex === currentIndex ? (
                <div className="manual-fail-reason">
                  <div className="manual-fail-reason-field">
                    <input
                      autoFocus
                      value={wrongReason}
                      onChange={(event) => setWrongReason(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") submitWrongReason();
                      }}
                      placeholder="错误原因"
                    />
                    {failReasonSuggestions.length ? (
                      <div className="manual-fail-suggestions" role="listbox" aria-label="历史质检理由">
                        {failReasonSuggestions.map((reason) => (
                          <button key={reason} className="manual-fail-suggestion" onClick={() => setWrongReason(reason)} type="button">
                            {reason}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <button className="manual-rubric-toggle fail-choice" onClick={submitWrongReason} disabled={saving} type="button">
                    确认错误
                  </button>
                  <button className="manual-rubric-toggle" onClick={cancelWrongReason} disabled={saving} type="button">
                    取消
                  </button>
                </div>
              ) : (
                <div className="manual-answer-buttons">
                  <button
                    className={`manual-rubric-toggle fail-choice ${lastChoice === "wrong" ? "just-picked" : ""}`}
                    onClick={answerWrong}
                    onKeyDown={suppressSpaceActivation}
                    disabled={saving}
                    type="button"
                  >
                    错误
                  </button>
                  <button
                    className={`manual-rubric-toggle pass-choice ${lastChoice === "correct" ? "just-picked" : ""}`}
                    onClick={answerCorrect}
                    onKeyDown={suppressSpaceActivation}
                    disabled={saving}
                    type="button"
                  >
                    正确
                  </button>
                </div>
              )}
            </div>
          ) : isComplete ? (
            <div className="manual-rubric-focus complete">
              <p>当前页面已质检完成。</p>
              <div className="manual-answer-buttons">
                <button className="manual-rubric-toggle" onClick={() => void restartCheck()} disabled={saving} type="button">
                  重新质检
                </button>
                {nextUrl ? (
                  <button
                    className="manual-rubric-toggle"
                    onClick={() => {
                      window.location.href = buildManualQualityReviewHref(task, nextUrl);
                    }}
                    disabled={saving}
                    type="button"
                  >
                    下一个页面
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <span className="manual-muted">没有 rubrics。</span>
          )}
        </div>
        <div className="manual-check-actions">
          <span>{notice}</span>
          <span>{results.length ? `已完成页面质检：${results.length}/${task.urls.length}` : ""}</span>
        </div>
        {allDoneFlash ? <div className="manual-complete-toast">恭喜，所有页面质检完成</div> : null}
      </aside>

      <iframe allow={MANUAL_TARGET_FRAME_ALLOW} allowFullScreen className="manual-target-frame" src={url} title="manual quality review page" />
    </main>
  );
}

function ensureReasonLength(value: string[] | undefined, count: number) {
  return Array.from({ length: count }, (_item, index) => value?.[index] ?? "");
}

function firstUnansweredIndex(reasons: string[], count: number) {
  const index = reasons.findIndex((reason, reasonIndex) => reasonIndex < count && !reason.trim());
  return index >= 0 ? index : count;
}

function findNextUrl(urls: string[], currentUrl: string) {
  const currentIndex = urls.findIndex((item) => item === currentUrl);
  if (currentIndex < 0) return null;
  return urls[currentIndex + 1] ?? null;
}

function buildManualQualityReviewHref(task: Task, targetUrl: string) {
  const params = new URLSearchParams({ url: targetUrl });
  return `/manual-quality/${encodeURIComponent(task.id)}?${params.toString()}`;
}

function getSourceZipUrl(url: string) {
  try {
    const parsed = new URL(url);
    parsed.pathname = parsed.pathname.replace(/index\.html$/i, "code_files.zip");
    return parsed.pathname.endsWith("code_files.zip") ? parsed.toString() : "";
  } catch {
    return "";
  }
}

function isQualityReviewConfigured(task: Task) {
  return (
    task.qualityReviewEnabled &&
    task.qualityReviewScoreMatrix.length === task.urls.length &&
    task.qualityReviewReasonMatrix.length === task.urls.length &&
    task.qualityReviewScoreMatrix.every((row) => row.length === task.rubrics.length) &&
    task.qualityReviewReasonMatrix.every((row) => row.length === task.rubrics.length)
  );
}
