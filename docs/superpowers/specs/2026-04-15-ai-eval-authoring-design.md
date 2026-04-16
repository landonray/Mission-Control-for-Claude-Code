# AI-Assisted Eval Authoring — Design Spec

## Purpose

Add a natural-language eval authoring flow to Mission Control. The AI builder becomes the primary creation path; the existing form becomes the power-user editing surface. A shared backend serves both the manual drawer and Quality Rules hook-triggered authoring.

## Decisions Made During Design

- **Progress indicators**: Predetermined status messages on a timer (not real-time agent streaming). Simpler, ships faster, still builds trust.
- **Drawer behavior**: Slides down within the right panel content area (not a side drawer). Takes over the full panel space when open; form is hidden until the agent finishes.
- **Entry point**: "New Eval" shows a choice screen — "Build with AI" (primary) and "Build manually" (secondary link). AI is the default path.
- **Transport**: WebSocket messages for authoring progress/completion, piggybacking on the existing WS infrastructure. POST kicks off authoring, results stream back over WS.
- **Draft naming conflicts**: Auto-suffix with a number if a published eval with the same name already exists at publish time.
- **No visual companion**: Text-based design only.

---

## 1. User Flow & UI

### 1.1 New Eval Entry Point

When the user clicks "New Eval" on a folder, instead of immediately showing the form, they see a choice screen:

- **"Build with AI"** — large primary button, the obvious default
- **"Build manually"** — smaller secondary link below

If the user is at the project root without a folder selected, a folder dropdown appears so they can pick one (or create a new folder inline).

### 1.2 AI Authoring Drawer

Choosing "Build with AI" expands a drawer that takes over the right panel content:

- Target folder name displayed (auto-set from context)
- Large text area: "Describe what this eval should check"
- Submit and Cancel buttons

**On submit**, the text area and buttons are replaced by a working state:
- Spinner/animated progress indicator
- Predetermined status messages cycling on a timer:
  1. "Investigating your project..." (0s)
  2. "Reviewing existing evals..." (~8s)
  3. "Drafting eval..." (~16s)
  4. "Finalizing..." (~30s)
- Messages advance on a timer but also advance to "Finalizing..." if the agent returns early

**On completion**, the drawer collapses and the full CreateEvalForm appears populated with everything the agent produced. A collapsible "How this eval was built" section at the top shows the agent's reasoning paragraph.

**On error**, the drawer shows the error message: "Authoring failed: [reason]. Try refining your description or build the eval manually." A "Try Again" button resets to the text area; a "Build Manually" link opens the empty form.

### 1.3 Populated Form Actions

When the form is populated (by AI or manually), the bottom shows:

- **Refine** — collapses the form back into the drawer. Shows:
  - The original description (editable)
  - A new text area: "What would you like to change?"
  - Submit and Cancel buttons
  - On submit, agent re-runs with original description + refinement + current form state. Form re-populates with the revised draft. Unlimited iterations.

- **Preview Run** — runs the eval once against current state without saving. Displayed inline in the right panel, showing:
  - Gathered evidence (full text)
  - Check results (pass/fail per check)
  - Judge verdict with reasoning and confidence
  - Duration and approximate token cost
  - A "Back to Form" button to return to editing

- **Save as Draft** — persists the eval to disk as a `.yaml.draft` file. The button label makes the draft status clear.

### 1.4 Draft Lifecycle in Dashboard

Drafts appear in the eval folder list with a "Draft" badge. They have:

- **Publish** button — renames the file to drop `.draft` suffix, making it active. If a file with that name already exists, auto-suffixes with a number (e.g., `recipe-matches-acme-2.yaml`).
- **Preview Run** button — same as above, available from the eval list
- **Edit** — opens the form populated with the draft's current state
- **Delete** — removes the draft file

Drafts are invisible to the run engine. When a folder is armed and a trigger fires, `.yaml.draft` files are skipped during eval discovery.

---

## 2. Authoring Backend

### 2.1 Endpoint

`POST /api/evals/author` — single endpoint for both manual drawer and Quality Rules hook.

**Request body:**
```json
{
  "projectId": "uuid",
  "folderPath": "evals/recipe-extraction",
  "description": "Check that recipe extraction produces valid JSON with all required fields",
  "currentFormState": null,
  "refinement": null,
  "hints": null
}
```

- `projectId` (required): Resolves to project root, `.mission-control.yaml`, DB connection
- `folderPath` (required): Target eval folder relative to project root
- `description` (required): Natural-language description from user or hook-derived context
- `currentFormState` (optional): Current form field values for refinement flows
- `refinement` (optional): "What would you like to change?" text for refinement
- `hints` (optional): Caller-provided context hints

**Response:**
```json
{
  "success": true,
  "jobId": "uuid"
}
```

Results delivered via WebSocket (see 2.3).

### 2.2 Agent Session

