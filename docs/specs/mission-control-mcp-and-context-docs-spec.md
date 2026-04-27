# Mission Control MCP Server — Specification

## Purpose

Expose Mission Control as an MCP server so that Claude Code sessions, Quality Rules hooks, the eval system, and the context document generator can all interact with Mission Control programmatically. This is the single orchestration surface for all agent-to-Mission-Control communication. Everything routes through here rather than building point-to-point integrations.

The immediate motivating use case: Claude Code hits a product or architectural question it can't resolve from PRODUCT.md and ARCHITECTURE.md. Instead of asking the user (who would just copy-paste the question to a planning context and copy the answer back), Claude Code calls a Mission Control MCP tool that starts a planning session, asks the question, and returns the answer — all visible in Mission Control's session history and dashboard.

## Scope

Covers the MCP server, its tool surface, authentication, session management for planning queries, and integration points with existing Mission Control systems (sessions, evals, projects, context documents). Does not cover changes to the eval engine, the context document pipeline, or the dashboard — those systems consume the MCP server, they don't change because of it.

---

## Architecture

Mission Control runs an MCP server that Claude Code (and other MCP clients) can connect to. The server exposes tools organized into domains. Each tool call is authenticated, logged, and scoped to a project.

The server runs as part of the Mission Control application — not a separate deployment. It shares the same database, the same session infrastructure, and the same project model. This means MCP-initiated sessions are identical to dashboard-initiated sessions in every way: they appear in the dashboard, they get logged, they're available to the context document extraction pipeline, and they can have evals armed against them.

---

## Tool Surface

The MCP server exposes tools in phases. Phase 1 solves the immediate ferry-loop problem. Later phases expose more of Mission Control's capabilities as the need arises.

### Phase 1: Planning Query Loop

These three tools close the "Claude Code asks a question, user ferries it to a planning context, ferries the answer back" loop.

**mc_start_session**

Starts a new session in Mission Control for a given project.

Inputs:
- `project_id` — which project this session belongs to (resolved from project name or ID)
- `system_prompt` — the system prompt for the session (e.g., "You are a senior architect for this project. Here is the project context: {ARCHITECTURE.md contents}")
- `task` — the initial task or question for the session
- `session_type` — one of: `planning`, `implementation`, `extraction`, `eval_gatherer` (determines default timeout, logging behavior, and dashboard grouping)
- `timeout_seconds` — optional, defaults based on session_type (planning: 180s, implementation: no timeout, extraction: 300s, eval_gatherer: 300s)
- `context_files` — optional list of file paths to load into the session's context (e.g., PRODUCT.md, ARCHITECTURE.md, a specific spec file)

Returns:
- `session_id` — the Mission Control session ID
- `status` — "started"

The session runs in Mission Control's existing sandboxed Claude CLI infrastructure. For planning sessions specifically: read-only access to the project repo, read-only DB access if configured, no mutation tools, no access to other user sessions. Same sandbox as eval sub-agent gatherers.

When a planning session starts, Mission Control automatically loads the project's PRODUCT.md and ARCHITECTURE.md into the session context (in addition to any explicit `context_files`). This means the planning agent has the full project knowledge base without the caller needing to manage it.

**mc_send_message**

Sends a message to an existing session and returns the response.

Inputs:
- `session_id` — the session to message
- `message` — the message content

Returns:
- `response` — the session's response text
- `status` — "completed" | "running" | "error"
- `error` — error description if status is "error"

This is a synchronous call — it blocks until the session responds or times out. For planning queries this is the right behavior: Claude Code asks a question, waits for the answer, continues working. For long-running sessions, use `mc_get_session_status` to poll instead.

**mc_get_session_status**

Checks the status of a session.

Inputs:
- `session_id` — the session to check

Returns:
- `session_id`
- `status` — "running" | "completed" | "error" | "timed_out"
- `duration_seconds` — how long the session has been running
- `last_response` — the most recent response from the session (if any)

### Phase 2: Eval Integration

These tools let Claude Code (and other clients) interact with the eval system programmatically.

**mc_run_evals**

Triggers an eval run for armed folders in a project.

Inputs:
- `project_id`
- `folder` — optional, specific folder to run (if omitted, runs all armed folders)
- `trigger_source` — "manual" | "session_end" | "pr_updated" | "mcp_client"

