# Architecture

> Auto-generated from PR history. Edit freely — future roll-ups will preserve manual additions.

## System overview

Mission Control is a web-based dashboard for managing remote Claude Code sessions. The system uses a three-tier architecture:

- **Backend**: Express/Node.js server on port 3000 (configurable via PORT env var) with Neon serverless Postgres database
- **Frontend**: React 18 SPA built with Vite, served on port 5173 (configurable via VITE_PORT), with client-side routing via react-router-dom
- **Process orchestration**: Sessions spawn inside tmux using Claude CLI, with file-based output tailing and WebSocket streaming to clients

Sessions persist across server restarts via tmux wrapping. The backend spawns Claude CLI processes with tmux, tails output files, and broadcasts events over WebSocket. The frontend displays real-time chat, file trees, preview panels, and quality analytics. All AI calls (session naming, quality checks, evals) route through centralized LLM Gateway service at https://llm-gateway.replit.app using OpenAI-compatible chat completions format (#41, #44).

Mobile support via PWA with responsive breakpoint at 768px and context-aware navigation showing Dashboard+Settings or Chat+Files+Preview depending on location (#3, #19, #128).

## Data model

### Core tables

**sessions**: id, name (AI-generated via Claude Haiku after first user message), project_id (nullable FK to projects), session_type (manual, implementation, planning, extraction, eval_gatherer, spec_refinement, qa_design, implementation_planning, qa_execution, code_review), status (idle, working, reviewing, waiting_for_owner, ended, error), model (claude-opus-4-7 default), permission_mode (acceptEdits default), effort_level (low/medium/high/xHigh, with xHigh restricted to Opus 4.7), working_directory, worktree_name (extracted from path via regex), cli_session_id (persisted for resumption), has_spec (INTEGER boolean), lines_added/lines_removed (diff tracking), created_at, last_activity_at (#1, #18, #22, #47, #74, #126, #145, #173, #183)

**messages**: id, session_id FK, role (user/assistant), content (sanitized of sub-agent tool transcripts and hallucinated harness tags), attachments (JSON array), message_id (Anthropic message.id for streaming), timestamp (#1, #24, #150, #152, #185)

**queued_messages**: session_id FK, content, attachments (JSON), queued_at; in-memory queue stores {content, attachments, queueId} objects synchronized via WebSocket events (#154)

**stream_events**: session_id FK, event_type, event_data (JSON), timestamp; capped at 500 entries per session; replayed on resume to initialize CLI panel dedup state (#42, #59)

**projects**: id, name, root_path (used for case-insensitive longest-match project discovery), github_repo, description, deploy_config (JSON), seed_version (for quality rule updates), created_at (#1, #14, #53, #158)

**quality_rules**: id, name, description, prompt, fires_on (8 supported events: PRCreated, session_end, pr_updated, etc.), severity (info/warning/error), enabled (INTEGER boolean), send_fail_to_agent, send_fail_requires_spec, execution_mode (cli/api), tools (JSON array for agent-type checks), sort_order, seed_version (#2, #9, #40, #44, #46, #57, #80)

**quality_results**: session_id FK, rule_id FK, status (running/passed/failed), analysis (expandable when present), details, timestamp (#35, #61, #62)

**slash_commands**: id, name (unique), message, sort_order, created_at (#79)

**eval_batches**: id, project_id FK, trigger (session_end/pr_updated), status (pending/running/completed/failed), created_at (#111)

**eval_runs**: batch_id FK, eval_folder_path, verdict (pass/fail/error), evidence (JSON), created_at (#111)

**test_runs**: id, session_id FK, project_id FK, status (detecting/parsing/completed/failed), command, summary, passes/failures/skips, raw_output (truncated head+tail), created_at; bounded per-session map (MAX_PENDING_PER_SESSION=50) prevents memory leaks (#153)

**context_doc_runs**: id, project_id FK, phase (extracting/rolling_up/completed/failed), pr_count, cached_count, created_at (#155, #160)

**context_doc_extractions**: run_id FK, pr_number, extraction (JSON with product_themes/architectural_decisions/superseded/mechanical_only/uncertainty), created_at (#155)

**mcp_tokens**: id, token_hash, description, created_at; app-wide bearer tokens for MCP tool authentication (#147)

**planning_questions**: id, project_id FK, asking_session_id FK, planning_session_id FK (nullable), question, owner_answer (nullable), status (escalated/answered/dismissed), decided_by (agent/owner), created_at (#145, #151)

**decision_chats**: id, subject_type (planning_escalation/pipeline_stage_approval), subject_id, messages (JSON array), created_at (#171)

**pipelines**: id, project_id FK, spec_file_path, status (spec_refinement/qa_design/implementation_planning/building/qa_execution/code_review/completed/failed), current_stage (1-7), fix_cycle_count (capped at 3), gated_stages (JSONB array), branch_name (pipeline-\<slug\>-\<8-char-id\>), pr_url, pr_creation_error, created_at (#159, #165, #177, #179, #184)

**pipeline_stage_outputs**: pipeline_id FK, stage (1-7), output (text), rejection_feedback (audit trail), completed_at (#165, #171)

**pipeline_stage_prompts**: pipeline_id FK, stage (1-7), prompt (copy-on-write from templates), saved_at (#165)

**pipeline_chunks**: pipeline_id FK, chunk_number, description, status (pending/working/done/failed), session_id FK (nullable), created_at (#169)

**pipeline_escalations**: pipeline_id FK, stage, reason, created_at (#177)

### Relationships and patterns

- projects ← sessions (optional FK; sessions can exist without linked project via filesystem discovery)
- sessions → messages, stream_events, queued_messages, quality_results, test_runs (one-to-many)
- quality_rules → quality_results (referenced but not FK to avoid deletion cascade)
- eval_batches → eval_runs (one-to-many)
- projects → eval_batches, context_doc_runs, pipelines (one-to-many)
- pipelines → pipeline_stage_outputs, pipeline_stage_prompts, pipeline_chunks, pipeline_escalations (one-to-many)
- Polymorphic decision_chats via subject_type/subject_id supports both planning escalations and pipeline stage approvals (#171)

All timestamps use TIMESTAMPTZ with automatic conversion for existing TEXT columns (#53). Database query wrapper passes `{ fullResults: true }` to expose rowCount metadata for UPDATE/DELETE validation (#125).

## Established patterns

### Claude CLI invocation

Sessions spawn via tmux with arguments: `--model`, `--permission-mode` (acceptEdits/plan/auto), `--effort-level` (low/medium/high/xHigh), `--worktree` (for isolation), `--mcp-config` (JSON file path for server configs), `--resume` (with cli_session_id for resumption), `--allowedTools` (for restricted sub-agents) (#2, #7, #11, #57, #126, #183). POSIX `--` separator before prompt argument prevents `--` prefixes in prompts from being parsed as flags (#156).

Session types determine behavior: implementation sessions run quality checks, planning/extraction/eval_gatherer sessions skip quality review loop, pipeline stages use type-specific timeouts and permission modes (#145, #173). Plan mode enforcement on resumed sessions uses prompt prefix injection since CLI ignores `--permission-mode` flag on `--resume` (#76).

### Session lifecycle

1. **Creation**: async INSERT to database, in-memory status takes precedence over DB with automatic reconciliation; worktree_name extracted during init event via regex `/\.claude\/worktrees\/([^/]+)/`; auto-naming validates ≤8 words, ≤60 chars (#26, #28, #33, #104)
2. **Execution**: tmux send-keys for input, file-based output tailing (100ms polling), WebSocket streaming to clients; turn boundary detection resets on tool_result events; assistant message upsert (INSERT on first event per turn, UPDATE on subsequent events) indexed by Anthropic message.id (#12, #103, #150)
3. **Quality checks**: server-side execution watching streaming events, run in parallel via Promise.all, broadcast quality_running/quality_checks_done events, persist to quality_results table, 3-iteration cap with reset on manual user message (#35, #66, #75, #82)
4. **Resumption**: builds context preamble from summary + key_decisions + original task + modified files + last 5 exchanges + git status; queries stream_events_history before resuming to initialize client dedup; restores cli_session_id for proper CLI resumption (#12, #59, #183)
5. **Recovery**: recoverTmuxSessions() on startup reconnects to active tmux sessions, awaited before HTTP server starts listening; safety-net timer (5 seconds) prevents stuck "working" state; stale status detection compares DB against in-memory process state (#64, #180)
6. **Cleanup**: worktree sessions auto-delete clean worktrees on end; uncommitted changes trigger modal (commit & keep branch / delete everything / leave as-is); GitHub PR detection warns before deletion (#101, #107)

Session event listener registration happens once per WebSocket connection to prevent duplicate messages (#65). The `_sessionCompleteEmitted` flag prevents duplicate session_complete events during quality-review respawns (#174).

### WebSocket architecture

Single shared connection managed by AppContext with explicit subscribe_session/unsubscribe_session messages instead of per-session connections (#53). WebSocket URL derived from `window.location.host` to inherit protocol/hostname and route through Vite dev proxy, with `*.ts.net` allowed for Tailscale support (#129).

Event types: session_name_updated, user_message, cwd_update, error, quality_result, quality_running, quality_checks_done, reviewing (session status), message_queued, message_dequeued, message_deleted, decisions_changed (with source discriminator), test_run_started, test_run_completed, pipeline events (#18, #25, #75, #89, #92, #153, #171).

Safety-net timers for critical state transitions; session-specific subscriptions; reconnect behavior merges messages instead of clearing; dbEventCountRef prevents duplicate replay of historical events (#64, #129).

### Quality rules system

**Trigger detection**: composite triggers like PRCreated detect command patterns (gh pr create, git push) in Bash tool usage server-side rather than as Claude hooks; fires_on validates against 8 supported events (#80, #81, #46).

**Execution modes**: 'cli' mode uses free Claude CLI agent via cliAgent.js (execFile with 1MB buffer, 2-minute timeout); 'api' mode uses LLM Gateway with Sonnet; per-rule backend selection via execution_mode column (#44, #57).

**Agent capabilities**: agent-type checks get git context (recent commits, last commit diff/stat) and tool access via --allowedTools flag; longer timeout (180s vs 120s); sub-agent sandboxing restricts to Read/Glob/Grep/Bash read-only in plan-only mode (#57, #111).

**Enforcement**: send_fail_to_agent collects failures and sends to agent after 500ms delay; send_fail_requires_spec skips when no spec present; spec detection follows two-tier fallback (on-disk files spec.md/SPEC.md, then message attachments); has_spec flag persisted on first user message (#40, #63, #74).

**Cancellation**: AbortController threads through qualityRunner.js → cliAgent.js → llmGateway.js for mid-execution cancellation; visible "Cancel" button sends SIGTERM to subprocess and cancels fetch (#91, #94).

**Working directory resolution**: checks toolInput.file_path first, falls back to session's working_directory for tools without file_path (#83).

Rules cached with 30-second TTL; manual play buttons run individual rules on demand; scrollable list UI (#53, #118).

### Merge-field system

Centralized in server/services/mergeFields.js with registry pattern; resolvers are async functions returning string | null; placeholders like {{last_pr}} resolved dynamically in chat messages and quality rule prompts before spawning CLI (#126).

### File operations and security

**Path safety**: safeResolvePath validates all user-supplied file paths stay within home directory, returns null for invalid; isSafeEvalPath/isSafeFolderPath check paths start with project root and handle sibling prefix attacks (#53, #97, #116).

**Inline editing**: PUT /api/files/content with path validation, existence check, git status refresh after saves; Cmd+S save shortcut; supports text/markdown/HTML with syntax highlighting (#98).

**Attachments**: stored in /uploads with sanitized filenames (crypto.randomBytes prefix), metadata as JSON in messages.attachments column; 20MB limit, image thumbnails, directory traversal protection (#24, #53).

**Git operations**: all use execFileSync with argument arrays instead of shell strings to prevent command injection; async exec with Promise.all parallelization for getGitPipeline; 10-second TTL cache for pipeline results; worktreeReady flag gates computation until CLI init event (#32, #53).

### Evals system

**Architecture**: Evidence → Checks → Judge pipeline; gathers evidence from session logs, build output, PR diffs, database queries, and sub-agents; runs automated checks (equals, contains, greater_than, less_than, numeric_score with JSON field extraction); uses LLM judge for final verdict (#111, #115).

**Sub-agent isolation**: enforced sandboxing with restricted tool set (Read, Glob, Grep, Bash read-only), plan-only permission mode, no MCP, scoped cwd; path safety validation throughout (#111, #116).

**Triggers**: folder-based organization; trigger-based execution (session_end, pr_updated); PR watcher polls GitHub via `gh pr list` every 2 minutes (#111).

**UI workflow**: Quality tab with drill-down views, low-confidence indicators, configurable retention; folder/eval creation directly from UI with comprehensive validation; AI-assisted authoring with natural language descriptions, draft-review-publish workflow, preview runs, iterative refinement; WebSocket broadcast for real-time progress (#111, #116, #120).

**Creation validation**: loads through evalLoader after writing; invalid files deleted and return 400 (#116).

### MCP server (Mission Control)

**Protocol**: JSON-RPC 2.0 over HTTP (not stdio/SSE) at `/api/mcp/rpc` endpoint; app-wide bearer auth via mcp_tokens table; Claude Desktop support via mcp-stdio-bridge.js translating stdio to HTTP (#145, #147, #167).

**Tools** (13 total):
- `mc_list_projects` — list all projects with metadata (name, repo, description, existence flags for PRODUCT.md/ARCHITECTURE.md/decisions.md)
- `mc_get_project_context` — fetch PRODUCT.md/ARCHITECTURE.md/decisions.md; returns {exists, path, content} tuples for missing files instead of throwing
- `mc_list_project_files` — browse file tree with configurable depth (default 3, max 10)
- `mc_read_project_file` — read contents with 1MB cap, binary detection via NUL-byte heuristic on first 4KB
- `mc_write_project_context` — write (create or replace) PRODUCT.md/ARCHITECTURE.md only
- `mc_start_session` — start new session with session_type parameter
- `mc_send_message` — send message and synchronously wait for response via sendAndAwait pattern listening for session events
- `mc_get_session_status` — check session status (returns status='waiting_for_owner' or owner_answer during escalation)
- `mc_start_pipeline` — accepts spec_file parameter with path traversal validation and MIME/extension checks for .md/.txt/.markdown files up to 512KB
- `mc_get_pipeline_status` — get pipeline state: status, current stage, stage outputs, chunk progress, fix cycle count, escalations
- `mc_approve_stage` — approve paused stage to advance
- `mc_reject_stage` — reject stage and re-run with feedback
- `mc_recover_pipeline` — reconcile interrupted pipeline (#145, #147, #164, #169, #175, #182)

All file paths validated via resolveProjectPath() against project root_path; all tools except mc_list_projects require explicit project_id argument (#182).

**Bridge implementation**: mcp-stdio-bridge.js uses readline interface for line-delimited JSON-RPC, tracks pending requests for clean shutdown, handles notifications/initialized by returning undefined; reads token/URL from environment variables (#167).

### Pipelines system

**Architecture**: three-tier design with pipelineRepo (persistence), pipelineOrchestrator (stage transitions + gating), pipelineRuntime (branch creation + WebSocket broadcasts); unique branch names pipeline-\<slug\>-\<8-char-id\> prevent collisions (#159, #165, #184).

**Stages**:
1. Spec Refinement (gated by default)
2. QA Design (gated by default)
3. Implementation Planning (gated by default, parses build plan into chunks on approval)
4. Building (autonomous, executes chunks serially)
5. QA Execution (autonomous, uses output parsing to route)
6. Code Review (autonomous, read-only 'plan' permission mode)
7. Completed (#159, #165, #177)

**Gating model**: `gated_stages` JSONB column with default [1,2,3]; GATEABLE_STAGES constant [1,2,3,5,6]; normalizeGatedStages validation/deduplication; per-pipeline isGatedStage lookup; sessions close on transition except during approval pauses (#176, #177).

**Fix cycles**: cap at 3 iterations before escalation; QA/review use output parsing (parseQaOverall, parseReviewBlockers); fix cycles tracked in pipeline.fix_cycle_count (#174, #177).

**Prompts**: copy-on-write from templates to pipeline_stage_prompts table; buildPipelineStagePrompt constructs stage-specific prompts; PUT /api/pipelines/:id/prompts/:stage updates (#165, #171).

**Chunks**: stage 4 parses build plan into pipeline_chunks table executed serially; chunk status (pending/working/done/failed); recovery resets stage-4 chunks to pending (#169, #175).

**Escalations**: pipeline_escalations table records stalls; escalation parser detects ESCALATE block; status='waiting_for_owner' during escalation (#151, #177).

**Recovery**: automatic sweep on startup marks orphaned 'working' sessions as 'ended'; re-enters orchestrator flow; exposed as manual API endpoint and MCP tool with dependency injection for testing (#175).

**PR creation**: orchestrator invokes pipelinePrCreator at transition to completed status; auto-PR-creation errors stored in pipelines.pr_creation_error without blocking completion; /api/pipelines/:id/create-pr endpoint and orchestrator.tryCreatePullRequest() enable manual retry; buildPrBody factored as pure function (#179, #184).

**State representation**: describeState() pure function maps pipeline.status to { tone, label }; STAGE_NAMES constant (1: 'Spec Refinement', 2: 'QA Design', etc.); tone-coded UI pills (.tone_success, .tone_info, .tone_warn, .tone_error, .tone_muted); "What happened" summary panel with dl/dt/dd grid layout showing outcome, PR status, branch links, stage progress, fix cycles (X of 3 used), timing (#186).

### Planning sessions and decisions

**Orchestration**: planningSessionOrchestrator.js handles escalation detection, context loading (PRODUCT.md, ARCHITECTURE.md), prompt construction, decision-log appends; planning sessions run read-only (permission_mode 'plan'); decisions.md format locked (timestamp, asking_session_id, planning_session_id, working_files, question, answer) (#145, #151).

**Escalation workflow**: escalationParser detects ESCALATE block → question marked status='escalated' → owner answers via POST /api/planning/escalations/:id/answer → decisionLog writes with decided_by='owner' → contextDocAppender optionally appends to PRODUCT.md/ARCHITECTURE.md (#151).

**Decision chats**: polymorphic decision_chats table with subject_type/subject_id supports both planning escalations and pipeline stage approvals; chat uses buildPipelineStagePrompt and draftStageFeedback; rejection_feedback column on pipeline_stage_outputs for audit trail (#171).

**Unified dashboard**: groups planning escalations and pipeline stage approvals by project; LLM thinking-partner chat threads for each decision; decisions_changed WebSocket event with source discriminator (#163, #171).

Rate limits and timeouts removed for planning sessions (tmux CLI processes); replaced active enforcement with passive usage tracking via /api/planning/usage (#151).

### Context doc generation

**Architecture**: per-PR extractions cached in context_doc_extractions table using Sonnet (claude-sonnet-4-5); batched roll-up in chunks of 25 PRs; context_doc_runs table tracking phase/counts modeled on test_runs; WebSocket progress broadcasts (#155, #160, #166).

**PR fetching**: GitHub PR fetching via gh CLI with 50KB diff truncation; GitHub repo detection uses git remote fallback before throwing NO_GITHUB_REPO; strict JSON schema enforcement with fallback parsing for markdown-fenced responses; structured normalizeExtraction coercion (#155, #157).

**Output format**: delimiter-based markdown blocks (===BEGIN/END===) instead of JSON-escaped strings; FINAL_MAX_TOKENS raised from 8000 to 12000; three-file output (PRODUCT.md, ARCHITECTURE.md, architecture-record.txt) (#166).

**Retry behavior**: idempotent retry with cached work reuse; retry/resume operations skip confirmation (kept for first-time Generate and Regenerate) (#160, #168).

**UI**: manual Generate Context Docs button with live progress tracking; file preview modals; services called directly (MCP wrappers deferred) (#155).

**Test seams**: _setChatCompletionForTests and _setGhExecutorForTests inject test doubles for chat completion and shell execution (#155).

### Test run tracking

**Detection and parsing**: automated detection of test commands (vitest, jest, pytest) in Claude Code sessions; LLM-based output parsing via free Claude CLI agent (same infrastructure as quality rules) instead of regex; Bash tool_use paired with tool_result via tool_use_id (#153).

**Recording**: rows written in 'parsing' status, updated asynchronously; raw output truncated (head+tail kept, middle dropped) before LLM parse; test_runs table with project_id and created_at index (#153).

**Modules**: test detection, parsing, recording are separate pure modules; testParser uses free Claude CLI agent (#153).

**Events**: WebSocket broadcasts test_run_started/test_run_completed events; per-session bounded map (MAX_PENDING_PER_SESSION=50) prevents memory leaks (#153).

### Project system

**Discovery**: filesystem-based discovery walks up directory tree looking for `.mission-control.yaml`, falls back to git root detection and auto-creates default config; case-insensitive matching throughout using LOWER() comparisons; deepest (longest) root_path wins when multiple projects match; matchProjectByPath returns longest match (#14, #113, #158).

**Cloning**: Clone from GitHub mode supports https/SSH/shorthand URLs with strict regex validation against injection; parseGithubRepo utility; /api/projects/clone endpoint uses `gh repo clone` instead of raw git; auto-setup agent reads README and runs installation; default .mission-control.yaml injection; runWithStatus helper extracts status message progression pattern (#135, #136).

**Session linking**: resolveSessionProjectName helper with precedence (linked projects.name → worktree parent → working_directory basename → Ungrouped); sessions API uses LEFT JOIN to projects table for authoritative project name (#178, #181).

**Server management**: lsof finds listeners on pinned PORT/VITE_PORT, checks process cwd to determine ownership; kill only terminates PIDs whose cwd is inside project path; platform-specific case-insensitive path comparison on macOS/Windows (#137, #139).

**Railway integration**: services/railway.js encapsulates GraphQL client; fixed sequence: create project → create service from repo → upsert env vars (excluding PORT, VITE_PORT, NODE_ENV) → provision public domain; cleanup logic deletes empty Railway projects on service-create failure; postinstall hook installs client dependencies; setup.sh skips Neon database setup when DATABASE_URL already present to detect managed hosting (#137, #140, #141).

**Project detail page**: /projects/:id showing metadata, local dev servers with kill controls, session history, Railway hosting with one-click deploy, Test Runs panel, Decisions Needed panel, MCPPanel (planning activity, questions, decisions log) (#137, #138, #139, #140, #141, #142, #143, #147).

### Voice recording

**Architecture**: useVoiceRecorder hook manages MediaRecorder lifecycle, permission requests, chunked blob assembly, upload orchestration in single state machine; hoisted to ChatInterface for shared state across VoiceRecorderButton and send button; recorder instance passed as prop (#129, #131).

**Behavior**: automatic transcription via LLM Gateway Whisper API at /api/transcribe; 2-minute limit; auto-send on stop; state-aware UI with timer and error handling; send button shows stop icon during recording and stops-and-sends on click (#129, #131).

**Cancellation handling**: checks cancelledRef after getUserMedia resolves to detect mid-flight cancellation (#132).

### UI patterns and components

**Mobile responsiveness**: CSS flexbox min-width: 0 pattern applied throughout message container chain to enable proper text wrapping in nested flex containers; overflow-wrap: anywhere forces wrapping of unbreakable strings; horizontal scrolling session cards with snap behavior; session title moved to back nav bar; responsive header layout with proper truncation (#128, #70).

**Chat UX**: hover-revealed copy button with check-mark confirmation; two-tier clipboard fallback (navigator.clipboard.writeText → execCommand('copy') via hidden textarea); check window.isSecureContext before attempting clipboard API; click handlers call e.stopPropagation() (#149).

**Streaming**: assistant messages streamed as they arrive indexed by Anthropic message.id; applyAssistantStreamEvent pure reducer separate from WebSocket hook; DB-loaded messages without messageId claimed by streaming events via content matching with lookback-only reconciliation (last 10 messages) (#150).

**Text sanitization**: sanitizeAssistantText strips sub-agent tool transcripts (bash tool execution logs) and hallucinated harness tags (system-reminder, command-name, command-message, command-args, local-command-stdout, local-command-stderr) both server-side (before DB write in sessionManager) and client-side (during streaming); parser uses boundary markers (\nAssistant:, \n[Tool:) with fallback to line count; requires both [Tool: and Tool result: patterns to avoid false positives; conditional pre-check (indexOf) before regex for performance (#152, #185).

**Markdown rendering**: uses temporary data attributes (data-list="ul"|"ol") to tag list items by type before wrapping in correct container; collapse blank lines between consecutive items of same type to produce single list with consecutive numbering (#133, #134).

**Visual design**: retro surfer UI theme with warm cream/sand palette, grain textures, embossed effects, Quicksand font; gradient buttons with glow shadows; throbGreen/throbYellow status animations; click-to-edit for session names; drag-drop with overlay feedback; background images on left and right panels (#30, #31, #109, #110, #4, #18, #21, #24).

**Status pills**: tone-coded using CSS classes (.tone_success, .tone_info, .tone_warn, .tone_error, .tone_muted); COLOR_BY_TYPE/BADGE_BY_TYPE/LABEL_BY_TYPE dictionaries for session types (teal 'M' for manual, green 'I' for implementation) (#173, #186).

**Auto-scroll**: conditional scroll only when user within 150px of bottom; 100dvh with 100vh fallback; overscroll-behavior disabled for iOS (#3).

**Keyboard shortcuts**: desktop Enter sends, mobile Cmd/Ctrl+Enter sends (adaptive behavior based on viewport size at 768px breakpoint); Cmd+S save shortcut for inline file editing; slash command menu uses forwardRef with imperative handleKeyDown for parent-to-child keyboard delegation (#108, #123, #79).

**Queued messages**: grouped interrupt+delete actions with ArrowUp icon for interrupt; trash icon for delete; queued badges visible in chat; failed drains surface as error events (#95, #154).

**Quality checks**: results appear immediately with spinner updating in-place; expandable based on either analysis or details content; running checks tracked with visible "Cancel" button; low-confidence indicators in evals (#61, #62, #75, #91, #111).

**Search**: real-time filtering with 300ms debouncing; combines local filtering (title, lastAction) with remote content search via /api/history/search stored in Set of session IDs; collapsible project groups (#86, #87).

**Session cards**: diff totals (+N -N) always visible; model badges only when non-default; worktree badges with names; pipeline indicator with presence-based checks (green if changes exist, yellow if pending, gray if no work); fully merged feature branches show green based on commitsOnRemote flag; remote stage checks both feature branch remote and origin/main; uncommittedCount tracked; fresh worktree branches show unknown status (#8, #11, #20, #47, #48, #49, #50, #51, #54).

**Session types**: 'manual' type as default for dashboard-created sessions; CODING_SESSION_TYPES set determines quality check execution; validation against VALID_SESSION_TYPES array (#173).

**Settings**: backup/restore pattern writes .settings-backup.json on every save, restores from backup if settings table empty on init (#22).

### Model configuration

Centralized in server/config/models.js with roles (default, fast, strong, quality) and env var override capability; frontend components fetch configuration from /api/models instead of defining locally; default model claude-opus-4-7 upgraded from claude-opus-4-6; Haiku identifier changed from claude-haiku-4-5-20251001 to claude-haiku-4-5 for gateway compatibility (#121, #124).

Effort levels: low/medium/high/xHigh stored in sessions table and app_settings.default_effort; xHigh restricted to Opus 4.7 with automatic downgrade for non-supporting models (#126).

### Sessions API query strategy

UNION ALL returning all non-ended sessions plus N most recent ended ones; LEFT JOIN to projects table for authoritative project name; outer ORDER BY created_at DESC on combined result set (newest-first ordering) (#178, #181).

### React version management

npm overrides enforce single React 18.3.1 across monorepo; vitest resolve.dedupe for react/react-dom as defense-in-depth; vitest worktree exclude patterns anchored at project root (.claude/worktrees, .worktrees) without leading **/ to allow tests inside worktrees (#148).

### Development server ports

Pinned via environment variables (3001 backend PORT, 5173 frontend VITE_PORT) to avoid cross-project conflicts; Vite config loads environment variables using loadEnv; strictPort: true forces fail on port collisions (#127).

## Patterns tried and abandoned

### Permission modes
Current state: `--permission-mode acceptEdits` default (#2, 2026-03-29). Previously: `--dangerously-skip-permissions` and `--plan` flags replaced by acceptEdits/auto/plan enum (#2, 2026-03-29). Reason: Unified API.

### Session summarization
Current state: async non-blocking execFile (#2, 2026-03-29). Previously: synchronous blocking execSync (#1, 2026-03-29). Reason: Avoid blocking event loop.

### Auto-scroll
Current state: conditional scroll based on user position (#3, 2026-03-30). Previously: unconditional scroll-to-bottom (#1, 2026-03-29). Reason: Preserve user scroll position when reading history.

### File tree expansion
Current state: default collapsed with session-scoped persistence (#6, 2026-03-30). Previously: auto-expand two levels deep (#1, 2026-03-29). Reason: Reduce visual clutter.

### Preview URL storage
Current state: per-session dictionary (#8, 2026-03-30). Previously: single global previewUrl string (#1, 2026-03-29). Reason: Support multiple concurrent sessions.

### Quality hook events
Current state: all 21 lifecycle events via ALL_EVENTS array (#9, 2026-03-30). Previously: hardcoded 3-event support [PreToolUse, PostToolUse, Stop] (#2, 2026-03-29). Reason: Full coverage of Claude Code lifecycle.

### Session naming
Current state: AI-generated names from Claude Haiku after first user message (#18, 2026-03-30). Previously: timestamp-based names (#1, 2026-03-29). Reason: Human-readable identifiers.

### Database
Current state: Neon serverless Postgres with async/await (#22, 2026-03-30). Previously: better-sqlite3 synchronous SQLite (#1, 2026-03-29). Reason: Cloud-native deployment, better concurrency.

### Message queueing
Current state: messages appear immediately in UI when process busy (#25, 2026-03-30). Previously: hold-until-ready behavior (#1, 2026-03-29). Reason: Responsive UI feedback.

### Error state handling
Current state: chat input always enabled unless empty (#27, 2026-03-30). Previously: disabled input during ERROR state (#26, 2026-03-30). Reason: Allow retry without UI lock.

### Quality checks execution
Current state: server-side SDK execution watching streaming events (#35, 2026-04-01). Previously: reliance on CLI PostToolUse/Stop hooks (pre-#35). Reason: Centralized control, better debugging. Further refined: defaults to CLI mode via cliAgent.js (#44, 2026-04-02) from exclusive LLM Gateway API execution (#41, 2026-04-02). Reason: Cost savings using free claude --print subprocess.

### Quality checks model
Current state: Claude Sonnet (#40, 2026-04-02). Previously: Haiku (#35, 2026-04-01). Reason: Quality improvements.

### Edit tool line counting
Current state: counts all old as removed, all new as added (#49, 2026-04-02). Previously: net difference calculation (#47, 2026-04-02). Reason: Accurate churn metrics.

### Tool use event handling
Current state: processing in 'assistant' event handler (#51, 2026-04-02). Previously: standalone 'tool_use' event handler that never fired (pre-#51). Reason: Align with actual Claude Code JSONL stream structure.

### Pipeline stage logic
Current state: independent presence-based checks (#51, 2026-04-02). Previously: cascading done/pending logic (earlier PRs). Reason: Simpler state model. Note: cascading logic later added back for forcing downstream stages to pending when upstream incomplete (#48, 2026-04-02).

### Session list sorting
Current state: created_at DESC (#73, 2026-04-06). Previously: last_activity_at causing cards to reorder during interaction (pre-#73). Reason: Predictable stable ordering.

### Quality review loop iteration
Current state: capped at 3 iterations maximum (#66, 2026-04-05). Previously: unbounded when rules failed with send_fail_to_agent (pre-#66). Reason: Prevent infinite loops.

### Message queue and quality check cancellation
Removed (#90, 2026-04-08), then restored with fixes (#92, #91, 2026-04-08). Reason for removal: stale error state bugs. Reason for restoration: features needed, bugs fixable.

### Worktree cleanup
Current state: automatic cleanup on session end with modal for uncommitted changes (#101, 2026-04-09). Previously: manual worktree cleanup (pre-#101). Reason: Reduce filesystem clutter.

### Interrupt mechanism
Current state: SIGINT (Ctrl+C) with signal trap ensuring exit sentinel written (#102, 2026-04-09). Previously: Escape key (#95, 2026-04-09). Reason: Standard Unix signal handling, more reliable.

### Max Effort toggle
Introduced (#106, 2026-04-12), then completely removed (#112, 2026-04-15). Reason for removal: feature deemed unnecessary, replaced by multi-level effort system in #126.

### Enter key behavior
Current state: adaptive by screen size (desktop Enter sends, mobile Cmd/Ctrl+Enter sends) (#123, 2026-04-16). Previously: uniform Cmd/Ctrl+Enter everywhere (#108, 2026-04-15). Reason: Match platform conventions.

### WebSocket reconnect behavior
Current state: merges messages instead of clearing (#129, 2026-04-20). Previously: cleared all messages (pre-#129). Reason: Preserve conversation context.

### Voice recorder ownership
Current state: hoisted to ChatInterface with recorder passed as prop (#131, 2026-04-20). Previously: VoiceRecorderButton managed own instance (pre-#131). Reason: Share state with send button.

### Ordered list rendering
Current state: wraps in `<ol>` with numbers (#133, 2026-04-20). Previously: rendered as `<li>` without container showing bullets (pre-#133). Reason: Correct HTML semantics.

### MCP token scoping
Current state: app-wide tokens with project_id passed explicitly on tool calls (#147, 2026-04-25). Previously: per-project token model (pre-#147). Reason: Simpler token management.

### Assistant message streaming
Current state: in-place updates indexed by Anthropic message.id with lookback reconciliation (#150, 2026-04-25). Previously: exact-content deduplication that blocked in-place growth (pre-#150). Reason: Support incremental streaming updates.

### Planning session rate limits
Current state: no rate limits or timeouts for planning sessions (#151, 2026-04-26). Previously: 10/hour rate limit and 180-second timeout (pre-#151). Reason: Planning sessions are tmux CLI processes, not HTTP requests; enforcement was misapplied.

### Context doc extraction model
Current state: Sonnet (claude-sonnet-4-5) (#155, 2026-04-26). Previously: Haiku in original spec. Reason: Quality over cost.

### Context doc trigger
Current state: manual button only (#155, 2026-04-26). Deferred: automatic PR-merge webhook and scheduled job. Reason: Manual trigger sufficient for MVP.

### Context doc final rollup format
Current state: delimiter-based markdown blocks (===BEGIN/END===) (#166, 2026-04-27). Previously: JSON with escaped markdown strings causing truncation (pre-#166). Reason: Avoid escaping complexity, prevent truncation.

### Restart-resilient tail with UUID deduplication
Introduced (#161, 2026-04-27), then reverted (#162, 2026-04-27). Reason: User request, no explanation provided.

### Pipeline completion behavior
Current state: stage-3 approval parses build plan into chunks and advances to stage 4 (#165, 2026-04-27). Previously: Phase 1 ended at stage 3 (#159, 2026-04-27). Reason: Enable full spec-to-PR pipeline.

### Pipeline gating model
Current state: per-pipeline isGatedStage reading `gated_stages` column (#177, 2026-04-27). Previously: static hard-coded stages 1-3 gating (pre-#177). Reason: Flexible per-pipeline configuration.

### Default session type
Current state: 'manual' (#173, 2026-04-27). Previously: 'implementation' (pre-#173). Reason: Dashboard-created sessions are not always implementation work.

### Project name resolution
Current state: authoritative projects.name from database with fallback precedence (#178, 2026-04-27). Previously: filesystem path basename parsing (pre-#178). Reason: Avoid fragile worktree/case-sensitive path parsing.

### Branch naming for pipelines
Current state: pipeline-\<slug\>-\<8-char-id\> (#184, 2026-04-27). Previously: pipeline-\<slug\> causing non-fast-forward push failures (#179, 2026-04-27). Reason: Prevent branch name collisions.

### CLI session ID storage
Current state: persisted to sessions table and restored on resume (#183, 2026-04-27). Previously: in-memory-only causing synthetic preamble fallback on restart (pre-#183). Reason: Proper resumption after restart.

### Session recovery startup order
Current state: recoverTmuxSessions() awaited before HTTP server starts (#180, 2026-04-27). Previously: fire-and-forget allowing websocket connections before active session map populated (pre-#180). Reason: Prevent race conditions.

## Integration points

### LLM Gateway
Centralized service at https://llm-gateway.replit.app for all AI calls (auto-naming, quality checks, evals); OpenAI-compatible chat completions format; system prompts prepended as messages; server/services/llmGateway.js as single point for all LLM calls; AbortController support for cancellable operations (#41, #44, #91, #94, #129).

### GitHub CLI (gh)
- Project cloning via `gh repo clone` (#135)
- PR creation via `gh pr create` (#179, #184)
- PR listing for watcher service via `gh pr list` every 2 minutes (#111)
- GitHub repo detection with git remote fallback (#157)

### Neon Postgres
- Serverless Postgres database
- async/await query() wrapper with $1,$2 placeholders
- NOW() function for timestamps
- IF NOT EXISTS migrations
- `{ fullResults: true }` option for rowCount metadata (#22, #25, #125)

### Railway
- services/railway.js GraphQL client
- Project/service creation sequence
- Environment variable upsert (excluding PORT, VITE_PORT, NODE_ENV)
- Public domain provisioning
- Cleanup logic for failed deployments (#137, #140, #141)

### Claude CLI
- Session execution via tmux with --model, --permission-mode, --effort-level, --worktree, --mcp-config, --resume, --allowedTools flags
- Quality check execution via `claude --print` subprocess
- Sub-agent sandboxing with restricted tool sets (#2, #7, #11, #44, #57, #126)

### Web Push API
- Browser push notifications
- VAPID key generation
- Subscription management in notification_subscriptions table (#53)

### Vite dev server
- Frontend build/serve on port 5173
- WebSocket proxy routing
- Environment variable loading via loadEnv
- strictPort: true for fail-fast on conflicts (#127)

## Key technical decisions

### Tmux-based session persistence
Sessions spawn inside tmux instead of raw child_process to survive server restarts and enable resumption. Recovery logic reconnects on startup, awaited before HTTP server starts. CLI session IDs persisted to database for proper resumption. (#12, #180, #183)

### Server-side quality checks
Moved from CLI hooks to server-side execution watching streaming events for centralized control and better debugging. Hybrid execution model supports both free CLI agent (default) and paid API mode per rule. (#35, #44)

### Single WebSocket connection
Replaced per-session connections with single shared connection managed by AppContext with explicit subscribe/unsubscribe messages. Reduces overhead and simplifies reconnection logic. (#53)

### Async/await database layer
Switched from synchronous SQLite to async Neon Postgres for cloud-native deployment and better concurrency. All queries use async/await with proper error handling. (#22)

### Pipeline orchestration
Three-tier architecture (repo/orchestrator/runtime) separates persistence, stage transitions, and execution. Gated stages configurable per pipeline. Fix cycles capped at 3 before escalation. Automatic recovery on startup. (#159, #165, #175, #177)

### Context doc generation
Per-PR extractions cached to enable idempotent retry. Batched roll-up in 25-PR chunks. Delimiter-based markdown output avoids JSON escaping complexity. (#155, #160, #166)

### Path traversal protection
All user-supplied file paths validated via safeResolvePath/isSafeEvalPath/isSafeFolderPath before resolution. Returns null for invalid paths. Applied throughout file operations, eval system, MCP file tools. (#53, #97, #116, #182)

### Project discovery
Filesystem-based with `.mission-control.yaml` detection, auto-creation on session start, longest-match resolution for nested projects, case-insensitive matching. Replaced preset database approach. (#14, #113, #158)

### Message streaming
Assistant messages indexed by Anthropic message.id with in-place updates. Client-side deduplication checks last 10 messages. DB-loaded messages claimed via content matching with lookback-only reconciliation. (#150)

### Session type system
Enum of session types (manual, implementation, planning, extraction, eval_gatherer, spec_refinement, qa_design, implementation_planning, qa_execution, code_review) determines behavior (quality checks, timeouts, permission modes). Visual differentiation via badge colors and labels. (#145, #173)

### Test run parsing
LLM-based parsing via free Claude CLI agent instead of regex for robustness. Separate pure modules for detection, parsing, recording. Bounded per-session map prevents memory leaks. (#153)

### Voice recorder architecture
Single state machine in useVoiceRecorder hook hoisted to ChatInterface for shared state. MediaRecorder lifecycle management with chunked blob assembly. Dual-purpose send button shows stop icon during recording. (#129, #131)

### MCP protocol choice
JSON-RPC 2.0 over HTTP instead of stdio/SSE for simplicity. Claude Desktop support via stdio-to-HTTP bridge. App-wide bearer tokens with project_id passed explicitly on tool calls. (#145, #147, #167)

### Quality rule enforcement
Failures collected and sent to agent after 500ms delay when send_fail_to_agent enabled. Spec-dependent rules skip entirely when no spec present. 3-iteration cap with reset on manual user message. (#40, #66)

### Git operations security
All git operations use execFileSync with argument arrays instead of execSync string interpolation to prevent command injection. Platform-specific case-insensitive path comparison on macOS/Windows. (#53)

### Model configuration
Centralized in server/config/models.js with roles and env var overrides. Frontend fetches from /api/models. xHigh effort level restricted to Opus 4.7 with auto-downgrade. (#121, #126)