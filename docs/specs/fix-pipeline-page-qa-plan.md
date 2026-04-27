# QA Plan: Fix Pipeline Page

**Spec:** `docs/specs/fix-pipeline-page-refined.md`  
**Date:** 2026-04-27

---

## Overview

This plan covers three change areas:

1. **Theme fix** — `PipelinesPanel.module.css` and `NewPipelineDialog.module.css` updated to use correct CSS variables
2. **Spec file attachment in the dialog** — client-side file picker that pre-populates the spec textarea
3. **`spec_file` parameter in the `mc_start_pipeline` MCP tool** — server-side file reading with path validation

---

## 1. Theme Fix

### 1.1 PipelinesPanel renders with theme-correct variables

**Approach:** Unit test (Vitest + jsdom) + manual verification  
**Preconditions:** `PipelinesPanel` renders in a jsdom environment with CSS module proxy  
**Acceptance criteria:**

- `.panel` uses `var(--bg-secondary)` for background and `var(--border)` for border — no `--color-surface` or `--color-border` references
- `.newButton` uses `var(--accent)` for background with `var(--accent-hover)` hover state — no `--color-primary`
- `.empty` uses `var(--text-muted)` — no `--color-text-muted`
- `.name` uses `var(--accent)` — no `--color-primary`
- `.status` uses `var(--bg-tertiary)` background and `var(--text-primary)` color — no `--color-bg-subtle` or `--color-text`
- `.stage`, `.created` use `var(--text-muted)` — no `--color-text-muted`
- `.row` uses `var(--border)` for border-bottom — no `--color-border-subtle`
- `.error` uses `background: rgba(196, 64, 64, 0.1)` and `color: var(--error)`

**Testing approach:** Grep `PipelinesPanel.module.css` for any `--color-` references — there must be zero. Manual visual check: open the project detail page in the browser; the pipeline card should match the sandy/warm tone of the surrounding page.

---

### 1.2 Status badge colors are preserved as hardcoded semantic values

**Approach:** Manual verification  
**Preconditions:** A pipeline in each status state exists (or can be created)  
**Acceptance criteria:**

- `.status_running` renders in blue
- `.status_paused_for_approval` renders in amber
- `.status_failed` renders in red
- `.status_completed` renders in green

**Testing approach:** Grep confirms these rules still use hardcoded color values, not CSS variables. Manual: visually confirm badge colors against the pre-existing design.

---

### 1.3 NewPipelineDialog renders with theme-correct variables

**Approach:** Unit test (Vitest + jsdom) + manual verification  
**Preconditions:** Dialog renders in jsdom  
**Acceptance criteria:**

- `.dialog` uses `var(--bg-secondary)` — no `--color-surface`
- Input and textarea elements use `var(--border)` border, `var(--bg-primary)` background, `var(--text-primary)` color — no `--color-border`
- Cancel button uses `background: transparent`, `border: 1px solid var(--border)`, `color: var(--text-secondary)` — no hardcoded `white`
- Submit button uses `var(--accent)` background with `var(--accent-hover)` hover — no `--color-primary`
- `.error` uses `background: rgba(196, 64, 64, 0.1)` and `color: var(--error)`

**Testing approach:** Grep `NewPipelineDialog.module.css` for any `--color-` references — must be zero. Manual: open the New Pipeline dialog; all elements should look visually consistent with the rest of the page.

---

### 1.4 No regressions in component behavior after retheme

**Approach:** Existing unit tests must continue to pass  
**Preconditions:** Full test suite runs  
**Acceptance criteria:** All pre-existing tests pass; no new failures introduced by CSS changes.

---

## 2. Spec File Attachment in the Dialog

### 2.1 Happy path — valid text file attachment

**Approach:** Unit test (Vitest + jsdom + @testing-library/react)  
**Preconditions:** `NewPipelineDialog` renders; a simulated `.md` or `.txt` file is available  
**Input:** User clicks "Attach a file", selects a `spec.md` file (< 500KB, MIME `text/markdown` or ext `.md`)  
**Expected behavior:**

- FileReader reads the file content as text
- Spec textarea is populated with the file content
- Attachment indicator appears: `"📎 spec.md attached"` with an × button
- Submit button becomes enabled (assuming pipeline name is also filled)

**Testing approach:** Mock `FileReader`, fire a change event on the hidden file input with a synthetic File object; assert textarea value and indicator text.

---

### 2.2 Happy path — `.txt` file accepted

