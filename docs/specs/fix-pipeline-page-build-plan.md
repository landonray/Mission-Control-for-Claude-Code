# Build Plan: Fix Pipeline Page

Three self-contained change areas map naturally to three chunks. The CSS fix comes first because Chunk 2 depends on the correct variables being in place for visual review. Chunk 3 (MCP tool) is independent of both UI chunks and can run in any order, but is placed last since the UI fixes are lower risk and easier to verify first.

## Chunk 1: CSS Theme Fix
- Files: client/src/components/ProjectDetail/PipelinesPanel.module.css, client/src/components/ProjectDetail/NewPipelineDialog.module.css
- QA Scenarios: 1.1, 1.2, 1.3, 1.4
- Dependencies: none
- Complexity: small

Replace every `--color-*` CSS variable reference in both files with the correct variables from the app's Retro Surfer palette (defined in `client/src/index.css`).

**`PipelinesPanel.module.css` substitutions:**
- `.panel` background: `var(--color-surface, #fff)` → `var(--bg-secondary)`
- `.panel` border: `var(--color-border, #e2e8f0)` → `var(--border)`
- `.newButton` background: `var(--color-primary, #3b82f6)` → `var(--accent)`; add a `:hover` rule with `background: var(--accent-hover)`
- `.empty` color: `var(--color-text-muted, #64748b)` → `var(--text-muted)`
- `.name` color: `var(--color-primary, #3b82f6)` → `var(--accent)`
- `.status` background: `var(--color-bg-subtle, #f1f5f9)` → `var(--bg-tertiary)`
- `.status` color: `var(--color-text, #0f172a)` → `var(--text-primary)`
- `.stage`, `.created` color: `var(--color-text-muted, #64748b)` → `var(--text-muted)`
- `.row` border-bottom: `var(--color-border-subtle, #f1f5f9)` → `var(--border)`
- `.error` background/color: `#fee2e2` / `#b91c1c` → `rgba(196, 64, 64, 0.1)` / `var(--error)`

Status badge overrides (`.status_running`, `.status_paused_for_approval`, `.status_paused_for_failure`, `.status_completed`) must keep their hardcoded semantic colors — do not change them.

**`NewPipelineDialog.module.css` substitutions:**
- `.dialog` background: `var(--color-surface, #fff)` → `var(--bg-secondary)`
- `.field input`, `.field textarea` border: `var(--color-border, #cbd5e1)` → `var(--border)`; add `background: var(--bg-primary)` and `color: var(--text-primary)` to both
- `.actions button` (cancel): replace `background: white; border: 1px solid var(--color-border, ...)` → `background: transparent; border: 1px solid var(--border); color: var(--text-secondary)`
- `.actions button[type="submit"]`: `var(--color-primary, #3b82f6)` → `var(--accent)`; `border-color` to match; add `:hover` rule with `background: var(--accent-hover)`
- `.error` background/color: `#fee2e2` / `#b91c1c` → `rgba(196, 64, 64, 0.1)` / `var(--error)`

After making these changes, grep both files for `--color-` and confirm zero matches. Run the existing test suite to confirm no regressions — the tests mock the CSS modules via a Proxy so they are not sensitive to variable names, but running them confirms no component-level breakage.

---

## Chunk 2: NewPipelineDialog — File Attachment Feature
- Files: client/src/components/ProjectDetail/NewPipelineDialog.jsx, client/src/components/ProjectDetail/NewPipelineDialog.module.css, client/src/components/ProjectDetail/__tests__/NewPipelineDialog.test.jsx
- QA Scenarios: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 2.11, 4.2, 5.1, 5.2
- Dependencies: Chunk 1
- Complexity: medium

**Component changes — `NewPipelineDialog.jsx`:**

Add two new state variables: `attachedFile` (string — the filename of the attached file, or null) and `attachError` (string — inline error for file type/size failures, or null).

Add a file acceptance helper. A file is accepted if its MIME type starts with `text/` OR its name ends with `.md`, `.txt`, or `.markdown` (case-insensitive). Check both conditions independently; either is sufficient. Do not use only the MIME type — some browsers serve `.markdown` files as `application/octet-stream`.

Below the existing `<label className={styles.field}>` block for the Spec textarea (outside that `<label>` element, to avoid accessibility issues), add:
- A visually styled "Attach a file" button (type="button") that triggers a hidden `<input type="file" accept=".md,.txt,.markdown,text/*">` via a ref.
- An `onChange` handler on the file input:
  1. Clear `attachError`.
  2. If `file.size > 524288` (500 KB): set `attachError` to `"This file is too large to attach directly. Copy and paste the content instead."` and return — do not call FileReader.
  3. If the file fails the acceptance check: set `attachError` to `"Only plain text or markdown files can be attached. Copy and paste content from Word or PDF files."` and return — do not call FileReader.
  4. Otherwise: call `new FileReader()`, `readAsText(file)`. On `onload`: set `specInput` to `event.target.result`; set `attachedFile` to `file.name`.
- If `attachedFile` is non-null, render an attachment indicator: `"📎 {attachedFile} attached"` with an × button. The × button sets `attachedFile` to null — it does NOT clear `specInput`.
- If `attachError` is non-null, render an inline error message below the file input.

The submit gating (`canSubmit`) and the `handleSubmit` function are unchanged — the file content is already in `specInput` by submit time.