Returns:
- `batch_id` — the eval batch ID
- `status` — "started"
- `eval_count` — number of evals queued

**mc_get_eval_results**

Retrieves results for an eval batch.

Inputs:
- `batch_id`

Returns:
- `status` — "running" | "completed"
- `results` — array of eval results (name, folder, state, verdict, reasoning, duration)
- `summary` — the prose failure message (same format as what gets sent to CLI sessions)

**mc_arm_folder**

Arms or disarms an eval folder for a session.

Inputs:
- `project_id`
- `session_id`
- `folder` — the eval folder path
- `armed` — true | false

Returns:
- `folder`
- `armed`
- `eval_count` — number of evals in the folder

### Phase 3: Project and Context Management

**mc_list_projects**

Lists all projects known to Mission Control.

Returns:
- Array of projects (id, name, root_path, context_docs_exist, last_rollup_timestamp, pending_extraction_count)

**mc_get_project_context**

Retrieves the context documents for a project.

Inputs:
- `project_id`
- `document` — "product" | "architecture" | "both"

Returns:
- The requested document content(s)

This is useful when a non-Claude-Code client (e.g., a CI system, a webhook handler) needs project context without starting a full session.

**mc_trigger_extraction**

Triggers a per-PR extraction for the context document pipeline.

Inputs:
- `project_id`
- `pr_number` — optional, specific PR to extract (if omitted, extracts all unprocessed PRs)

Returns:
- `extraction_count` — number of extractions queued
- `status` — "started"

**mc_trigger_rollup**

Triggers a roll-up synthesis for a project's context documents.

Inputs:
- `project_id`

Returns:
- `status` — "started"
- `pending_extractions` — number of extractions being rolled up

### Phase 4: Session History and Search

**mc_search_sessions**

Searches past session history for a project.

Inputs:
- `project_id`
- `query` — natural language search query
- `session_type` — optional filter by type
- `limit` — max results (default 10)

Returns:
- Array of session summaries (id, type, task, summary, timestamp, files_touched)

This is how a new session can ask "has anyone already worked on pagination in this project" and get an answer from the session history rather than asking the user.

**mc_get_session_summary**

Retrieves the full summary of a past session.

Inputs:
- `session_id`

Returns:
- Full session summary (task, outcome, decisions made, files touched, PR opened, eval results)

---

## Authentication and Authorization

The MCP server authenticates callers via a project-scoped API token stored in `.mission-control.yaml` or the project's environment. Claude Code sessions receive this token as part of their session configuration.