**Approach:** Unit test  
**Input:** File with extension `.txt` and MIME type `text/plain`  
**Expected behavior:** Same as 2.1 — file is read and spec textarea is populated.

---

### 2.3 Clearing the attachment indicator preserves textarea content

**Approach:** Unit test  
**Preconditions:** A file has been attached (textarea is populated, indicator is visible)  
**Input:** User clicks the × button on the attachment indicator  
**Expected behavior:**

- Attachment indicator disappears
- Spec textarea content is **not** cleared — it retains the content from the file
- User can continue editing the textarea

---

### 2.4 Attaching a second file overwrites textarea content

**Approach:** Unit test  
**Preconditions:** A first file has been attached (textarea populated with file 1 content)  
**Input:** User selects a second file  
**Expected behavior:**

- Textarea content is replaced with the second file's content
- Indicator updates to show the second filename

---

### 2.5 User edits textarea after file attachment

**Approach:** Unit test  
**Preconditions:** File has been attached (textarea pre-populated)  
**Input:** User types additional text in the textarea, then submits  
**Expected behavior:** The submitted `spec_input` is whatever is in the textarea at submit time — not the original file content.

---

### 2.6 File too large — error shown, no content loaded

**Approach:** Unit test  
**Input:** A file with `size > 524288` bytes (500KB)  
**Expected behavior:**

- Inline error shown: `"This file is too large to attach directly. Copy and paste the content instead."`
- Textarea content is **not** modified
- FileReader is **not** called

---

### 2.7 Non-text file selected — error shown, no content loaded

**Approach:** Unit test  
**Input:** A file with a non-text MIME type (e.g. `application/pdf`) and extension `.pdf`  
**Expected behavior:**

- Inline error shown: `"Only plain text or markdown files can be attached. Copy and paste content from Word or PDF files."`
- Textarea content is **not** modified
- FileReader is **not** called

---

### 2.8 Accepted file types — MIME type and extension matching

**Approach:** Unit test (parameterized cases)  
**Test cases:**

| File | MIME type | Expected |
|---|---|---|
| `spec.md` | `text/markdown` | Accepted |
| `spec.txt` | `text/plain` | Accepted |
| `spec.markdown` | `text/markdown` | Accepted |
| `spec.md` | `application/octet-stream` (extension only) | Accepted |
| `spec.pdf` | `application/pdf` | Rejected |
| `spec.docx` | `application/vnd.openxmlformats-officedocument...` | Rejected |
| `image.png` | `image/png` | Rejected |

**Note for implementation stage:** The spec says "MIME type starts with `text/` OR extension is `.md`, `.txt`, `.markdown`" — both conditions should be tested independently to confirm either is sufficient for acceptance.

---

### 2.9 Submit button gating is unchanged

**Approach:** Unit test  
**Preconditions:** Dialog is open  
**Acceptance criteria:**

- Submit button is disabled when name is empty, even if spec textarea has content (from file attachment or typing)
- Submit button is disabled when spec textarea is empty, even if name is filled
- Submit button is enabled when both name and spec textarea are non-empty
- Attaching a file that populates the textarea + having a name → submit becomes enabled
- Clearing the textarea manually after file attachment → submit becomes disabled again

---

### 2.10 No backend changes — file content submitted as spec_input text

**Approach:** Unit test  
**Preconditions:** Dialog renders with a valid project ID; file has been attached  
**Input:** User fills pipeline name, attaches a file, submits  
**Expected behavior:**