**CSS additions — `NewPipelineDialog.module.css`:**

Add new rules for the file attachment UI elements (`.attachButton`, `.attachmentIndicator`, `.attachError`). Style them to be visually consistent with the rest of the dialog — use `var(--text-muted)`, `var(--border)`, `var(--error)`, etc.

**Test updates — `NewPipelineDialog.test.jsx`:**

The existing tests mock the CSS module and use `getByLabelText(/spec/i)` — verify these still work after the JSX changes (the spec `<label>` structure should not change).

Add new test cases covering all QA scenarios 2.1–2.10:
- Mock `FileReader` globally (assign a class mock to `window.FileReader` in the test) that captures the `onload` callback and lets tests trigger it synchronously.
- For each acceptance/rejection test, create a synthetic `File` object with the appropriate `name`, `type`, and `size` properties, then fire a `change` event on the hidden file input.
- Assert on textarea value, indicator text, × button presence, and error message text as specified in the QA plan.
- QA 2.9 (submit gating): verify the submit button is disabled with name empty, spec empty, and both empty; enabled when both are non-empty. The file attachment path (attach a file → name is filled → button enables) should also be tested.
- QA 2.10 (no file upload): spy on `mockApi.post` and confirm it is called with `spec_input` equal to the textarea string, not a File object or FormData.

---

## Chunk 3: MCP Tool — `spec_file` Parameter
- Files: server/services/mcpTools.js, server/services/__tests__/mcpTools.pipeline.test.js
- QA Scenarios: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11, 4.1, 5.3
- Dependencies: none
- Complexity: medium

**`startPipelineTool` function — `mcpTools.js`:**

Replace the current validation block (which requires `spec`) with new mutual-exclusion logic:

1. If both `args.spec` and `args.spec_file` are provided: throw `"Provide either spec or spec_file, not both."`
2. If neither is provided: throw `"spec or spec_file is required."`
3. If `args.spec_file` is provided:
   a. Fetch the project's `root_path` from the database: `SELECT root_path FROM projects WHERE id = $1`.
   b. Resolve the full path using **`path.resolve(root_path, spec_file)`** — NOT `path.join`. Using `path.resolve` is required because it treats an absolute second argument (e.g. `/etc/passwd`) as the new root, which causes the traversal check to correctly reject it. With `path.join`, an absolute input like `/etc/passwd` would produce `root_path + '/etc/passwd'` and silently pass the check.
   c. Security check: `if (!resolvedPath.startsWith(root_path + '/'))` → throw `"spec_file must be within the project directory."`
   d. If `!fs.existsSync(resolvedPath)`: throw `"spec_file not found: ${args.spec_file}"` (use the original `spec_file` value in the message, not the resolved path).
   e. `specInput = fs.readFileSync(resolvedPath, 'utf8')` — allow empty string through; the orchestrator layer validates non-empty.
4. If `args.spec` is provided (and `spec_file` is not): `specInput = args.spec` (existing behavior).

Remove the inline `assertProjectExists` call that currently runs before `createAndStart` — it is now subsumed by the `root_path` lookup in step 3. For the `args.spec` path (step 4), keep the `assertProjectExists` call to preserve the "Project not found" error for the existing code path.

**`TOOL_DEFINITIONS` — `mc_start_pipeline` entry:**

In `inputSchema.properties`, add:
```
spec_file: {
  type: "string",
  description: "Project-relative path to a plain text or markdown file to use as the spec (e.g. 'docs/specs/my-feature.md'). Provide either spec or spec_file, not both."
}
```

Change `required` from `['project_id', 'name', 'spec']` to `['project_id', 'name']`.

Update the tool's `description` to mention that `spec_file` can be used instead of `spec` when the spec already exists as a file in the project.

Mark `spec` description as "Raw spec text. Provide either this or spec_file, not both."

**Test updates — `mcpTools.pipeline.test.js`:**

The existing test `'errors without spec'` asserts `rejects.toThrow(/spec is required/i)`. Update it to assert `rejects.toThrow(/spec or spec_file is required/i)`.

The existing `TOOL_DEFINITIONS` test only checks that the four pipeline tool names are registered — it does not assert on the `required` array, so it should not need changes. But add a new test that verifies `required` is `['project_id', 'name']` and that both `spec` and `spec_file` appear in `properties`.

Add new integration-style tests (mock `fs.readFileSync`, `fs.existsSync`, and the DB `query` for `root_path`):
- Happy path with `spec_file`: mock returns a `root_path`, `existsSync` returns true, `readFileSync` returns `"file content"` → verify `createAndStart` is called with `specInput: "file content"`.
- Both `spec` and `spec_file` provided → error "Provide either spec or spec_file, not both."
- Neither provided → error "spec or spec_file is required."
- Directory traversal via `../../../etc/passwd` → error "spec_file must be within the project directory."
- Prefix collision (`/projects/myapp-evil/secret.md` with `root_path = '/projects/myapp'`) → traversal error.
- Absolute path input (`/etc/passwd`) → traversal error (this only works correctly if `path.resolve` is used — the test implicitly verifies the correct function is used).
- File not found → error `"spec_file not found: docs/nonexistent.md"`.
- Empty file → `createAndStart` called with `specInput: ""` (no error at tool layer).

Run the full server test suite after changes to confirm no regressions in other pipeline or MCP tool tests.
