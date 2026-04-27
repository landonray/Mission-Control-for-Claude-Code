# Refined Spec: Fix Pipeline Page

## Purpose / Problem

Two distinct improvements are needed for the pipeline section of the project detail page:

1. **Visual inconsistency**: The `PipelinesPanel` and `NewPipelineDialog` components use a different CSS variable set (`--color-surface`, `--color-border`, `--color-primary`) that doesn't exist in the app's design system. The rest of the project detail page uses the "Retro Surfer" theme (`--bg-secondary`, `--border`, `--accent`, etc.). The result is a bright white card with a blue button sitting inside a warm sandy page — it looks like a component from a different app entirely.

2. **Spec attachment**: When creating a new pipeline via the UI dialog, users want to attach a spec file rather than always typing or pasting raw text. The same capability should be available via the `mc_start_pipeline` MCP tool using a file path.

---

## Scope

**In scope:**
- Retheme `PipelinesPanel.module.css` and `NewPipelineDialog.module.css` to use the app's correct CSS variables
- Add a file picker to `NewPipelineDialog` that reads text/markdown files client-side and populates the spec textarea
- Add a `spec_file` parameter to the `mc_start_pipeline` MCP tool that accepts a project-relative path to a text file and reads its content server-side

**Out of scope:**
- Binary file parsing (PDF → text, docx → text) — text and markdown files only in this version
- Changes to the pipeline data model (`spec_input` remains a plain-text database column)
- New upload/storage flow — the dialog reads files client-side only; no files are persisted to the uploads directory

---

## Functional Requirements

### 1. Theme Fix

The two CSS modules (`PipelinesPanel.module.css`, `NewPipelineDialog.module.css`) must be updated to use variables from the app's `:root` theme in `client/src/index.css`. Every reference to `--color-*` must be replaced with the correct `--bg-*`, `--text-*`, `--border`, or `--accent` variable.

**`PipelinesPanel.module.css` changes:**
- `.panel` background: `var(--color-surface, #fff)` → `var(--bg-secondary)`
- `.panel` border: `var(--color-border, #e2e8f0)` → `var(--border)`
- `.newButton` background: `var(--color-primary, #3b82f6)` → `var(--accent)`; add hover state `var(--accent-hover)`
- `.empty` color: `var(--color-text-muted, #64748b)` → `var(--text-muted)`
- `.name` color: `var(--color-primary, #3b82f6)` → `var(--accent)`
- `.status` background: `var(--color-bg-subtle, #f1f5f9)` → `var(--bg-tertiary)`
- `.status` color: `var(--color-text, #0f172a)` → `var(--text-primary)`
- `.stage`, `.created` color: `var(--color-text-muted, #64748b)` → `var(--text-muted)`
- `.row` border-bottom: `var(--color-border-subtle, #f1f5f9)` → `var(--border)`
- `.error` background/color: keep semantic red but update to match the app's error style (`background: rgba(196, 64, 64, 0.1); color: var(--error)`)

**`NewPipelineDialog.module.css` changes:**
- `.dialog` background: `var(--color-surface, #fff)` → `var(--bg-secondary)`
- `.field input`, `.field textarea` border: `var(--color-border, #cbd5e1)` → `var(--border)`
- `.field input`, `.field textarea` background: add `var(--bg-primary)` so inputs aren't pure white
- `.field input`, `.field textarea` color: add `var(--text-primary)` explicitly
- `.actions button` (cancel): replace hardcoded `background: white; border: 1px solid var(--color-border)` → match app ghost button style (`background: transparent; border: 1px solid var(--border); color: var(--text-secondary)`)
- `.actions button[type="submit"]` (submit): `var(--color-primary, #3b82f6)` → `var(--accent)`; add hover state `var(--accent-hover)`
- `.error` background/color: update to `background: rgba(196, 64, 64, 0.1); color: var(--error)` to match app error style

**Status badge overrides (`.status_running`, `.status_paused_for_approval`, etc.) in `PipelinesPanel.module.css`:** These use hardcoded semantic colors (blue for running, amber for pending, red for failed, green for completed). Keep them as hardcoded values — these are semantic status indicators and should remain recognizable regardless of theme.

---

### 2. Spec File Attachment in the Dialog

**File: `client/src/components/ProjectDetail/NewPipelineDialog.jsx`**

Add a file attachment option below the Spec textarea:

- Render a "Attach a file" button or styled file input beneath the Spec `<label>` block (outside the `<label>` itself to avoid accessibility issues)
- When a file is selected:
  - If the file's MIME type starts with `text/` or has extension `.md`, `.txt`, `.markdown`: read it client-side using the `FileReader` API (`readAsText`)
  - On successful read: set the spec textarea value to the file's text content
  - Show an indicator near the file input: `"📎 filename.md attached"` with an × button to clear the attachment indicator (clearing the indicator does NOT clear the textarea content, since the user may have edited it)
  - If the file size exceeds 500KB: show an inline error and do not read the file — "This file is too large to attach directly. Copy and paste the content instead."
  - If the file is not a readable text type (e.g. PDF, docx, binary): show an inline error — "Only plain text or markdown files can be attached. Copy and paste content from Word or PDF files."
- The spec textarea remains fully editable after attachment — attaching a file just pre-populates it
- The "Start Pipeline" submit button gating remains unchanged: enabled only when name is non-empty AND spec textarea has non-empty content

**No backend changes** are needed for this path. The file content is read client-side and sent as `spec_input` text, exactly as if the user had typed it.

