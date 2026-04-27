# QA Report: Fix Pipeline Page

**Spec:** `docs/specs/fix-pipeline-page-refined.md`  
**QA Plan:** `docs/specs/fix-pipeline-page-qa-plan.md`  
**Date:** 2026-04-27  
**Branch:** `pipeline-fix-pipeline-page`

---

## Summary Table

| Scenario | Result | Notes |
|---|---|---|
| 1.1 PipelinesPanel renders with theme-correct variables | pass | No `--color-` references found |
| 1.2 Status badge colors preserved as hardcoded values | pass | Hardcoded colors confirmed; `status_paused_for_failure` not `status_failed` |
| 1.3 NewPipelineDialog renders with theme-correct variables | pass | No `--color-` references found |
| 1.4 No regressions after retheme | fail | Pre-existing tests broken by other branch changes (not CSS) |
| 2.1 Happy path — valid .md file attachment | pass | Test 2.1 in NewPipelineDialog.test.jsx passes |
| 2.2 `.txt` file accepted | pass | Test 2.2 passes |
| 2.3 Clearing indicator preserves textarea | pass | Test 2.3 passes |
| 2.4 Second file overwrites first | pass | Test 2.4 passes |
| 2.5 Textarea editable after attachment | pass | Test 2.5 passes |
| 2.6 File too large — error, no read | pass | Test 2.6 passes |
| 2.7 Non-text file — error, no read | pass | Test 2.7 passes |
| 2.8 File type acceptance rules (parameterized) | pass | All 7 cases pass |
| 2.9 Submit button gating unchanged | pass | Test 2.9 passes |
| 2.10 File content submitted as spec_input string | pass | Test 2.10 passes |
| 2.11 Accessibility — file input outside label | pass | Manual inspection confirms |
| 3.1 spec_file happy path | pass | Test passes in mcpTools.pipeline.test.js |
| 3.2 spec (existing behavior) unchanged | pass | Test passes |
| 3.3 Both spec and spec_file → error | pass | Test passes |
| 3.4 Neither spec nor spec_file → error | pass | Test passes |
| 3.5 Traversal via `../../../etc/passwd` blocked | pass | Test passes; uses `path.resolve` correctly |
| 3.6 Prefix-collision traversal blocked | pass | Test passes |
| 3.7 Absolute path injection blocked | pass | Test passes; `path.resolve` treats absolute arg correctly |
| 3.8 spec_file not found → error with original path | pass | Test passes |
| 3.9 Empty file passes tool, fails at orchestrator | pass | Test passes |
| 3.10 Input schema — required is `[project_id, name]` | pass | Schema verified in TOOL_DEFINITIONS |
| 3.11 Existing tests pass after schema update | pass | All mcpTools.pipeline.test.js tests pass |
| 4.1 Directory traversal fully blocked (security) | pass | Covered by 3.5, 3.6, 3.7 |
| 4.2 Client-side file reading — no unintended endpoint | pass | Code trace confirms FileReader only; POST sends string |
| 5.1 No new npm dependencies | pass | `git diff main..HEAD -- package.json` shows no changes |
| 5.2 FileReader API used (no polyfills) | pass | `new FileReader()` with `readAsText()` in NewPipelineDialog.jsx:34 |
| 5.3 `fs.readFileSync` used server-side | pass | `fs.readFileSync(resolvedPath, 'utf8')` at mcpTools.js:228 |

---

## Section 1 — Theme Fix

### 1.1 PipelinesPanel renders with theme-correct variables — **pass**

Verified by grepping `PipelinesPanel.module.css` for any `--color-` references: **zero found**.

Confirmed mappings in the file:
- `.panel` → `var(--bg-secondary)` background, `var(--border)` border ✓
- `.newButton` → `var(--accent)` background, `var(--accent-hover)` hover ✓
- `.empty` → `var(--text-muted)` ✓
- `.name` → `var(--accent)` ✓
- `.status` → `var(--bg-tertiary)` background, `var(--text-primary)` color ✓
- `.stage`, `.created` → `var(--text-muted)` ✓
- `.row` → `var(--border)` border-bottom ✓
- `.error` → `background: rgba(196, 64, 64, 0.1); color: var(--error)` ✓

