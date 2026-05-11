# AI Rubrics Feishu Sync

Chrome MV3 extension for syncing the selected Feishu/Lark sheet row with AI Rubrics Judge.

## What It Does

1. Finds the currently selected row in Feishu Bitable or online sheet.
2. Reads the task id from `.bitable-card-modal-header-v2-title-content` first, then falls back to the configured task-id field.
3. Calls `GET /api/tasks/:id/sync-summary`.
4. Writes score text into the configured score field.
5. Writes remark text into the configured remark field.
6. If `rubricsModified` is true, writes current rubrics into the configured rubrics field too.

The rubrics field is a rich text `contenteditable` editor like the score and remark fields.

## Install

Open Chrome extensions, enable Developer mode, then load this directory as an unpacked extension:

`chrome-extension/feishu-ai-rubrics-sync`

## Debug Info Needed For Better Selectors

The current version uses generic DOM matching. If it fails, open DevTools Console and search for `[ai-rubrics-sync]`.

For a more stable adapter, provide these DOM snippets:

- selected row wrapper
- task id cell wrapper
- score header cell
- remark header cell
- rubrics header cell
- one normal cell wrapper before edit mode