The endpoint spawns a sandboxed Claude CLI session using the existing `cliAgent.js` infrastructure:

**Command:** `claude --print <prompt> --allowedTools Read,Glob,Grep,Bash(read-only) --permission-mode plan --no-mcp --cwd <project-root>`

**System prompt contains:**
- The eval YAML schema with all field definitions and enumerated vocabularies (evidence types, check types, evidence sources, interpolation namespaces, model enum)
- The target project's `.mission-control.yaml` contents
- A directory listing of the target folder (existing evals)
- Contents of 1-2 existing evals in the folder for style reference (if any exist)
- Instructions to investigate before drafting (read DB schema if db_query might apply, check project structure)
- Instructions to output a complete eval as JSON matching the form field structure
- Instructions to include a one-paragraph reasoning summary
- For refinement: the original description, current form state, and refinement request

**Sandbox constraints** (same as sub_agent evidence gatherers):
- Read-only tools only (Read, Glob, Grep, Bash read-only)
- Permission mode: plan (most restrictive)
- No MCP servers
- No tmux access
- 3-minute timeout

**Output parsing:**
The agent's response is parsed to extract:
- The structured eval object (JSON matching form fields)
- The reasoning paragraph
- On parse failure → error state returned to frontend

### 2.3 WebSocket Messages

New message types on the existing WS connection:

- `eval_authoring_started` — `{ jobId }` — confirms authoring kicked off
- `eval_authoring_progress` — `{ jobId, message }` — predetermined progress messages sent by the server on a timer
- `eval_authoring_complete` — `{ jobId, eval, reasoning }` — the structured eval draft and reasoning paragraph
- `eval_authoring_error` — `{ jobId, error }` — error message on failure

The server manages the timer for progress messages:
1. Send "Investigating your project..." immediately
2. Send "Reviewing existing evals..." after ~8s
3. Send "Drafting eval..." after ~16s
4. Send "Finalizing..." after ~30s
5. On agent completion, send `eval_authoring_complete` (clears any pending timer)
6. On error/timeout, send `eval_authoring_error`

### 2.4 Structured Output Format

The agent returns a JSON object that maps directly to form fields:

```json
{
  "name": "recipe-matches-acme",
  "description": "Verify recipe extraction produces valid JSON with required fields",
  "input": { "recipe_id": "123" },
  "evidence": {
    "type": "db_query",
    "query": "SELECT data FROM recipes WHERE id = :recipe_id",
    "params": { "recipe_id": "${input.recipe_id}" }
  },
  "checks": [
    { "type": "not_empty" },
    { "type": "json_valid" },
    { "type": "field_exists", "field": "title" }
  ],
  "expected": "Recipe data is valid JSON containing all required fields",
  "judge_prompt": "Evaluate whether the recipe data contains...",
  "judge": { "model": "default" }
}
```

---

## 3. Draft Lifecycle

### 3.1 File Storage

Draft evals use a `.draft` suffix: `eval-name.yaml.draft`

They live in the same folder as published evals (e.g., `evals/recipe-extraction/recipe-matches-acme.yaml.draft`).

### 3.2 Eval Discovery Changes

The eval loader (`evalLoader.js`) is modified:
- `discoverEvals()` returns two lists: `evals` (`.yaml`/`.yml` files) and `drafts` (`.yaml.draft`/`.yml.draft` files)
- The run engine (`evalRunner.js`) only processes the `evals` list — drafts are never executed by armed folder triggers
- The dashboard displays both lists, with drafts showing a "Draft" badge

### 3.3 Publish Flow

Publishing a draft:
1. Determine target filename by dropping `.draft` suffix
2. Check if a file with that name already exists in the folder
3. If conflict: auto-suffix with incrementing number (`-2`, `-3`, etc.) until a free name is found
4. Rename the file
5. Return the new eval to the frontend for UI update

### 3.4 Save from Form

When saving an AI-authored eval from the form:
1. The "Save as Draft" button writes the YAML file with `.draft` suffix
2. Uses the existing `create-eval` endpoint logic but appends `.draft` to the filename
3. The form closes and returns to the folder view, where the new draft appears with its badge

---

## 4. Preview Run

### 4.1 Endpoint

`POST /api/evals/preview` — runs an eval definition once without persisting results.

**Request body:**
```json
{
  "projectId": "uuid",
  "evalDefinition": { /* full eval object matching YAML schema */ }
}
```

### 4.2 Execution

- Reuses the existing eval pipeline: `gatherEvidence()` → `runChecks()` → `callJudge()`
- The eval definition is passed directly (not loaded from disk)
- No batch is created, no run is stored in the database
- Results are returned directly in the HTTP response (not via WebSocket — preview is synchronous and the user is waiting)