- `api.post('/api/pipelines', ...)` is called with `spec_input` equal to the textarea content (the file's text)
- No file upload or multipart/form-data request is made

---

### 2.11 Accessibility — file input is outside the label element

**Approach:** Manual verification  
**Expected behavior:** The file input (or "Attach a file" button) is rendered outside any `<label>` element so that clicking the label does not trigger the file picker unexpectedly. Screen reader association (if any) uses `aria-label` or `htmlFor`.

---

## 3. MCP Tool — `spec_file` Parameter

### 3.1 Happy path — `spec_file` resolves and pipeline starts

**Approach:** Unit test (Vitest, mocking `fs.readFileSync` and DB calls)  
**Preconditions:** Project exists in DB with `root_path = '/projects/myapp'`; file `docs/specs/feature.md` exists at that path  
**Input:** `{ project_id: 'p1', name: 'My Pipeline', spec_file: 'docs/specs/feature.md' }`  
**Expected behavior:**

- `path.join(root_path, 'docs/specs/feature.md')` is resolved to `/projects/myapp/docs/specs/feature.md`
- Path passes the traversal check (starts with `root_path + '/'`)
- `fs.readFileSync` reads the file as UTF-8
- `orchestrator.createAndStart` is called with `specInput` equal to the file content
- Response includes `pipeline_id`, `name`, `status`, `current_stage`, `branch_name`

---

### 3.2 Happy path — `spec` provided (existing behavior unchanged)

**Approach:** Unit test  
**Input:** `{ project_id: 'p1', name: 'My Pipeline', spec: 'Build feature X' }`  
**Expected behavior:** Existing behavior is preserved — `spec` text is used as `specInput`, no file reading occurs.

---

### 3.3 Error — both `spec` and `spec_file` provided

**Approach:** Unit test  
**Input:** `{ project_id: 'p1', name: 'My Pipeline', spec: 'text', spec_file: 'docs/spec.md' }`  
**Expected behavior:** Throws `"Provide either spec or spec_file, not both."` — pipeline is not started.

---

### 3.4 Error — neither `spec` nor `spec_file` provided

**Approach:** Unit test  
**Input:** `{ project_id: 'p1', name: 'My Pipeline' }`  
**Expected behavior:** Throws `"spec or spec_file is required."` — pipeline is not started.

---

### 3.5 Error — `spec_file` path escapes project root (directory traversal)

**Approach:** Unit test  
**Input:** `{ project_id: 'p1', name: 'My Pipeline', spec_file: '../../../etc/passwd' }`  
**Preconditions:** `root_path = '/projects/myapp'`; resolved path would be `/etc/passwd`  
**Expected behavior:** Throws `"spec_file must be within the project directory."` — `fs.readFileSync` is NOT called.

---

### 3.6 Error — `spec_file` path uses prefix collision

**Approach:** Unit test  
**Input:** `spec_file` resolves to `/projects/myapp-evil/secret.md` (a path that starts with `root_path` string but not `root_path + '/'`)  
**Expected behavior:** Traversal check rejects it — throws `"spec_file must be within the project directory."`.

---

### 3.7 Error — absolute path provided as `spec_file`

**Approach:** Unit test  
**Input:** `spec_file: '/etc/passwd'`  
**Expected behavior:** After joining with `root_path`, the resolved path does not start with `root_path` (or the join produces an unexpected result). Should be caught by traversal check and throw the traversal error.  

**Spec ambiguity:** The spec says "Absolute paths are rejected (they would fail the traversal check)" but does not specify the exact behavior of `path.join(root_path, '/etc/passwd')` — in Node.js, `path.join` does NOT strip leading slashes the way `path.resolve` does. If `path.join` is used, `/etc/passwd` may be concatenated literally rather than treated as absolute. The implementation must use `path.resolve` or normalize before joining to reliably reject absolute paths. **Flag for implementer to confirm and for QA to verify the exact test input.**

---

### 3.8 Error — `spec_file` does not exist

**Approach:** Unit test  
**Input:** `spec_file: 'docs/nonexistent.md'`; file does not exist at resolved path  
**Expected behavior:** Throws `"spec_file not found: docs/nonexistent.md"` — error message includes the original `spec_file` value, not the resolved path.

---

### 3.9 Edge case — `spec_file` exists but is empty

**Approach:** Unit test  
**Input:** `spec_file: 'docs/empty.md'`; file exists with zero bytes  
**Expected behavior:** File is read (empty string), `specInput = ''`, and `orchestrator.createAndStart` is called. The API route (or orchestrator) then validates that `spec_input` is non-empty and rejects it with the appropriate error.  

**Note:** The spec explicitly allows this to pass through the MCP tool layer. QA must verify that (a) the MCP tool does NOT reject the empty file and (b) the pipeline creation fails at the API/orchestrator layer with a meaningful error.

---

### 3.10 Input schema — `spec` is optional; `required` is `['project_id', 'name']`

**Approach:** Unit test against `TOOL_DEFINITIONS`  
**Expected behavior:** The `inputSchema` for `mc_start_pipeline` has `required: ['project_id', 'name']`. `spec` and `spec_file` are both listed under `properties` but neither appears in `required`. The tool description mentions that `spec_file` can be used instead of `spec`.

---

### 3.11 Existing tests pass after schema update

**Approach:** Existing unit/integration tests  
**Expected behavior:** Any test that previously asserted `required: ['project_id', 'name', 'spec']` must be updated to `required: ['project_id', 'name']`. The test must still verify that omitting both `spec` and `spec_file` produces an error.

---

## 4. Security

### 4.1 MCP tool — directory traversal is fully blocked

**Approach:** Unit test (see scenarios 3.5, 3.6, 3.7)  
**Coverage:** Path traversal via `../`, absolute path injection, prefix-collision attacks. All three must be caught before any `fs` call.

### 4.2 Client-side file reading — no file content sent to any unintended endpoint

**Approach:** Manual verification  
**Expected behavior:** Network tab in browser DevTools shows only the existing `POST /api/pipelines` request with the file content as a string in `spec_input` — no additional requests, no multipart uploads, no file content stored elsewhere.

---

## 5. Non-functional / Constraints

### 5.1 No new npm dependencies introduced

**Approach:** Check `package.json` diff  
**Expected behavior:** Neither `client/package.json` nor `server/package.json` has new entries after implementation.

### 5.2 FileReader API used (no polyfills)

**Approach:** Code review  
**Expected behavior:** The dialog uses `new FileReader()` with `readAsText()` — no third-party file-reading libraries.

### 5.3 `fs.readFileSync` used for server-side file reading

**Approach:** Code review  
**Expected behavior:** The MCP tool uses `fs.readFileSync(fullPath, 'utf8')` — consistent with other file reads in the codebase.

---

## 6. Spec Ambiguities That Could Block QA Execution

### Ambiguity A — Absolute path handling in `path.join`

**Where:** Section 3, `spec_file` MCP tool, security check  
**Issue:** The spec says absolute paths "would fail the traversal check," but `path.join('/projects/myapp', '/etc/passwd')` in Node.js produces `/projects/myapp/etc/passwd` — NOT `/etc/passwd` — because `path.join` does not treat the second argument as absolute (unlike `path.resolve`). This means an absolute path input would appear to pass the traversal check while reading the wrong file.  
**Impact:** If the implementation naively uses `path.join`, absolute path injection may not be caught. The traversal check must use `path.resolve` or normalize `spec_file` to strip leading slashes before joining.  
**Resolution needed from implementer:** Confirm which function is used and add an explicit test case for `spec_file: '/etc/passwd'`.

### Ambiguity B — Error message for traversal includes or excludes the path

**Where:** Section 3, scenario 3.5–3.7  
**Issue:** The spec lists the error as `"spec_file must be within the project directory."` but does not say whether the rejected path is included in the message.  
**Impact:** Minor — test should assert the message starts with or contains that phrase rather than doing an exact-match assertion.

### Ambiguity C — `.markdown` extension with `application/octet-stream` MIME type

**Where:** Section 2, file type acceptance  
**Issue:** Browsers may serve `.markdown` files as `application/octet-stream` rather than `text/markdown`. The spec says "MIME type starts with `text/` OR extension is `.md`, `.txt`, `.markdown`" — the extension fallback should cover this, but the implementation must check the extension independently of the MIME type.  
**Impact:** If the implementation only checks MIME type, `.markdown` files from some browsers may be rejected incorrectly.

---

## 7. Acceptance Criteria Summary (Spec → Test Mapping)

| Spec requirement | Covered by scenario(s) |
|---|---|
| All `--color-*` variables removed from PipelinesPanel.module.css | 1.1 |
| All `--color-*` variables removed from NewPipelineDialog.module.css | 1.3 |
| Status badge colors preserved as hardcoded values | 1.2 |
| "Attach a file" button renders in dialog | 2.1 |
| Text/markdown files accepted and populate textarea | 2.1, 2.2, 2.8 |
| Attachment indicator shows filename + × button | 2.1 |
| Clearing indicator preserves textarea content | 2.3 |
| Second file attachment overwrites first | 2.4 |
| Textarea editable after attachment; submit uses final textarea value | 2.5 |
| File > 500KB shows error, does not load | 2.6 |
| Non-text file shows error, does not load | 2.7 |
| Submit gating unchanged | 2.9 |
| File content submitted as spec_input text (no file upload) | 2.10 |
| `spec_file` added to MCP tool inputSchema | 3.10 |
| `spec` made optional in required array | 3.10, 3.11 |
| Both `spec` and `spec_file` → error | 3.3 |
| Neither `spec` nor `spec_file` → error | 3.4 |
| `spec_file` resolves to file → content used as specInput | 3.1 |
| Traversal attempt blocked | 3.5, 3.6, 3.7 |
| Missing file → error with spec_file value in message | 3.8 |
| Empty file → passes tool, fails at orchestrator layer | 3.9 |
| No new dependencies | 5.1 |
| All existing tests pass | 1.4, 3.11 |