---

### 3. Spec File in the MCP Tool

**File: `server/services/mcpTools.js`**

Update `startPipelineTool` and the `mc_start_pipeline` entry in `TOOL_DEFINITIONS`:

**New parameter:** Add optional `spec_file` to the tool's `inputSchema`:
```
spec_file: {
  type: "string",
  description: "Project-relative path to a plain text or markdown file to use as the spec (e.g. 'docs/specs/my-feature.md'). Provide either spec or spec_file, not both."
}
```

**Logic in `startPipelineTool`:**
1. If both `spec` and `spec_file` are provided → throw `"Provide either spec or spec_file, not both."`
2. If neither `spec` nor `spec_file` is provided → throw `"spec or spec_file is required."`
3. If `spec_file` is provided:
   - Get the project's `root_path` from the database
   - Resolve the full path: `path.join(root_path, spec_file)`
   - Security check: confirm the resolved path starts with `root_path` (prevent directory traversal)
   - If file doesn't exist → throw `"spec_file not found: <spec_file>"`
   - Read file with `fs.readFileSync(fullPath, 'utf8')`
   - Use the file content as `specInput`
4. If `spec` is provided (and `spec_file` is not): use `spec` as `specInput` (existing behavior)

**Update `inputSchema`:** Make `spec` optional (remove from `required`). Required array should be `['project_id', 'name']` — the handler validates that exactly one of `spec`/`spec_file` is provided.

**Update `mc_start_pipeline` description:** Add a sentence noting that `spec_file` can be used instead of `spec` when the spec already exists as a file in the project.

**File: `server/routes/pipelines.js`** — no changes needed. The HTTP route passes `spec_input` as text; the MCP tool resolves the file before calling `orchestrator.createAndStart`.

---

## Non-functional Constraints

- No new npm dependencies
- File reading for the dialog is client-side only (FileReader API, available in all modern browsers)
- File reading for the MCP tool uses synchronous `fs.readFileSync` (acceptable in async handler context, consistent with existing file reads in the codebase)
- All existing tests must continue to pass; update any test that asserts on CSS class names or tool input schemas

---

## Edge Cases and Failure Behaviors

| Scenario | Behavior |
|---|---|
| User attaches a file, then clears the × | Indicator clears; textarea content is preserved |
| User attaches a file, edits the textarea, submits | Submitted spec is whatever is in the textarea at submit time |
| User attaches a file then replaces it with another file | Second file's content overwrites first in textarea |
| File > 500KB | Error message shown; no content loaded |
| Non-text file selected | Error message shown; no content loaded |
| MCP: both `spec` and `spec_file` provided | Error response: "Provide either spec or spec_file, not both." |
| MCP: neither `spec` nor `spec_file` provided | Error response: "spec or spec_file is required." |
| MCP: `spec_file` path escapes project root | Error response: "spec_file must be within the project directory." |
| MCP: `spec_file` exists but is empty | Allowed — empty string becomes `spec_input`; the existing validation on the API route will reject it as `spec_input` is required to be non-empty |

---

## Assumptions Made

1. **"Forgot to account for the rest of the app"** means the CSS variable mismatch.  
   Confirmed by code review: `PipelinesPanel.module.css` and `NewPipelineDialog.module.css` use `--color-surface`, `--color-border`, and `--color-primary` — none of which exist in the app's `:root` block in `index.css`. The app theme uses `--bg-secondary`, `--border`, and `--accent` (warm sand/driftwood surfer palette). The result in the screenshot is a white card with a blue button inside an otherwise warm sandy page.

2. **"Attach a spec" means text/markdown file attachment**, not binary parsing.  
   The pipeline's `spec_input` is a plain-text database field. Extracting text from Word or PDF requires additional libraries (not currently in the project) and is non-trivial. The user's existing spec workflow uses markdown files (confirmed by `docs/specs/*.md` pattern in the repo). Text/markdown attachment covers the primary use case; binary formats are explicitly out of scope.

3. **File content populates the spec textarea** (rather than being an opaque file attachment).  
   This keeps the submit flow identical to the current typed-spec flow and lets the user review and edit the spec before starting the pipeline. It also requires zero backend changes.

4. **`spec_file` for MCP uses a project-relative path**.  
   MCP tokens are scoped to a project, so the project's `root_path` is available in context to resolve and validate the path safely. Absolute paths are rejected (they would fail the traversal check).

5. **Mutually exclusive `spec` / `spec_file`**.  
   Allowing both with a merge rule creates ambiguity about precedence. Requiring exactly one makes intent clear and validation straightforward.

---

## Open Questions Answered

**Q: What specific visual problem does "forgot to account for the rest of the app" describe?**  
A: CSS variable mismatch. The Pipeline components use a `--color-*` variable set that doesn't exist in the app theme, causing white backgrounds and blue buttons to appear on a sandy/warm-toned page. Resolved from code review of `index.css`, `PipelinesPanel.module.css`, and `NewPipelineDialog.module.css`.

**Q: Should spec attachment support PDF/Word documents?**  
A: No, for this iteration. Text and markdown files only, read client-side. Resolved from context: the project has no PDF/docx parsing library, `spec_input` is a text field, and the existing spec workflow is markdown-based.

**Q: Should `spec` and `spec_file` be mutually exclusive in the MCP tool?**  
A: Yes — providing both is an error. Resolved by elimination: merging them has no clear semantics, and either one alone is sufficient.