**Response:**
```json
{
  "success": true,
  "result": {
    "state": "pass",
    "evidence": "full gathered evidence text...",
    "checkResults": [
      { "type": "not_empty", "passed": true, "reason": "Evidence is not empty" }
    ],
    "judgeVerdict": {
      "result": "pass",
      "confidence": "high",
      "reasoning": "The recipe data contains..."
    },
    "duration": 4200,
    "estimatedTokenCost": "~2,500 tokens"
  }
}
```

### 4.3 Token Cost Estimation

Approximate token cost is computed from:
- Evidence size (characters / 4 as rough token estimate)
- Judge prompt size
- Fixed overhead for system prompt (~500 tokens)

This is a rough estimate displayed for user awareness, not a billing metric.

---

## 5. Refinement Flow

### 5.1 UI Behavior

When "Refine" is clicked on a populated form:
1. The form collapses back into the drawer view
2. The drawer shows:
   - The original description (editable text area)
   - A new text area: "What would you like to change?"
   - Submit and Cancel buttons
3. Cancel returns to the populated form (no changes)
4. Submit calls the authoring endpoint with `description` + `refinement` + `currentFormState`

### 5.2 Backend Handling

The authoring agent receives an augmented prompt when `refinement` and `currentFormState` are provided:
- "The user originally asked for: [description]"
- "The current draft looks like: [currentFormState as YAML]"
- "The user wants to change: [refinement]"
- "Produce a revised eval that addresses the refinement while preserving everything else."

Same sandbox, same timeout, same output format. The form re-populates with the revised draft.

---

## 6. Quality Rules Integration

### 6.1 New Action Type

Add an `author_eval` action type to the Quality Rules engine alongside existing action types.

A quality rule configured for eval authoring:
- **Trigger**: Any supported hook event (e.g., `PRCreated`)
- **Action type**: `author_eval`
- **Config**:
  ```json
  {
    "targetFolder": "evals/recipe-extraction",
    "contextTemplate": "A PR was opened that modified recipe extraction. Diff: ${pr.diff}. Author evals to catch regressions."
  }
  ```

### 6.2 Execution

When the rule fires:
1. Build the description from `contextTemplate` with variable interpolation (PR diff, commit message, affected files)
2. Call the same `POST /api/evals/author` endpoint
3. Results come back as a structured eval draft
4. Write the draft to the target folder as a `.yaml.draft` file
5. Optionally: create a PR with the draft committed (configurable per rule)

### 6.3 No Auto-Publish

Hook-authored evals always land as drafts. The user reviews and publishes manually, either in the Mission Control dashboard or via PR review if the rule is configured to open PRs.

---

## 7. Build Order

Each piece is independently testable. Ship in this order:

1. **Authoring endpoint** — `POST /api/evals/author`, sandboxed Claude CLI session, structured output parsing, WebSocket progress messages
2. **Drawer UI** — choice screen, text area, progress display, form population, "How this eval was built" section
3. **Draft lifecycle** — `.draft` suffix, eval discovery changes, draft badge in dashboard, Publish action, exclusion from run engine
4. **Preview Run** — `POST /api/evals/preview`, ephemeral eval execution, result display in panel
5. **Refine flow** — drawer re-entry with context, augmented agent prompt, form re-population
6. **Quality Rules integration** — `author_eval` action type, context template, draft file writing, optional PR creation

Ship 1-3 first (the manual AI authoring path). Preview and refine are additive. Quality Rules integration is last.

---

## 8. Files to Create or Modify

### New Files
- `server/services/evalAuthoring.js` — authoring agent orchestration (prompt building, CLI session spawning, output parsing, progress timer)
- `server/routes/evalAuthoring.js` — REST endpoint and WebSocket message handling
- `client/src/components/Quality/AIEvalDrawer.jsx` — the drawer UI (text area, progress, error states)
- `client/src/components/Quality/AIEvalDrawer.module.css` — drawer styles
- `client/src/components/Quality/EvalChoiceScreen.jsx` — "Build with AI" vs "Build manually" entry point
- `client/src/components/Quality/EvalChoiceScreen.module.css` — choice screen styles
- `client/src/components/Quality/PreviewRunResult.jsx` — preview run result display
- `client/src/components/Quality/PreviewRunResult.module.css` — preview result styles

### Modified Files
- `server/routes/evals.js` — add preview endpoint, modify create-eval to support draft suffix, add publish endpoint
- `server/services/evalLoader.js` — split discovery into evals + drafts, skip drafts in run engine
- `server/services/evalRunner.js` — ensure drafts are excluded from batch runs
- `server/index.js` — register new routes, add WS message types
- `client/src/components/Quality/QualityTab.jsx` — integrate choice screen, draft badges, publish button, preview button
- `client/src/components/Quality/CreateEvalForm.jsx` — add Refine and Preview Run buttons, accept pre-populated state from AI drawer
- `client/src/components/Quality/QualityTab.module.css` — draft badge styles
- `client/src/utils/api.js` — add API calls for authoring and preview endpoints
- `server/services/qualityRunner.js` — add `author_eval` action type (phase 6)