Authorization rules:
- Planning sessions have read-only access to the project repo and database
- Implementation sessions have full access (they're regular Claude Code sessions)
- Extraction and eval_gatherer sessions have read-only access
- Any session can start other sessions via MCP, but only within the same project
- Cross-project session creation is not allowed via MCP (use the dashboard for that)

---

## Session Lifecycle for Planning Queries

The typical flow when Claude Code needs a planning-level answer:

1. Claude Code's session prompt includes an instruction: "If you encounter a product or architectural question that PRODUCT.md and ARCHITECTURE.md don't answer, use the mc_start_session tool to ask a planning session rather than asking the user."

2. Claude Code calls `mc_start_session` with session_type "planning", a system prompt that frames the planning agent's role, and the question as the task. It includes any relevant files as context_files.

3. Mission Control starts a sandboxed planning session. The session automatically receives PRODUCT.md and ARCHITECTURE.md. The planning agent reads the question, consults the context documents, and produces an answer.

4. Claude Code receives the answer via the `mc_send_message` response and continues its work.

5. The planning session is logged in Mission Control. The Q&A pair is visible in the dashboard under the project's session history. The context document extraction pipeline can later consume this interaction as a source of product/architectural knowledge.

**Multi-turn planning queries:** Sometimes Claude Code needs to follow up — "you said to use pattern X, but what about edge case Y?" Claude Code sends additional messages to the same planning session via `mc_send_message`. The planning agent has full conversation history within the session. When Claude Code is done asking questions, the session times out naturally or Claude Code stops sending messages.

**Planning session cost:** Planning sessions are short-lived and use the same model tier as eval judges (Sonnet by default, configurable). Typical cost is a single LLM call per question. Mission Control tracks planning session cost per project and surfaces it in the dashboard alongside eval costs.

---

## Decision Logging

Every planning query and its answer is automatically logged to a decisions file in the project repo. This happens at the Mission Control level, not in the planning session itself — Mission Control writes the log entry when the planning session completes.

The decisions log is a simple append-only markdown file at `docs/decisions.md` (or a path configured in `.mission-control.yaml`). Each entry includes:

- Timestamp
- The question asked
- The answer given
- Which session asked it (linked by session ID)
- Which files were being worked on at the time

The user reviews the decisions log periodically. If they disagree with a planning agent's answer, they:
- Correct the decision in the log
- Update PRODUCT.md or ARCHITECTURE.md so the question resolves correctly in the future
- Optionally redirect the implementation session that acted on the bad answer

This is the async review pattern: let the system move fast, review in batches, correct when needed. Much less blocking than synchronous human-in-the-loop.

---

## Integration Points

### With the Eval System

The eval system currently triggers sub-agent gatherer sessions directly. With the MCP server, it should instead call `mc_start_session` with session_type "eval_gatherer". This means eval gatherer sessions appear in the dashboard, get logged, and follow the same sandboxing rules as all other sessions. No behavioral change — just routing through the MCP server instead of a direct function call.

Similarly, the "Run Armed Evals" dashboard button and the session-end/PR-updated triggers can be exposed as `mc_run_evals` calls. This means evals can be triggered from Claude Code ("I just finished this feature, run the evals"), from CI systems, from Quality Rules hooks, or from the dashboard — all through the same interface.

### With the Context Document Pipeline

The context document pipeline currently needs its own session management for per-PR extraction and roll-up synthesis. With the MCP server, it calls `mc_start_session` with session_type "extraction" for each PR extraction and for roll-up calls. This unifies all session management under one system.

The pipeline's automatic extraction on PR merge becomes: the PR-merge webhook calls `mc_trigger_extraction` via MCP. The periodic roll-up becomes: a scheduled job calls `mc_trigger_rollup` via MCP. Same behavior, unified surface.

### With Quality Rules

Quality Rules hooks that need to trigger actions (eval authoring, session creation, notifications) can call MCP tools instead of internal functions. This means Quality Rules can do anything the MCP server can do, and new capabilities added to the MCP server are automatically available to Quality Rules without additional integration work.

### With Claude Code Sessions

Claude Code connects to the Mission Control MCP server at session start. The MCP server URL and auth token are injected into the session configuration by Mission Control when it starts the session. Claude Code's system prompt includes instructions on when and how to use the MCP tools.

For sessions not started by Mission Control (e.g., the user opens Claude Code directly), the MCP server URL and auth token can be configured in the project's `.claude/mcp.json` or equivalent Claude Code MCP configuration. The user sets this up once per project.

---

## Dashboard Additions

The dashboard gains a few new views to support MCP-initiated activity:

- **Planning query log:** a filterable list of planning questions asked by Claude Code sessions, with answers, organized by project. This is where the user does async review of agent decisions.
- **MCP activity feed:** a live feed of MCP tool calls across all projects, showing which sessions are calling which tools. Useful for understanding what the agents are doing without watching individual sessions.
- **Session type breakdown:** the existing session list gains a type filter (planning, implementation, extraction, eval_gatherer) so the user can focus on the session types they care about.

---

## Build Order

1. **MCP server skeleton.** Basic MCP server running inside Mission Control, serving tool definitions, handling auth. No tools implemented yet — just the infrastructure.

2. **Phase 1 tools: mc_start_session, mc_send_message, mc_get_session_status.** These close the ferry loop. Test by connecting Claude Code to the MCP server and having it ask planning questions.

3. **Decision logging.** Automatic append to decisions.md on planning session completion.

4. **Planning session auto-context.** Automatic loading of PRODUCT.md and ARCHITECTURE.md into planning sessions.

5. **Phase 2 tools: mc_run_evals, mc_get_eval_results, mc_arm_folder.** Eval system integration through MCP.

6. **Phase 3 tools: mc_list_projects, mc_get_project_context, mc_trigger_extraction, mc_trigger_rollup.** Context document pipeline integration.

7. **Phase 4 tools: mc_search_sessions, mc_get_session_summary.** Session history search.

8. **Migrate existing direct integrations.** Move eval sub-agent gatherers, context doc extraction, and Quality Rules actions to use MCP tools instead of direct function calls.

Phase 1 is the priority — it solves the immediate pain. Each subsequent phase adds value independently and can be built when the need is felt rather than speculatively.

---

## Open Questions

1. **MCP transport.** MCP supports stdio and SSE transports. For Claude Code connecting to a local Mission Control instance, stdio is simpler. For remote connections (CI systems, webhooks), SSE is necessary. Suggest starting with SSE since Mission Control is a web application and SSE works for both local and remote callers.

2. **Concurrent planning queries.** If two Claude Code sessions ask planning questions simultaneously, each gets its own planning session. But if both questions touch the same architectural topic, they might produce contradictory answers. Acceptable for now — the decisions log makes contradictions visible and the user resolves them in review. Long-term, a locking or sequencing mechanism might be needed for high-stakes decisions.

3. **Planning agent model.** Planning sessions default to Sonnet (same as eval judges). For complex architectural questions, Opus might produce significantly better answers. Configurable per-project in `.mission-control.yaml`, with a per-call override in `mc_start_session`? Or keep it simple and use one model?

4. **Rate limiting on session creation.** Claude Code could theoretically spin up dozens of planning sessions if poorly prompted. Per-project rate limit (e.g., 10 planning sessions per hour) prevents runaway cost without being restrictive enough to interfere with normal use.

5. **Session reuse vs. session-per-question.** Should Claude Code reuse a single planning session for multiple questions during its work, or start a new session for each question? Reuse is cheaper and maintains conversational context. New-session-per-question is simpler and produces cleaner decision log entries. Suggest: reuse within a single Claude Code session, new planning session when a new Claude Code session starts.

---
---

# Context Document Generation — Specification (Updated)

## Purpose

Automatically generate and maintain two living context documents for every Mission Control project: **PRODUCT.md** (what the project does, who it serves, key product decisions) and **ARCHITECTURE.md** (system boundaries, data model, patterns, technical decisions). These documents are consumed by Claude Code sessions at startup so agents can resolve their own product and architectural questions without ferrying them to the user. When the documents don't cover a question, the agent escalates to a planning session via the Mission Control MCP server — not to the user.

## Problem

Agent sessions within a project operate without shared memory. They don't know what previous sessions decided, what approaches were tried and abandoned, or why the system is shaped the way it is. This causes two expensive failure modes: agents ask the user questions that were already answered in previous sessions, and agents make decisions that contradict earlier architectural choices they don't know about.

The user currently bridges this gap manually — copying questions from Claude Code to a planning context, copying answers back, and maintaining mental context across dozens of sessions and hundreds of PRs. This doesn't scale and is the primary bottleneck in the user's workflow.

The context documents are the first line of defense (self-service knowledge). The Mission Control MCP server's planning sessions are the second line (escalation without involving the user). The user is the third line (async review of decisions made by the first two lines).

## Scope

Covers the bottom-up document generation pipeline (per-PR extraction, roll-up synthesis, human review), the incremental update mechanism, the integration with Mission Control's project entity, and how the pipeline uses the Mission Control MCP server for session management. The MCP server itself is specified in the companion spec above.

---

## Core Approach: Bottom-Up Extraction and Roll-Up

A single agent reading an entire project's history (100+ PRs, thousands of commits) will either hit context limits, skim shallowly, or silently drop older material. The correct approach is bottom-up: extract structured knowledge from each PR individually, then synthesize those extractions into coherent documents.

### Layer 1: Per-PR Extraction

For each PR in the project's history, a small focused LLM call reads the PR and extracts structured knowledge.

Each extraction runs as a Mission Control session via the MCP server: `mc_start_session` with session_type "extraction". This means every extraction is logged, visible in the dashboard, and follows the same sandboxing rules as all other sessions. The extraction session is short-lived (typically under 30 seconds), read-only, and uses Sonnet (see Slice 3 Implementation Notes below — Haiku was originally proposed but Sonnet was chosen for extraction quality).

**Inputs to the extraction call:**

- PR title and description
- The diff (or a summarized diff if the raw diff exceeds context limits)
- Review comments and discussion
- Commit messages within the PR

**Output of the extraction call — a structured summary:**

- **What changed:** one-paragraph description of the change
- **Why it changed:** motivation, bug being fixed, feature being added, refactor rationale
- **Product decisions:** any product-level choices visible in the PR (new feature behavior, user-facing changes, scope decisions, things explicitly descoped)
- **Architectural decisions:** any technical choices visible in the PR (new patterns introduced, libraries added, data model changes, API design choices, performance tradeoffs)
- **Patterns established:** conventions set by this PR that future work should follow (naming conventions, file organization, error handling approaches, testing patterns)
- **Patterns broken:** previous conventions this PR departs from, and why
- **Files touched:** list of files modified, added, or deleted (used for indexing)

**Characteristics of this call:**

- Small context window — a single PR's content, not the whole repo
- Narrow task — extraction, not synthesis or judgment
- Highly parallelizable — all PRs can be processed concurrently
- Cheap per call — short input, short structured output
- Idempotent — re-running on the same PR produces the same extraction

**Handling large diffs:** If a PR's raw diff exceeds 50KB, summarize the diff before extraction: group changes by file, describe the nature of each file's changes (added function X, modified class Y, deleted module Z) rather than including line-by-line content. The extraction call needs to understand what changed and why, not read every line.

**Handling PRs with no meaningful decisions:** Many PRs are mechanical — dependency bumps, typo fixes, CI config changes. The extraction call should recognize these and produce a minimal summary ("dependency update, no product or architectural decisions") rather than hallucinating significance. The roll-up layer filters these out.

### Layer 2: Roll-Up Synthesis

Takes all per-PR extractions for a project and synthesizes them into draft PRODUCT.md and ARCHITECTURE.md documents.

Each roll-up runs as a Mission Control session via the MCP server: `mc_start_session` with session_type "extraction" and a longer timeout (5 minutes). Uses a mid-tier model (Sonnet-class) since synthesis requires more reasoning than per-PR extraction.

**Chunking strategy:** If the project has more than 25 PRs, the roll-up processes extractions in chronological batches of 25. Each batch produces an intermediate synthesis. A final synthesis pass merges the intermediate documents into the final drafts. This two-level roll-up keeps each LLM call within comfortable context limits.

**What the roll-up call does:**

- Identifies recurring themes across extractions (e.g., "pagination handling came up in PRs #12, #34, #67, and #89 — the final approach is X")
- Resolves contradictions (PR #47 introduced pattern A, PR #83 replaced it with pattern B — the current state is B)
- Separates product knowledge from architectural knowledge into the two documents
- Filters out mechanical PRs that don't contribute to either document
- Organizes knowledge into coherent sections rather than chronological order
- Notes areas of uncertainty where the PR history doesn't tell the full story (flagged for human review)
- Incorporates knowledge from planning session decision logs (if any exist) — these capture product and architectural decisions that were made outside of PRs

**Output: two draft documents.**

**PRODUCT.md draft structure:**

- Project purpose and scope — what this system does and who it serves
- Key user-facing features and their current state
- Product decisions and their rationale — the "why" behind feature choices
- Scoping decisions — things explicitly excluded and why
- Current priorities and known gaps

**ARCHITECTURE.md draft structure:**

- System overview — major components and how they connect
- Data model — key entities, relationships, and storage decisions
- Established patterns — conventions that all sessions should follow (naming, error handling, file organization, testing approach)
- Anti-patterns — approaches that were tried and abandoned, and why
- Integration points — external services, APIs, databases, and how they're accessed
- Key technical decisions and their rationale

### Layer 3: Human Review

The draft documents are presented to the user for review. The user:

- Corrects factual errors (the roll-up may misinterpret a PR's intent)
- Fills gaps from knowledge that doesn't live in PRs (verbal decisions, strategic context, information from planning conversations)
- Adjusts emphasis (the roll-up treats all decisions equally; the user knows which ones matter most)
- Removes noise (extractions that made it through the filter but aren't worth preserving)

After review, the documents are committed to the project repo at the root level alongside `.mission-control.yaml`.

---

## Incremental Updates

After initial generation, the documents stay current through three mechanisms.

### Automatic: New PR Extraction on Merge

When a PR is merged in a Mission Control project, the per-PR extraction runs automatically via `mc_trigger_extraction` (called by the PR-merge webhook). The extraction is stored in Mission Control's database, linked to the project.

### Automatic: Planning Session Decision Integration

When a planning session completes (triggered by Claude Code via `mc_start_session`), the Q&A is logged to the project's decisions file. The next roll-up incorporates these decisions as an additional knowledge source alongside PR extractions. This means architectural and product decisions made through the MCP planning flow automatically feed back into the context documents without any manual documentation step.

### Periodic: Roll-Up Refresh

On a configurable schedule (default: weekly) or on manual trigger (via `mc_trigger_rollup` from the dashboard or from a scheduled job), a roll-up runs that:

- Reads the current PRODUCT.md and ARCHITECTURE.md
- Reads all new PR extractions since the last roll-up
- Reads all new planning session decision log entries since the last roll-up
- Produces an updated draft that integrates new knowledge into the existing documents
- Presents the diff to the user for review (not the full document — just what changed)

The periodic roll-up is a lighter operation than initial generation because it's incremental — it only processes new extractions and decisions against existing documents rather than synthesizing everything from scratch.

### Agent-Driven: Session-End Updates

When a Claude Code session makes a significant architectural or product decision during its work, it should append to the relevant context document as part of its cleanup. This is not enforced by Mission Control — it's an instruction in the session's system prompt: "If you made architectural decisions during this session that future sessions should know about, append them to ARCHITECTURE.md before closing."

This is the fastest update path but the least reliable — agents may forget, may misjudge significance, or may write unclear entries. The periodic roll-up catches and cleans up anything the session-end updates missed or mangled.

---

## Integration With Mission Control

### Project Entity

The context documents are stored in the project repo, not in Mission Control's database. Mission Control's project entity tracks:

- Whether initial generation has been completed for this project
- Timestamp of the last roll-up
- Count of unprocessed PR extractions since last roll-up
- Count of unprocessed planning session decisions since last roll-up
- Path to PRODUCT.md and ARCHITECTURE.md (defaults to project root, configurable in `.mission-control.yaml`)

### Session Startup

When a new session starts in a project (whether via dashboard or via `mc_start_session` MCP call), Mission Control includes PRODUCT.md and ARCHITECTURE.md in the session's initial context. The session prompt instructs the agent: "These documents describe the product intent and architectural decisions for this project. Consult them before asking the user product or architecture questions. If the documents don't answer your question, use mc_start_session to ask a planning session rather than asking the user."

### Dashboard

The Mission Control dashboard shows, per project:

- Whether context documents exist and when they were last updated
- How many PR extractions are pending roll-up
- How many planning decisions are pending roll-up
- A button to trigger initial generation (for new projects) or a manual roll-up (for existing projects)
- A link to view the current documents
- A link to view the planning decision log

---

## Extraction Prompt

The per-PR extraction call uses a standard prompt. The prompt is maintained in Mission Control's codebase, not per-project — extraction format should be consistent across all projects.

The prompt instructs the model to:

- Read the PR title, description, diff, review comments, and commit messages
- Extract the structured summary fields described in Layer 1
- Be conservative — only record decisions that are clearly present in the PR, don't infer intent
- Mark mechanical PRs (dependency bumps, typo fixes, CI changes) as "no significant decisions" rather than inventing significance
- Keep each field concise — one to three sentences per field, not paragraphs
- Use the project's own terminology (don't normalize or generalize names)

## Roll-Up Prompt

The roll-up synthesis call uses a standard prompt with project-specific context injected. The prompt instructs the model to:

- Read all PR extractions (or the batch being processed)
- Read all planning session decision log entries within the batch's time window
- For initial generation: produce complete PRODUCT.md and ARCHITECTURE.md drafts
- For incremental updates: read the existing documents and produce a revised version integrating new extractions and decisions
- Resolve contradictions by favoring the most recent source (the latest PR or decision wins)
- Organize by topic, not by chronology — the output is a reference document, not a history
- Flag areas of uncertainty with inline markers (e.g., "[REVIEW: unclear whether this pattern is still in use]") for human review
- Exclude mechanical changes that don't contribute product or architectural knowledge

---

## The Knowledge Lifecycle

Putting the MCP server and context document pipeline together, knowledge flows through the system in a closed loop:

1. **Agent works.** A Claude Code session implements a feature, makes decisions, opens a PR.

2. **Decisions get captured.** Product and architectural questions route to planning sessions via MCP. The Q&A pairs log to the decisions file. The PR captures the code-level decisions.

3. **Knowledge gets extracted.** On PR merge, per-PR extraction pulls structured knowledge. Planning session decisions are already logged.

4. **Knowledge gets synthesized.** Periodic roll-up merges PR extractions and planning decisions into PRODUCT.md and ARCHITECTURE.md.

5. **Future agents consume the knowledge.** New sessions load the context documents at startup. Questions the documents answer get resolved without involving the user or even a planning session. Questions they don't answer escalate to a planning session, which logs a new decision, which feeds back into the next roll-up.

6. **The user reviews asynchronously.** The decisions log and roll-up diffs surface what the system decided. The user corrects, adjusts, and fills gaps on their own schedule.

The loop is self-improving: every question an agent asks that the documents can't answer becomes a decision that gets folded into the documents, so the next agent with the same question resolves it locally. Over time, the documents get richer and the planning session volume decreases.

---

## Handling Edge Cases

**Projects with no PRs (new projects).** Initial generation falls back to repo analysis: read the codebase structure, any existing README or docs, `.mission-control.yaml`, and produce thin draft documents from what's available. These will be sparse and heavily dependent on human review to fill in.

**Projects with very large PRs (1000+ line diffs).** The diff summarization strategy from Layer 1 applies: group changes by file, describe the nature of changes, don't attempt line-by-line analysis. The extraction call needs the "what and why," not every detail.

**Projects where critical decisions were made outside PRs.** This is common — decisions made in Slack, in planning conversations, in the user's head. The human review step is where these get added. The periodic roll-up preserves them — it integrates new PR extractions into existing documents, it doesn't overwrite manual additions. With the MCP planning session flow, more of these decisions get captured automatically as agents ask questions and receive answers.

**Multiple contributors.** The extraction is PR-scoped, not author-scoped. Review comments from multiple people are included in the extraction input. The roll-up doesn't attribute decisions to individuals — it captures what was decided, not who decided it.

**Conflicting decisions across PRs.** The roll-up resolves by recency: the latest PR's approach is treated as current. Earlier approaches are noted in the "anti-patterns" or "approaches tried and abandoned" section of ARCHITECTURE.md if they're instructive.

---

## Build Order

Context document generation depends on the MCP server for session management. Build order accounts for this dependency.

1. **MCP server Phase 1 (from companion spec).** mc_start_session, mc_send_message, mc_get_session_status. This is the prerequisite — extraction and roll-up sessions run through MCP.

2. **Per-PR extraction prompt and runner.** A standalone function that takes a PR's content, calls mc_start_session with session_type "extraction", and returns a structured extraction. Test against 10-15 real PRs from existing projects to validate extraction quality before scaling.

3. **Batch extraction runner.** Parallelizes Layer 1 across all PRs in a project via concurrent mc_start_session calls. Stores extractions in Mission Control's database linked to the project.

4. **Roll-up synthesis prompt and runner.** Takes extractions, calls mc_start_session with session_type "extraction", and produces draft documents. Test against the batch output from step 3.

5. **Chunked roll-up for large projects.** Batch-of-25 processing with intermediate synthesis for projects exceeding 25 PRs.

6. **Human review flow.** Dashboard UI to view drafts, edit inline, and commit to the repo.

7. **Automatic extraction on PR merge.** PR-merge webhook calls mc_trigger_extraction via MCP.

8. **Planning session decision integration.** Roll-up reads from the decisions log (populated by MCP planning sessions) as an additional knowledge source.

9. **Periodic roll-up with incremental updates.** Scheduled or manually triggered via mc_trigger_rollup, processes new extractions and decisions against existing documents.

10. **Session startup integration.** Automatic loading of context documents into new session context, with instructions to use MCP planning sessions as escalation path.

---

## Open Questions

1. **Extraction model choice.** Per-PR extraction is high-volume, low-complexity. A fast, cheap model (Haiku-class) is probably sufficient. Roll-up synthesis requires more reasoning and should use a mid-tier model (Sonnet-class). Worth validating extraction quality with Haiku before committing.

2. **Storage of extractions.** Stored in Mission Control's database, or as files in the repo (e.g., `.mission-control/extractions/pr-247.yaml`)? Database is cleaner for querying; files are more portable and version-controlled. Suggest database for extractions (they're intermediate artifacts) and repo for the final documents (they're project knowledge).

3. **Extraction for non-PR changes.** Some projects use direct pushes to main rather than PRs. Should the extraction also run on commits that don't have associated PRs? Probably yes, using the commit message and diff as input instead of PR metadata. But PR-based extraction is higher quality because PR descriptions contain richer context than commit messages.

4. **Cost projection.** For a project with 100 PRs, initial generation is roughly 100 extraction calls (Haiku-class, cheap) plus 4-5 roll-up calls (Sonnet-class, moderate). Estimate total cost before running the first full generation so the user can make an informed decision. Add planning session cost projections once MCP planning queries are active.

5. **Freshness signal.** Should the dashboard warn when context documents are stale (many unprocessed extractions or decisions pending roll-up)? Probably yes — a simple count of "X new PRs and Y new decisions since last update" with a threshold-based warning.

6. **Decision log format.** The planning session decisions log needs a format that's both human-readable (for async review) and machine-parseable (for roll-up ingestion). Suggest structured markdown with clear delimiters, similar to the eval YAML format but more prose-friendly.

---

## Slice 3 Implementation Notes (decided 2026-04-26)

The slice-3 build narrows the spec above to the minimum viable "kick it off and watch it run" experience. These notes are deltas to apply to the spec; they don't replace it.

1. **Trigger.** Manual only — a "Generate Context Docs" button on each project's detail page. No PR-merge webhook, no scheduled job, no automatic rollup in this slice. Subsequent slices can add automation.

2. **Inputs.** Closed and merged PRs from the project's GitHub repo, fetched in batches via the GitHub REST API. The decision log (`docs/decisions.md`) is **not** read in this slice — the system is brand new and the log is empty everywhere.

3. **Extraction model.** Sonnet (`claude-sonnet-4-5` via the LLM gateway), not Haiku. Resolves open question #1.

4. **Roll-up.** Sonnet for both intermediate (batch-of-25) and final synthesis. Two-level roll-up only when PR count exceeds 25; otherwise a single rollup pass.

5. **Output.** Generated `PRODUCT.md` and `ARCHITECTURE.md` are written to the project's repo root (`projects.root_path`), overwriting any existing copies. In practice these files don't exist yet for any project, so this is initial generation everywhere.

6. **Storage of intermediate extractions.** Mission Control's database (new `context_doc_extractions` table), keyed by project_id and pr_number. Idempotent — re-running the button skips PRs that already have an extraction unless explicitly cleared.

7. **Job tracking.** New `context_doc_runs` table modeled on `test_runs`. One row per click. Tracks phase (`fetching` | `extracting` | `rolling_up` | `finalizing` | `completed` | `failed`), counts (PRs total / PRs extracted / batches total / batches done), and error info on failure.

8. **Progress UI.** Status panel in place of the button while a run is active. Shows phase label, progress counts, and an expandable live log. Updates push over the existing WebSocket using the same broadcast pattern as `testRunRecorder`. Done state shows last-generated timestamp and links to the two markdown files.

9. **Concurrency.** One context-doc run per project at a time. The button is disabled while a run is in progress for that project. Different projects can generate in parallel.

10. **Failure recovery.** If a run fails partway, the cached per-PR extractions remain in the DB. Retry button restarts the run — already-extracted PRs are skipped, only the missing ones plus the rollup re-execute.

11. **Routing through MCP.** Slice 3 calls the underlying extraction and rollup services directly from server code rather than self-calling its own MCP endpoints over HTTP. The MCP tools (`mc_trigger_extraction`, `mc_trigger_rollup`) can be wired up in a later slice as thin wrappers over the same internal services.
