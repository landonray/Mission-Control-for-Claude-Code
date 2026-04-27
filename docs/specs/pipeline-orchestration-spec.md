# Pipeline Orchestration — Specification

## Purpose

Add a workflow engine to Mission Control that automates the software development lifecycle: spec refinement → QA design → implementation planning → implementation → QA execution → code review → fix cycle. Instead of the user manually sequencing these steps (start a session, review output, start the next session, ferry context between them), a pipeline defines the stages, runs them as Mission Control sessions, passes outputs between stages, and gates on the user's approval only where it matters.

This replaces Claude Code's ad-hoc sub-agent spawning with a structured, visible, auditable process. Every session runs through Mission Control — visible in the dashboard, logged in session history, consumable by the context document pipeline, and subject to the escalation flow.

## Problem

Today, building a feature from spec to shipped code involves the user manually orchestrating 5-10 sessions, copy-pasting outputs between them, deciding when each step is done, and keeping the whole sequence in their head. Claude Code sometimes spawns sub-agents on its own, but those are invisible to Mission Control — no logging, no history, no eval integration, no dashboard visibility. The user can't see what's happening, can't review intermediate work, and can't intervene at the right moments.

The pipeline engine makes this process structured, visible, and mostly autonomous — while keeping the user in the loop for the decisions that matter.

## Scope

Covers the pipeline entity, stage definitions, the orchestrator that sequences stages and handles transitions, the integration with existing Mission Control systems (sessions, MCP, evals, escalation), session color-coding, and the dashboard views for pipeline monitoring. Does not change the session infrastructure, the MCP server, or the eval system — the pipeline consumes those systems through their existing interfaces.

---

## Pipeline Stages

A pipeline moves through seven stages. Each stage is one or more Mission Control sessions with a specific purpose, system prompt, and set of inputs.

### Stage 1: Spec Refinement

**Purpose:** Take the user's raw spec and produce a tightened, implementation-ready spec. Identify ambiguities, gaps, contradictions, and unstated assumptions. Resolve what can be resolved from project context; escalate the rest to the user.

**Session type:** `spec_refinement`

**Inputs:**
- The user's raw spec (text or file path)
- PRODUCT.md and ARCHITECTURE.md
- The project's existing codebase (read-only access)

**Process:** The session reads the spec against the project context, produces a list of questions and concerns, attempts to resolve each from the context documents, and escalates unresolvable questions to the user via the escalation flow. Once all questions are resolved (either self-resolved or owner-answered), it produces a refined spec.

**Output:** A refined spec document, stored as a file in the project repo (e.g., `docs/specs/<pipeline-name>-refined.md`).

**Gate:** User approval required before advancing to stage 2. The user reviews the refined spec in the dashboard and either approves or sends it back with feedback for another refinement pass.

### Stage 2: QA Design

**Purpose:** Read the refined spec and design the test strategy — what scenarios to test, what acceptance criteria to verify, what edge cases to cover. Does not write test code; designs what needs to be tested and how.

**Session type:** `qa_design`

**Inputs:**
- The refined spec from stage 1
- PRODUCT.md and ARCHITECTURE.md
- Existing test files in the codebase (for style and coverage reference)

**Process:** The session analyzes the spec, identifies testable behaviors, designs test scenarios (happy path, error cases, edge cases, integration points), and produces a structured QA plan.

**Output:** A QA plan document listing all test scenarios, acceptance criteria, and the testing approach for each (unit test, integration test, manual verification, eval). Stored as `docs/specs/<pipeline-name>-qa-plan.md`.

**Gate:** User approval required before advancing to stage 3. The user reviews the QA plan — this is where you catch "you're testing the wrong things" before any code gets written.

### Stage 3: Implementation Planning

**Purpose:** Break the refined spec into logical implementation chunks, identify dependencies between chunks, determine execution order, and produce a build plan.

**Session type:** `implementation_planning`

**Inputs:**
- The refined spec from stage 1
- The QA plan from stage 2
- PRODUCT.md and ARCHITECTURE.md
- The project's existing codebase (read-only access)

**Process:** The session reads the spec and QA plan, identifies natural boundaries in the work (by feature, by layer, by component), determines dependencies, and produces an ordered list of chunks. Each chunk includes: what to build, which files will be touched, which QA scenarios apply to it, and estimated complexity.

**Output:** A build plan document listing chunks in execution order, with dependencies noted. Stored as `docs/specs/<pipeline-name>-build-plan.md`.

**Gate:** User approval required before advancing to stage 4. This is the last gate before implementation begins — the user sees the full plan (refined spec + QA design + build plan) and either approves or adjusts.