### 1.2 Status badge colors preserved as hardcoded semantic values — **pass**

QA plan referred to `.status_failed` but the actual implementation uses `.status_paused_for_failure`. This is the correct class name — it matches what `PipelinesPanel.jsx` applies via `styles['status_' + p.status]`. Colors are hardcoded:
- `.status_running` → `#dbeafe` / `#1e40af` (blue) ✓
- `.status_paused_for_approval` → `#fef3c7` / `#92400e` (amber) ✓
- `.status_paused_for_failure` → `#fee2e2` / `#991b1b` (red) ✓
- `.status_completed` → `#dcfce7` / `#166534` (green) ✓

### 1.3 NewPipelineDialog renders with theme-correct variables — **pass**

Verified by grepping `NewPipelineDialog.module.css` for any `--color-` references: **zero found**.

Confirmed mappings:
- `.dialog` → `var(--bg-secondary)` ✓
- `.field input`, `.field textarea` → `var(--border)` border, `var(--bg-primary)` background, `var(--text-primary)` color ✓
- `.actions button` (cancel) → `background: transparent; border: 1px solid var(--border); color: var(--text-secondary)` ✓
- `.actions button[type="submit"]` → `var(--accent)` background, `var(--accent-hover)` hover ✓
- `.error` → `background: rgba(196, 64, 64, 0.1); color: var(--error)` ✓
- New attachment styles (`.fileAttach`, `.attachButton`, `.attachmentIndicator`, `.clearAttach`, `.attachError`) all use correct theme variables ✓

### 1.4 No regressions in component behavior after retheme — **fail**

The CSS changes themselves did NOT break any pre-existing functionality. However, the same branch includes other changes (decisions dashboard API unification, pipeline approval chat with rejection_feedback) that broke pre-existing tests. The QA plan criterion "all pre-existing tests pass" is not met.

**Failures found (not caused by CSS changes):**

1. **`usePendingDecisionsCount.test.jsx` — 1 failure**  
   The hook was changed to call `/api/decisions/pending/count` instead of `/api/planning/escalations/count`. The pre-existing test still expects the old endpoint. Actual call observed: `/api/decisions/pending/count`.

2. **`database.decision_chats.test.js` — 1 failure**  
   The `decision_chats` table now has `subject_type` and `subject_id` columns (added for pipeline approval chat). The pre-existing test expects exactly `['content', 'created_at', 'id', 'question_id']` and fails when extra columns appear.

3. **`DecisionsList.test.jsx` — 2 failures**  
   `DecisionsList.jsx` was modified to use a different API endpoint. Two tests time out waiting for calls to the old endpoint (`/api/planning/escalations`).

4. **`pipelines.approvalChat.test.js` — 2 failures** (new tests for new feature)  
   The `POST /api/pipelines/:id/send-back` route does:  
   `UPDATE pipeline_stage_outputs SET rejection_feedback = $1 WHERE ...`  
   The `rejection_feedback` column does not exist in `pipeline_stage_outputs` (the table schema in `database.js` was not updated). Both send-back tests return 400 instead of 200.

