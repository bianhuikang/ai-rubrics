if (!globalThis.__AI_RUBRICS_SYNC_LISTENER__) {
  globalThis.__AI_RUBRICS_SYNC_LISTENER__ = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "AI_RUBRICS_GET_TASK_ID") {
      Promise.resolve()
        .then(() => getCurrentTaskId(message.settings))
        .then((taskId) => sendResponse({ ok: true, taskId }))
        .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      return true;
    }

    if (message?.type !== "AI_RUBRICS_SYNC_RECORD") return false;
    syncRecord(message.settings)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => {
        console.warn("[ai-rubrics-sync] sync failed", error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });
    return true;
  });
}

const FIELD_ID_BY_NAME = new Map([
  ["rubrics", "fldRoIVLrj"],
  ["\u8bc4\u5206", "fldw5fV0zW"],
  ["\u5907\u6ce8", "fld78Lhbjz"],
]);

function getCurrentTaskId(settings) {
  const selected = findSelectedRecord();
  const record = selected.record;
  if (!record) throw new Error("\u672a\u627e\u5230\u8bb0\u5f55");
  const taskId = findTaskId(record, settings.taskFieldName);
  if (!taskId) throw new Error("\u672a\u8bc6\u522b\u4efb\u52a1 ID");
  return taskId;
}

async function syncRecord(settings) {
  const selected = findSelectedRecord();
  const record = selected.record;
  if (!record) {
    dumpDebug("selected row not found", { selected });
    throw new Error("\u6ca1\u6709\u627e\u5230\u5f53\u524d\u9009\u4e2d\u7684\u8bb0\u5f55\u6216\u98de\u4e66\u8bb0\u5f55\u5361\u7247\u3002\u8bf7\u5148\u70b9\u4e00\u4e0b\u76ee\u6807\u8bb0\u5f55\u3002");
  }

  const taskId = findTaskId(record, settings.taskFieldName);
  if (!taskId) {
    dumpDebug("task id not found", { recordText: getText(record), selected });
    throw new Error(`\u6ca1\u6709\u4ece\u5f53\u524d\u8bb0\u5f55\u91cc\u8bc6\u522b\u5230\u4efb\u52a1 ID\u3002\u8bf7\u786e\u8ba4\u5b57\u6bb5\u540d\u662f\u201c${settings.taskFieldName}\u201d\u3002`);
  }

  const summary = await fetchSummary(settings.apiBaseUrl, taskId);
  await fillField(record, settings.scoreFieldName, summary.scoreText);
  await fillField(record, settings.remarkFieldName, summary.remarkText || "");

  if (summary.rubricsModified) {
    await fillField(record, settings.rubricsFieldName || "rubrics", summary.rubricsText || "");
  }

  return summary;
}