### Stage 4: Implementation

**Purpose:** Execute the build plan. One session per chunk, run serially.

**Session type:** `implementation`

**Inputs per chunk:**
- The refined spec (full document, not just the chunk's portion — context matters)
- The chunk's specific instructions from the build plan
- The QA scenarios relevant to this chunk
- PRODUCT.md and ARCHITECTURE.md
- The project's codebase (full read-write access)
- Output from any previous chunks (if dependencies exist)

**Process:** Each session implements its chunk, guided by the spec and aware of the QA scenarios it needs to satisfy. On completion, it commits its work (or opens a PR, depending on the project's workflow).

**Execution model:** Serial. Chunks execute in the order specified by the build plan. Each chunk starts only after the previous chunk completes. This avoids merge conflicts and ensures each session sees the codebase including all previous chunks' changes.

**No gate.** Stages 4 through 7 run autonomously. The escalation system handles any decisions that need the user during implementation.

**Future optimization:** Parallel execution for independent chunks. Deferred until serial execution is validated and the merge-conflict problem is addressed.

### Stage 5: QA Execution

**Purpose:** Run the test scenarios from stage 2 against the implemented code.

**Session type:** `qa_execution`

**Inputs:**
- The QA plan from stage 2
- The implemented codebase
- The refined spec (for reference)
- PRODUCT.md and ARCHITECTURE.md

**Process:** The session runs through each test scenario in the QA plan: writes and executes tests where possible (unit tests, integration tests), performs manual verification steps, runs any relevant evals. Produces a structured QA report.

**Output:** A QA report listing each scenario, its result (pass/fail/blocked), and details on failures. Stored as `docs/specs/<pipeline-name>-qa-report.md`.

**Branching logic:** If all scenarios pass → advance to stage 6. If any scenarios fail → advance to stage 7 (fix cycle).

### Stage 6: Code Review

**Purpose:** Review the implementation for structural issues, spec compliance, pattern violations, and concerns that QA doesn't catch.

**Session type:** `code_review`

**Inputs:**
- The full diff of changes made during stage 4
- The refined spec
- The QA report from stage 5
- PRODUCT.md and ARCHITECTURE.md

**Process:** The session reviews the implementation holistically: does it match the spec intent, does it follow established patterns, are there structural concerns, is the code maintainable, are there security or performance issues. Produces a review document.

**Output:** A code review document listing findings categorized as blockers, concerns, and suggestions. Stored as `docs/specs/<pipeline-name>-code-review.md`.

**Branching logic:** If no blockers → pipeline complete. If blockers exist → advance to stage 7 (fix cycle).

### Stage 7: Fix Cycle

**Purpose:** Address failures from QA and/or blockers from code review.

**Session type:** `implementation` (same type as stage 4 — it's implementation work)

**Inputs:**
- The QA report failures and/or code review blockers
- The refined spec
- The codebase
- PRODUCT.md and ARCHITECTURE.md

**Process:** A session that reads the failures/blockers and fixes them. After fixing, loops back to stage 5 (QA execution) to verify the fixes.

**Iteration cap:** 3 fix cycles maximum. If QA is still failing or code review still has blockers after 3 rounds, the pipeline pauses and escalates to the user. Something is structurally wrong — the agent is probably thrashing, and the user needs to intervene with a different approach or adjusted acceptance criteria.

**Escalation on cap:** The escalation surfaces in the "Decisions Needed" panel with full context: the original spec, the QA failures, the code review blockers, what was tried in each fix cycle, and a recommendation for how the user might unblock it.

---

## Pipeline Entity

A pipeline is a first-class entity in Mission Control's database.

**Fields:**
- `id` — unique identifier
- `name` — user-provided name (e.g., "Add pagination support")
- `project_id` — which project this pipeline belongs to
- `status` — `draft` | `running` | `paused_for_approval` | `paused_for_escalation` | `completed` | `failed`
- `current_stage` — which stage is active (1-7)
- `fix_cycle_count` — how many times stage 7 has run (cap at 3)
- `created_at`
- `updated_at`
- `completed_at`
- `spec_input` — the original raw spec (text or file reference)

**Relationships:**
- A pipeline has many sessions (each stage creates one or more sessions, linked by `pipeline_id` on the sessions table)
- A pipeline has many stage outputs (the documents produced at each stage, stored as file paths)
- A pipeline belongs to a project

### Stage Outputs Table

Each stage's output is tracked:
- `pipeline_id`
- `stage` — which stage (1-7)
- `iteration` — which pass (1 for first run, 2+ for fix cycle repeats of stages 5-7)
- `output_path` — file path to the stage's output document
- `status` — `completed` | `approved` | `rejected`
- `approved_at` — when the user approved (for gated stages)

---

## Pipeline Orchestrator

The orchestrator is a service in Mission Control that manages pipeline progression. It is event-driven — it reacts to session completions and user approvals rather than polling.

### Starting a Pipeline

The user creates a pipeline from the dashboard: picks a project, gives it a name, pastes or uploads a spec. The pipeline is created in `draft` status. The user clicks "Start" and the orchestrator launches stage 1.

Alternatively, a pipeline can be started via MCP: `mc_start_pipeline` (a new Phase 2+ MCP tool) with project_id, name, and spec as inputs. This enables other systems (Quality Rules hooks, CI, Claude Code itself) to kick off pipelines programmatically.

### Stage Transitions

When a session completes, the orchestrator:

1. Captures the stage output (the document the session produced)
2. Stores it in the stage outputs table
3. Checks whether the stage has a gate:
   - **Gated (stages 1, 2, 3):** Sets pipeline status to `paused_for_approval`. Surfaces the output for user review in the dashboard. Waits for approval or rejection.
   - **Ungated (stages 4, 5, 6, 7):** Checks the branching logic (QA pass/fail, review blockers) and advances to the appropriate next stage automatically.
4. When advancing, the orchestrator creates the next stage's session via the existing session infrastructure (same as `mc_start_session`), passing the appropriate inputs.

### User Approval Flow

For gated stages, the dashboard shows the stage output with approve/reject buttons.

**Approve:** The orchestrator advances to the next stage.

**Reject with feedback:** The user provides feedback text. The orchestrator re-runs the current stage with the original inputs plus the user's feedback. The session's prompt includes: "Your previous output was rejected. Here is the feedback: {feedback}. Revise your output to address this feedback."

### Handling Escalations During Stages

Any stage's session can trigger an escalation via the existing escalation flow. When this happens:

1. The pipeline status changes to `paused_for_escalation`
2. The escalated question appears in the "Decisions Needed" panel, tagged with the pipeline name and stage
3. When the user answers, the pipeline resumes from where it paused

The pipeline doesn't advance while waiting for an escalation answer — the current stage's session is parked until the answer arrives.

### Error Handling

If a session errors (crashes, produces unparseable output, fails to produce the expected output document):

1. The orchestrator retries once with the same inputs
2. If the retry also fails, the pipeline pauses and escalates to the user: "Stage X failed after retry. Error: {details}. You can retry manually or abort the pipeline."

---

## Session Color Coding

With pipelines spawning multiple sessions of different types, the dashboard needs visual differentiation at a glance. Sessions are color-coded by session type.

### Color Assignments

Each session type maps to a single color used consistently across the dashboard — in session lists, pipeline views, and any other place sessions appear.

- **Manual sessions** (user-started, no pipeline) — the current existing color. This is "I did this" and stays unchanged.
- **Spec refinement** — blue. The thinking/planning phase.
- **QA design** — purple. Test strategy, distinct from test execution.
- **Implementation planning** — blue (same as spec refinement — both are planning activities, visually grouping them is fine).
- **Planning sessions** (MCP-initiated product/architecture queries) — blue. Same planning family.
- **Implementation** — green. The building phase. Applies to both pipeline implementation chunks and standalone implementation sessions.
- **QA execution** — orange. Testing is happening, attention may be needed.
- **Code review** — yellow. Review phase, between building and shipping.
- **Extraction** — gray. Background infrastructure work (PR extraction for context docs). Low visual priority.
- **Eval gatherer** — gray. Same as extraction — background work.

### Palette Principles

- **Small set.** Six distinct colors: the existing manual color, blue, green, orange, yellow, gray. Purple for QA design if you want to distinguish it from the blue planning family; otherwise fold it into blue for an even smaller set.
- **Semantic grouping.** Planning activities are blue. Building is green. Testing/QA is orange. Review is yellow. Background/infrastructure is gray. The colors tell a story: blue → green → orange → yellow is the natural pipeline flow.
- **Accessible.** Colors should be distinguishable for color-blind users. Consider adding a small icon or letter badge alongside the color for full accessibility (P for planning, I for implementation, Q for QA, R for review, E for extraction).

### Where Colors Appear

- **Session list** — colored dot or left-border accent on each session row
- **Pipeline view** — each stage's sessions inherit the stage's color
- **Project detail page** — active sessions show their type color
- **Dashboard overview** — if there's a session count summary, break it down by color/type

---

## Dashboard Views

### Pipeline List

The project detail page gains a "Pipelines" section showing all pipelines for the project:
- Pipeline name, status, current stage, created date
- Color-coded progress indicator showing which stages are complete, which is active, which are pending
- Click to open the pipeline detail view

### Pipeline Detail View

A dedicated view for a single pipeline showing:
- The full stage sequence as a visual flow (stage 1 → stage 2 → ... → stage 7)
- Each stage shows: status (completed/active/pending/skipped), the session(s) that ran for it, the output document, approval status for gated stages
- The active stage is highlighted with its type color
- For gated stages awaiting approval: the output document is shown inline with approve/reject buttons
- For stages in fix cycle: shows the iteration count and links to each iteration's QA report
- For escalated stages: shows the pending question with a link to answer it
- Stage output documents are viewable inline (markdown rendered in the dashboard) or downloadable

### Pipeline Creation

A "New Pipeline" button on the project detail page. The creation form:
- Pipeline name (required)
- Spec input — a large text area for pasting a spec, or a file upload, or a path to an existing spec file in the repo
- Start button

Optionally, the spec input could connect to the "Build Eval with AI" pattern — a text area where the user describes what they want in natural language, and an AI session produces the initial spec. But that's an enhancement, not a v1 requirement.

### Stage Prompt Visibility and Editing

Each pipeline stage has a system prompt that defines how the session behaves — what it's trying to do, how it should reason, what format to produce output in, the escalation instructions, the sub-agent enforcement instruction. These prompts are the most important tuning surface in the pipeline. They must be visible and editable in the UI.

**Where prompts live:** Stage prompts are stored in the database as part of the pipeline configuration, not hardcoded in the orchestrator. Each pipeline has a set of stage prompts (one per stage) initialized from defaults when the pipeline is created. The defaults ship with Mission Control and represent the best-practice prompt for each stage. But once a pipeline is created, its prompts are independent copies — editing a pipeline's stage prompt doesn't affect future pipelines, and updating the defaults doesn't change existing pipelines.

**Viewing prompts:** The pipeline detail view has a "Stage Prompts" tab or expandable section. Each stage's prompt is shown with the stage name and color. The user can read exactly what instruction the session will receive.

**Editing prompts:** Each prompt has an "Edit" button that opens the prompt in a text editor within the dashboard. The user can modify the prompt and save. If the stage hasn't run yet, the next run uses the edited prompt. If the stage already ran and the user wants to re-run with an edited prompt, they can reject the stage output (for gated stages) or manually re-trigger the stage.

**Why this matters:** When a stage produces poor output, the user needs to know whether the problem is the prompt or the input. Seeing the prompt answers that question immediately. And the primary tuning loop for pipelines is: run a stage, review the output, adjust the prompt, re-run. That loop must be fast and self-service — no code changes, no deployments, no asking Claude Code to modify a file.

**Default prompt management:** The defaults are stored in a well-known location in the Mission Control codebase (e.g., `server/prompts/pipeline/`). When Mission Control ships improved defaults, existing pipelines keep their current prompts (no silent changes to running workflows). The dashboard could show a "defaults have been updated, would you like to reset this stage's prompt to the new default?" notification, but that's a nice-to-have, not a v1 requirement.

---

## Integration With Existing Systems

### Sessions

Pipeline sessions are regular Mission Control sessions with additional metadata: `pipeline_id` and `pipeline_stage` columns on the sessions table. They use the same tmux/Claude CLI infrastructure, the same logging, the same dashboard visibility. The only difference is that their lifecycle is managed by the pipeline orchestrator rather than the user.

### MCP Server

The pipeline can be started and monitored via MCP tools (future phase):
- `mc_start_pipeline` — create and start a pipeline
- `mc_get_pipeline_status` — check pipeline progress
- `mc_approve_stage` — approve a gated stage
- `mc_reject_stage` — reject a gated stage with feedback

These tools enable Claude Code to kick off pipelines programmatically: "I've identified that this feature needs a full implementation cycle — starting a pipeline."

### Evals

Stage 5 (QA execution) can arm and run evals as part of its testing. If the project has relevant eval folders, the QA execution session should arm them and run them as part of the verification process. Eval results feed into the QA report.

### Escalation

All pipeline stages use the existing escalation flow. Escalations from pipeline sessions are tagged with the pipeline name and stage so the user knows "this question is from the pagination pipeline, stage 4, chunk 2" — not just "a session has a question."

### Context Documents

Pipeline sessions consume PRODUCT.md and ARCHITECTURE.md like any other session. Decisions made during pipeline sessions (especially during spec refinement and implementation) feed into the context document update cycle via the existing PR extraction and decision logging flows.

---

## Build Order

1. **Pipeline entity and database tables.** Pipeline table, stage outputs table, new columns on sessions (pipeline_id, pipeline_stage). Migrations only, no orchestrator logic yet.

2. **Session color coding.** Add session_type-to-color mapping, apply to session list UI and project detail page. This is independently useful before pipelines exist — planning sessions and eval gatherer sessions already have types that benefit from color coding.

3. **Pipeline creation UI.** The "New Pipeline" form on the project detail page. Creates the pipeline entity and stores the spec input. No orchestration yet — just the data model and the creation flow.

4. **Pipeline orchestrator — stages 1 through 3.** Implement the spec refinement, QA design, and implementation planning stages with gating. This is the planning phase of the pipeline. Test with a real spec to validate that the stage outputs are useful and the approval flow works.

5. **Pipeline orchestrator — stage 4.** Serial implementation execution. One session per chunk from the build plan.

6. **Pipeline orchestrator — stages 5 and 6.** QA execution and code review. Branching logic (pass → done, fail → fix cycle).

7. **Pipeline orchestrator — stage 7.** Fix cycle with iteration cap and escalation on cap.

8. **Pipeline detail view.** The full visual pipeline view in the dashboard with stage progress, output documents, and inline approval.

9. **Pipeline MCP tools.** mc_start_pipeline, mc_get_pipeline_status, mc_approve_stage, mc_reject_stage.

Ship stages 1-3 orchestration first (build order step 4). That's the planning pipeline — the most valuable part and the part where user gating matters most. Validate that the refined specs and build plans are good before building the autonomous implementation and QA stages on top. If stage 1-3 output is poor, fix the prompts before stages 4-7 amplify the problems.

---

## Sub-Agent Enforcement

Claude Code can spawn its own sub-agents outside of Mission Control by default. If it does, that work is invisible — no logging, no history, no eval integration, no dashboard visibility. The pipeline only works if all sessions route through Mission Control.

There is no way to technically prevent Claude Code from spawning sub-agents — it's a capability of the CLI tool itself, not something Mission Control controls. Enforcement is handled through two mechanisms:

### Prompt Instruction

Every session's system prompt — not just pipeline sessions, all sessions started by Mission Control — includes an explicit instruction:

"Do not spawn sub-agents, background processes, or parallel tasks on your own. If you need work done in parallel, if a task is too large for a single session, or if you need a different perspective (planning, QA, code review), use the Mission Control MCP tools to start a new session. All work must be visible in Mission Control. Starting your own sub-agents outside of Mission Control is not allowed."

This is soft enforcement. It works most of the time because Claude follows instructions, but it is not guaranteed.

### Pipeline Decomposition as Structural Prevention

The deeper fix is that the pipeline's stage 3 (implementation planning) handles decomposition before implementation begins. By the time a session receives a chunk to implement in stage 4, the chunk should be scoped tightly enough that the session doesn't feel the need to spawn sub-agents. If sessions are routinely trying to spawn sub-agents during implementation, that is a signal that stage 3 is not breaking the work down enough. The fix is tightening the implementation planning prompt, not adding technical guardrails.

### Detecting Violations

If a session does spawn sub-agents despite the instruction, the work is invisible to Mission Control. This manifests as: a session that takes suspiciously long, changes that don't correspond to any logged session, or costs that seem disproportionate to the visible session count. These are signals to investigate the session logs and re-prompt. The usage logging (session duration and count per project) provides the data needed to spot anomalies.

---

## Resolved Design Decisions

1. **Stage output format.** Provide a template as guidance in the system prompt but don't enforce it programmatically. If the output is useful, the format doesn't matter. Rigid templates constrain the session unnecessarily.

2. **Pipeline-scoped evals.** Deferred to v2. For now, pipelines use the project's existing eval folders. Feature-specific acceptance criteria live in the QA plan document rather than as temporary evals.

3. **Multiple concurrent pipelines.** One active pipeline per project at a time. Additional pipelines queue. This avoids codebase conflicts during implementation — the same reasoning as serial chunk execution.

4. **Pipeline templates.** The seven-stage sequence is the only pipeline shape for v1. Design the orchestrator to support variable stage sequences internally (stages as a configurable list, not hardcoded), but don't build a template UI or alternative pipeline shapes until specific needs emerge.

5. **Cost visibility.** Not relevant — working with a Claude Code plan, not API billing. No cost tracking needed on the pipeline detail view.