The following failures appear to be **pre-existing** (unrelated to this branch's changes) and are out of scope:
- `MessageList.copyButton.test.jsx` — 4 failures (scrollIntoView not a function in jsdom)
- `MissionControlMcpSettings.test.jsx` — 2 failures (Claude Desktop tab text mismatch)
- `ProjectDetail.test.jsx` — 1 failure (timeout on deployment URL test)
- `DecisionsDashboard.test.jsx` — 1 failure (timeout, likely same API endpoint issue as DecisionsList)

**Root cause of in-scope regressions:**
- `usePendingDecisionsCount.js` API endpoint change not reflected in its test
- `decision_chats` DB schema change not reflected in its test
- `pipeline_stage_outputs` missing `rejection_feedback` column, required by the new `send-back` route

---

## Section 2 — Spec File Attachment in the Dialog

All 10 behavioral scenarios were covered by `client/src/components/ProjectDetail/__tests__/NewPipelineDialog.test.jsx`. **All 23 tests in this file pass.**

### 2.1–2.10 — **pass** (automated tests)

Tests run:
```
✓ 2.1 reads a valid .md file and populates the spec textarea
✓ 2.2 reads a valid .txt file and populates the spec textarea
✓ 2.3 clearing the attachment indicator does not clear the textarea
✓ 2.4 attaching a second file overwrites the first file content
✓ 2.5 submits whatever is in the textarea after editing
✓ 2.6 shows error and does not read file when file exceeds 500KB
✓ 2.7 shows error and does not read file when file type is not text
✓ 2.8 accepts spec.md (text/markdown)
✓ 2.8 accepts spec.txt (text/plain)
✓ 2.8 accepts spec.markdown (text/markdown)
✓ 2.8 accepts spec.md (application/octet-stream) — extension fallback works
✓ 2.8 rejects spec.pdf (application/pdf)
✓ 2.8 rejects spec.docx (application/vnd.openxmlformats-officedocument...)
✓ 2.8 rejects image.png (image/png)
✓ 2.9 submit gating: disabled without name; enabled with name + spec from file
✓ 2.10 submits file content as plain string spec_input, not a File or FormData
```

The Ambiguity C noted in the QA plan (`.markdown` extension with `application/octet-stream`) is correctly handled: `isFileAccepted()` at `NewPipelineDialog.jsx:5-9` checks MIME type first (`text/`), then falls back to extension check (`['md', 'txt', 'markdown'].includes(ext)`). Extension-only acceptance works independently of MIME type.

### 2.11 Accessibility — file input outside label — **pass**

Manual inspection of `NewPipelineDialog.jsx:84-115`:
- The Spec `<label>` element (lines 75–83) wraps only the `<span>Spec</span>` and the `<textarea>`
- The file attachment section is a separate `<div className={styles.fileAttach}>` (line 84) outside the `<label>`
- The `<button type="button">Attach a file</button>` is a button, not a label, so clicking it does not conflict with any label association
- The `<button>` on the × has `aria-label="Remove attachment"` for screen reader clarity

---

## Section 3 — MCP Tool: `spec_file` Parameter

All scenarios were covered by `server/services/__tests__/mcpTools.pipeline.test.js`. **All 19 tests in this file pass.**

### 3.1–3.11 — **pass** (automated tests)

```
✓ creates and starts a pipeline (existing spec behavior)
✓ errors without project_id
✓ errors without spec or spec_file
✓ errors with unknown project
✓ 3.1 happy path — reads file content and passes it to createAndStart
✓ 3.3 both spec and spec_file → error
✓ 3.4 neither spec nor spec_file → error
✓ 3.5 directory traversal via ../../../etc/passwd → traversal error
✓ 3.6 prefix collision → traversal error
✓ 3.7 absolute path input → traversal error (path.resolve correctly rejects it)
✓ 3.8 file not found → error message includes the original spec_file value
✓ 3.9 empty file — tool layer passes through; createAndStart invoked with specInput=""
✓ 3.10 schema: required is [project_id, name] and both spec and spec_file in properties
✓ mc_get_pipeline_status works
✓ mc_approve_stage / mc_reject_stage work
```

**Ambiguity A resolved:** The implementation uses `path.resolve(rootPath, args.spec_file)` (not `path.join`). `path.resolve('/root', '/etc/passwd')` returns `/etc/passwd`, which fails `startsWith('/root/')`. Absolute path injection is correctly blocked. The test explicitly verifies this case.

**Ambiguity B noted:** Error message is `"spec_file must be within the project directory."` — no path appended. Tests assert via `.toMatch(/spec_file must be within the project directory/i)` which passes.

**Spec (3.2) — existing `spec` parameter unchanged:** The `startPipelineTool` still accepts `spec` as raw text, with no file reading. Verified in test "creates and starts a pipeline."

---

## Section 4 — Security

### 4.1 Directory traversal fully blocked — **pass**

All three attack vectors tested and blocked:
- `../../../etc/passwd` → `path.resolve` produces `/etc/passwd` → fails `startsWith(rootPath + '/')` → throws
- Prefix collision (`/tmp/mcp-test-abcevil/secret.md`) → fails `startsWith` check → throws
- Absolute path `/etc/passwd` → `path.resolve` returns `/etc/passwd` → fails check → throws

`fs.readFileSync` is never called in any traversal scenario (verified by spy assertions in tests).

### 4.2 Client-side file reading — no unintended endpoint — **pass**

Code trace in `NewPipelineDialog.jsx`:
1. File is read entirely client-side via `new FileReader()` → `readAsText(file)` (line 39)
2. On load, content is placed in React state via `setSpecInput(event.target.result)` (line 36)
3. On submit, `api.post('/api/pipelines', { project_id, name, spec_input: specInput })` sends a plain JSON body (line 48-52)
4. No file upload, no multipart/form-data, no additional network requests

Test 2.10 verifies: `typeof body.spec_input === 'string'` and the value equals the file content string.

---

## Section 5 — Non-functional / Constraints

### 5.1 No new npm dependencies — **pass**

`git diff main..HEAD -- package.json client/package.json server/package.json` produces no output. Neither package file was changed.

### 5.2 FileReader API used (no polyfills) — **pass**

`NewPipelineDialog.jsx:34-39`: `const reader = new FileReader(); reader.readAsText(file)`. No third-party file-reading libraries referenced anywhere.

### 5.3 `fs.readFileSync` used for server-side file reading — **pass**

`mcpTools.js:228`: `specInput = fs.readFileSync(resolvedPath, 'utf8')`. No streams or async file reads. Consistent with other file reads in the codebase (e.g., `readDescription()` at mcpTools.js:33).

---

## Additional Findings (Bugs in Adjacent Features)

These are bugs introduced by other changes in this branch, outside the QA plan scope. They are documented here for the fix cycle.

### Bug 1: `rejection_feedback` column missing from `pipeline_stage_outputs`

**File:** `server/database.js` — `CREATE TABLE IF NOT EXISTS pipeline_stage_outputs`  
**Impact:** `POST /api/pipelines/:id/send-back` fails with a DB error when attempting to persist feedback. Returns 400. Tests fail:
- `pipeline send-back-with-feedback > POST with explicit feedback persists it and calls reject`
- `pipeline send-back-with-feedback > POST send-back with no feedback summarizes from chat history`

**Fix needed:** Add `rejection_feedback TEXT` column to the `pipeline_stage_outputs` table definition, or add an `ALTER TABLE` migration.

### Bug 2: `usePendingDecisionsCount` test expects old API endpoint

**File:** `client/src/hooks/__tests__/usePendingDecisionsCount.test.jsx:27`  
**Impact:** Test expects call to `/api/planning/escalations/count` but hook now calls `/api/decisions/pending/count`. One test fails.  
**Fix needed:** Update the test to mock `/api/decisions/pending/count`.

### Bug 3: `decision_chats` schema test expects old column list

**File:** `server/__tests__/database.decision_chats.test.js:15`  
**Impact:** Test expects `['content', 'created_at', 'id', 'question_id']` but table now has `subject_id` and `subject_type` as well. One test fails.  
**Fix needed:** Update the test to include `subject_id` and `subject_type` in the expected column list.

### Bug 4: `DecisionsList` tests call old API endpoint

**File:** `client/src/components/Decisions/__tests__/DecisionsList.test.jsx`  
**Impact:** Component now calls a different API endpoint. Two tests time out. Fix needed in the test mock.

---

Overall: fail