async function fetchSummary(apiBaseUrl, taskId) {
  const baseUrl = String(apiBaseUrl || "").replace(/\/+$/, "");
  const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/sync-summary`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `\u8bfb\u53d6\u4efb\u52a1 ${taskId} \u5931\u8d25\u3002`);
  return data;
}

function findSelectedRecord() {
  const selection = window.getSelection();
  const selectionElement = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
  const active = document.activeElement instanceof Element ? document.activeElement : null;
  const card = findOpenCard();
  const selectedCell =
    closestCell(selectionElement) ||
    closestCell(active) ||
    queryFirstVisible([
      '[aria-selected="true"]',
      '[data-selected="true"]',
      '[class*="selected"]',
      '[class*="Selected"]',
      '[class*="active"]',
      '[class*="Active"]',
    ]);
  const row = closestRow(selectedCell) || closestRow(selectionElement) || closestRow(active);
  return { record: card || row, card, row, selectedCell, selectionText: selection?.toString() || "" };
}

function findTaskId(record, taskFieldName) {
  const titleText = getCardTitleText();
  const fieldCell = findFieldCell(record, taskFieldName);
  const texts = [titleText, fieldCell && getText(fieldCell), getText(record), window.getSelection()?.toString()].filter(Boolean);
  for (const text of texts) {
    const labeled = text.match(new RegExp(`${escapeRegExp(taskFieldName)}\\s*[:\\uff1a]?\\s*([A-Za-z0-9][A-Za-z0-9_-]{1,80})`, "i"));
    if (labeled) return labeled[1];
  }
  for (const text of texts) {
    const generic = text.match(/\b[A-Za-z0-9][A-Za-z0-9_-]{2,80}\b/);
    if (generic) return generic[0];
  }
  return "";
}

async function fillField(record, fieldName, value) {
  const target = findFieldCell(record, fieldName);
  if (!target) {
    dumpDebug("field cell not found", { fieldName, recordText: getText(record), headers: findHeaders().map((item) => item.text) });
    throw new Error(`\u6ca1\u6709\u627e\u5230\u201c${fieldName}\u201d\u5b57\u6bb5\u5bf9\u5e94\u7684\u5355\u5143\u683c\u3002`);
  }

  target.scrollIntoView({ block: "center", inline: "center" });
  await delay(80);
  clickElement(target);
  await delay(120);
  clickElement(target);
  const editor = await waitForEditorIn(target);
  await clearEditorText(editor);
  await delay(fieldName === "rubrics" ? 220 : 80);
  if (fieldName === "rubrics") {
    await resetEditorFocus(editor);
    replaceEditorContent(editor, value);
    commitEditorText(editor);
    await delay(160);
    editor.blur();
    await delay(120);
    return;
  }
  setEditorText(editor, value);
  commitEditorText(editor);
  await delay(160);
  editor.blur();
  await delay(120);
}

function findFieldCell(record, fieldName) {
  const cardField = findCardFieldTarget(record, fieldName);
  if (cardField) return cardField;

  const headers = findHeaders();
  const header = headers.find((item) => normalizeText(item.text).includes(normalizeText(fieldName)));
  if (!header) return null;

  const rowCells = findRowCells(record);
  const byIndex = Number.isInteger(header.index) ? rowCells[header.index] : null;
  if (byIndex) return byIndex;

  const headerRect = header.element.getBoundingClientRect();
  return (
    rowCells.find((cell) => {
      const rect = cell.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      return centerX >= headerRect.left - 4 && centerX <= headerRect.right + 4;
    }) || null
  );
}

function findOpenCard() {
  const title = queryFirstVisible([".bitable-card-modal-header-v2-title-content"]);
  if (!title) return null;
  let current = title.parentElement;
  while (current && current !== document.body) {
    const rect = current.getBoundingClientRect();
    if (rect.width >= 320 && rect.height >= 240 && getText(current).includes(getText(title))) return current;
    current = current.parentElement;
  }
  return title.closest?.('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="drawer"], [class*="Drawer"]') || null;
}

function getCardTitleText() {
  const title = queryFirstVisible([".bitable-card-modal-header-v2-title-content"]);
  return title ? getText(title) : "";
}

function findCardFieldTarget(record, fieldName) {
  if (!record || !findOpenCard()) return null;
  const labeledEditor = findFeishuCardLabelEditor(record, fieldName);
  if (labeledEditor) return labeledEditor;

  const normalizedName = normalizeText(fieldName);
  const elements = findFieldLabelElements(record, normalizedName);

  for (const label of elements) {
    const editor = findNearestEditorForLabel(record, label);
    if (editor) return editor;

    const fieldRoot = closestFieldRoot(label);
    if (!fieldRoot) continue;
    const clickTarget = Array.from(fieldRoot.children)
      .reverse()
      .find((element) => element !== label && isVisible(element));
    if (clickTarget) return clickTarget;
    return fieldRoot;
  }

  return null;
}

function findFeishuCardLabelEditor(record, fieldName) {
  const normalizedName = normalizeText(fieldName);
  const labels = Array.from(record.querySelectorAll("label.b-field-label, .b-field-label")).filter(isVisible);
  const knownFieldId = FIELD_ID_BY_NAME.get(fieldName) || FIELD_ID_BY_NAME.get(normalizedName);
  if (knownFieldId) {
    const label = labels.find((item) => item.getAttribute("data-field-id") === knownFieldId);
    const editor = label ? resolveEditable(label) || findEditorIn(label) : null;
    if (editor) {
      dumpDebug("field matched by field id", { fieldName, fieldId: knownFieldId });
      return editor;
    }
  }

  for (const label of labels) {
    const name = label.querySelector(".bitable-field-name, .b-field-label__title");
    const nameText = normalizeText(getText(name || label));
    const directNameText = normalizeText(getDirectText(name || label));
    if (nameText !== normalizedName && directNameText !== normalizedName) continue;
    const editor = resolveEditable(label) || findEditorIn(label);
    if (editor) {
      dumpDebug("field matched by feishu label", {
        fieldName,
        fieldId: label.getAttribute("data-field-id") || "",
      });
      return editor;
    }
  }
  return null;
}

function findFieldLabelElements(record, normalizedName) {
  const elements = Array.from(record.querySelectorAll("*")).filter(isVisible);
  const exact = elements.filter((element) => {
    const directText = normalizeText(getDirectText(element));
    const ariaLabel = normalizeText(element.getAttribute("aria-label") || "");
    const title = normalizeText(element.getAttribute("title") || "");
    return directText === normalizedName || ariaLabel === normalizedName || title === normalizedName;
  });
  if (exact.length) return exact;

  dumpDebug("field label not found", {
    fieldName: normalizedName,
    visibleLabels: elements.map((element) => getDirectText(element)).filter(Boolean).slice(0, 80),
  });
  return [];
}

function findNearestEditorForLabel(record, label) {
  const labelRect = label.getBoundingClientRect();
  const editors = findEditors(record).filter((editor) => !editor.contains(label) && !label.contains(editor));
  const scored = editors
    .map((editor) => {
      const rect = editor.getBoundingClientRect();
      const sameRow = rect.bottom >= labelRect.top - 8 && rect.top <= labelRect.bottom + 24;
      const below = rect.top >= labelRect.top - 8;
      const verticalDistance = Math.max(0, rect.top - labelRect.bottom);
      const horizontalDistance = Math.max(0, rect.left - labelRect.right);
      return {
        editor,
        score: (sameRow ? 0 : below ? 1000 : 10000) + verticalDistance * 10 + horizontalDistance,
      };
    })
    .sort((a, b) => a.score - b.score);
  return scored[0]?.editor || null;
}

function findEditorIn(root) {
  return findEditors(root)[0] || null;
}

function findEditors(root) {
  const selectors = [
    ".editor-component",
    '.bitable-text-editor-content[contenteditable="true"]',
    '[data-slate-editor="true"][contenteditable="true"]',
    '[contenteditable="true"]',
  ];
  return Array.from(root.querySelectorAll(selectors.join(","))).filter(isVisible);
}

function closestFieldRoot(label) {
  let current = label.parentElement;
  for (let depth = 0; current && depth < 8; depth += 1) {
    const text = getText(current);
    const rect = current.getBoundingClientRect();
    if (findEditorIn(current) && rect.width > 120 && rect.height > 24) return current;
    if (text.length > getText(label).length && rect.width > 120 && rect.height > 48) return current;
    current = current.parentElement;
  }
  return label.parentElement;
}

function findHeaders() {
  const selectors = [
    '[role="columnheader"]',
    '[data-testid*="field"]',
    '[class*="field"]',
    '[class*="Field"]',
    '[class*="header"]',
    '[class*="Header"]',
  ];
  const candidates = Array.from(document.querySelectorAll(selectors.join(",")))
    .filter(isVisible)
    .map((element) => ({ element, text: getText(element) }))
    .filter((item) => item.text && item.element.getBoundingClientRect().width > 20);

  return candidates.map((item) => ({
    ...item,
    index: inferIndex(item.element, candidates.map((candidate) => candidate.element)),
  }));
}

function findRowCells(row) {
  const cells = Array.from(
    row.querySelectorAll(
      [
        '[role="gridcell"]',
        '[data-cell-id]',
        '[data-col-index]',
        '[class*="cell"]',
        '[class*="Cell"]',
      ].join(","),
    ),
  ).filter(isVisible);
  if (cells.length) return uniqueByElement(cells);
  return Array.from(row.children).filter(isVisible);
}

function closestCell(element) {
  return element?.closest?.('[role="gridcell"], [data-cell-id], [data-col-index], [class*="cell"], [class*="Cell"]') || null;
}

function closestRow(element) {
  return element?.closest?.('[role="row"], [data-row-id], [data-row-index], [class*="row"], [class*="Row"]') || null;
}

function queryFirstVisible(selectors) {
  for (const selector of selectors) {
    const found = Array.from(document.querySelectorAll(selector)).find(isVisible);
    if (found) return found;
  }
  return null;
}

async function waitForEditorIn(target) {
  for (let index = 0; index < 20; index += 1) {
    const editor = resolveEditable(target);
    if (editor) return editor;
    await delay(100);
  }
  throw new Error("\u5355\u5143\u683c\u7f16\u8f91\u5668\u6ca1\u6709\u6253\u5f00\u3002\u8bf7\u63d0\u4f9b\u5355\u5143\u683c\u5916\u5c42 DOM\uff0c\u6211\u6765\u8865\u7cbe\u51c6\u5b9a\u4f4d\u3002");
}

function setEditorText(editor, text) {
  editor.focus();
  selectEditorContents(editor);
  editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
  document.execCommand("insertText", false, text);
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

function replaceEditorContent(editor, text) {
  editor.focus();
  editor.innerHTML = "";
  const lines = String(text).split(/\r?\n/);
  const fragment = document.createDocumentFragment();

  for (const line of lines) {
    const lineNode = document.createElement("div");
    lineNode.className = "ace-line";
    lineNode.setAttribute("data-node", "true");
    lineNode.setAttribute("dir", "auto");

    const textSpan = document.createElement("span");
    textSpan.setAttribute("data-string", "true");
    textSpan.setAttribute("data-leaf", "true");
    textSpan.textContent = line || "\u200b";

    const enterSpan = document.createElement("span");
    enterSpan.setAttribute("data-string", "true");
    enterSpan.setAttribute("data-enter", "true");
    enterSpan.setAttribute("data-leaf", "true");
    enterSpan.textContent = "\u200b";

    lineNode.appendChild(textSpan);
    lineNode.appendChild(enterSpan);
    fragment.appendChild(lineNode);
  }

  editor.appendChild(fragment);
  editor.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: text }));
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
}

async function clearEditorText(editor) {
  editor.focus();
  selectEditorContents(editor);
  document.execCommand("delete", false);
  editor.textContent = "";
  editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward", data: null }));
  editor.dispatchEvent(new Event("change", { bubbles: true }));
  await delay(40);
}

async function resetEditorFocus(editor) {
  editor.blur();
  await delay(120);
  editor.focus();
  await delay(80);
}

function commitEditorText(editor) {
  editor.dispatchEvent(new Event("change", { bubbles: true }));
  const container = editor.closest?.(".bitable-text-editor-container, .editor-component, .b-field-label__editor");
  container?.dispatchEvent(new Event("input", { bubbles: true }));
  container?.dispatchEvent(new Event("change", { bubbles: true }));
}

function resolveEditable(target) {
  if (target.matches?.('[contenteditable="true"]')) return target;
  return target.querySelector?.('[data-slate-editor="true"][contenteditable="true"], .bitable-text-editor-content[contenteditable="true"], [contenteditable="true"]') || null;
}

function selectEditorContents(editor) {
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(editor);
  selection.removeAllRanges();
  selection.addRange(range);
}

function clickElement(element) {
  const rect = element.getBoundingClientRect();
  const options = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  element.dispatchEvent(new MouseEvent("mousedown", options));
  element.dispatchEvent(new MouseEvent("mouseup", options));
  element.dispatchEvent(new MouseEvent("click", options));
}

function inferIndex(element, peers) {
  const explicit = element.getAttribute("data-col-index") || element.getAttribute("aria-colindex");
  if (explicit && !Number.isNaN(Number(explicit))) return Math.max(0, Number(explicit) - (element.hasAttribute("aria-colindex") ? 1 : 0));
  const sorted = [...peers].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
  return sorted.indexOf(element);
}

function isVisible(element) {
  if (!(element instanceof Element)) return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
}

function uniqueByElement(elements) {
  return Array.from(new Set(elements));
}

function getText(element) {
  return (element?.innerText || element?.textContent || "").replace(/\u200b/g, "").trim();
}

function getDirectText(element) {
  return Array.from(element?.childNodes || [])
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent || "")
    .join("")
    .replace(/\u200b/g, "")
    .trim();
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, "").toLowerCase();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dumpDebug(message, payload) {
  console.warn("[ai-rubrics-sync]", message, payload);
}
