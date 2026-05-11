const settings = {
  apiBaseUrl: "http://127.0.0.1:3000",
  taskFieldName: "\u4efb\u52a1id",
  scoreFieldName: "\u8bc4\u5206",
  remarkFieldName: "\u5907\u6ce8",
  rubricsFieldName: "rubrics",
};

const taskIdEl = document.getElementById("taskId");
const syncButton = document.getElementById("syncButton");
const statusEl = document.getElementById("status");

init();

async function init() {
  syncButton.addEventListener("click", syncCurrentRecord);
  await refreshTaskId();
}

async function refreshTaskId() {
  try {
    const response = await sendMessageToActiveTab({ type: "AI_RUBRICS_GET_TASK_ID", settings });
    if (!response?.ok || !response.taskId) throw new Error(response?.error || "\u672a\u8bc6\u522b");
    taskIdEl.textContent = response.taskId;
  } catch (error) {
    taskIdEl.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function syncCurrentRecord() {
  setStatus("\u6b63\u5728\u540c\u6b65...", "");
  syncButton.disabled = true;
  try {
    const response = await sendMessageToActiveTab({ type: "AI_RUBRICS_SYNC_RECORD", settings });
    if (!response?.ok) throw new Error(response?.error || "\u540c\u6b65\u5931\u8d25\uff0c\u8bf7\u6253\u5f00\u9875\u9762\u63a7\u5236\u53f0\u67e5\u770b\u8c03\u8bd5\u4fe1\u606f\u3002");
    taskIdEl.textContent = response.taskId;
    setStatus("\u540c\u6b65\u5b8c\u6210", "success");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  } finally {
    syncButton.disabled = false;
  }
}

async function sendMessageToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("\u6ca1\u6709\u627e\u5230\u5f53\u524d\u6807\u7b7e\u9875\u3002");
  try {
    return await chrome.tabs.sendMessage(tab.id, message);
  } catch (error) {
    if (!String(error?.message || error).includes("Receiving end does not exist")) throw error;
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-script.js"],
    });
    return chrome.tabs.sendMessage(tab.id, message);
  }
}

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.className = `status ${kind || ""}`;
}
