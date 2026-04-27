# Architecture

> Auto-generated from PR history. Edit freely — future roll-ups will preserve manual additions.

## System overview

**Backend:** Node.js/Express server with Neon serverless Postgres, WebSocket (ws library) for real-time updates, tmux for session process management. (#1, #2, #12, #22)

**Frontend:** React 18 with Vite, react-router-dom for routing, mobile-responsive with 100dvh for proper mobile viewport handling. React pinned to 18.3.1 via npm overrides to prevent testing-library conflicts. (#1, #3, #148)

**Session execution:** Claude CLI invoked with `--permission-mode` (acceptEdits default), `--model` for per-session model choice, `--mcp-config` for structured JSON MCP configuration, `--worktree` for isolated Git worktrees. (#2, #7, #11, #20)

**External integrations:**
- LLM Gateway at https://llm-gateway.replit.app for all LLM features (requires LLM_GATEWAY_KEY env var) (#41, #129)
- Railway GraphQL API for one-click deployment and status tracking (#137)
- GitHub CLI (gh) for PR operations and repository detection (#179, #157)

**Authentication:** Bearer token comparison on all /api routes except /health, opt-in via MC_AUTH_TOKEN env var. Timing-safe comparison to prevent timing attacks. (#53)

**MCP server:** JSON-RPC 2.0 over HTTP with app-wide bearer auth via mcp_tokens table. Stdio-to-HTTP bridge (mcp-stdio-bridge.js) translates between Claude Desktop stdio protocol and Mission Control HTTP endpoint. (#145, #147, #167)

## Data model

**Core tables:**
- `sessions` — session metadata including tmux_session_name, cli_session_id, working_directory, worktree_name, model, status, session_type, pipeline_id, pipeline_stage, has_spec, railway_project_id, deployment_url
- `messages` — chat messages with role, content, attachments (JSON), created_at; linked to sessions
- `quality_results` — quality check results with analysis; merged client-side with messages by timestamp (#61, #62)
- `stream_events` — CLI panel tool invocation history; replayed from DB on resume to initialize dedup state (#42, #59)
- `queued_messages` — persisted message queue with content, attachments (JSON), queued_at; rehydrated on server startup and session resume (#154)

**Quality and evals:**
- `quality_rules` — rules with hook_type, execution_mode (cli/api), send_fail_to_agent flag, send_fail_requires_spec flag, seed_version for migrations (#2, #9, #44, #63)
- `evals` — eval definitions with folder organization, evidence config, checks, judge config, trigger types (#111, #115)
- `context_doc_runs` — tracks generation runs with status, progress, error messages (#155)
- `context_doc_extractions` — caches per-PR extraction results for idempotent retries (#155)

**Pipeline orchestration:**
- `pipelines` — pipeline metadata including status, github_repo, gated_stages (JSONB), fix_cycles_used, pr_number, pr_url, railway_project_id (#165, #177, #179)
- `pipeline_chunks` — parsed build plan chunks with status (pending/completed) (#165)
- `pipeline_escalations` — escalations when retry cap exceeded or parse failures (#165)
- `planning_questions` — seven columns for escalation tracking (question_1 through question_7) (#151)
- `decision_chats` — polymorphic table with subject_type/subject_id for escalations and approvals (#163, #171)

**Project management:**
- `projects` — project metadata with root_path, github_repo, railway_project_id, deployment_url; linked to sessions via case-insensitive path matching (#14, #137, #158)
- `mcp_tokens` — app-wide bearer auth tokens for MCP server (#147)

**Database technology:** Neon serverless Postgres with async/await throughout, query() wrapper for parameter placeholders ($1, $2), TIMESTAMPTZ for timestamps with automatic conversion, { fullResults: true } to expose rowCount metadata for UPDATE/DELETE validation. (#22, #25, #53, #125)

## Established patterns

### Session lifecycle
- Session creation is async and awaits database INSERT; in-memory session status takes precedence over DB with automatic reconciliation (#26)
- Sessions persist via tmux send-keys for input and file-based .jsonl output tailing (100ms polling) (#12)
- Tmux session recovery on server startup via recoverTmuxSessions(); must complete before HTTP server starts listening to prevent websocket race conditions (#12, #180)
- Session resumption builds context preamble from summary, original task, key decisions JSON, modified files, last 5 exchanges, and git status (#12)
- Resumed sessions enforce plan mode via prompt prefix injection since CLI --permission-mode flag ignored on --resume (#76)
- Worktree recovery on resume: extract worktree_name from cwd path, check for branch locally/remotely, prune stale git records, recreate worktree with timeouts; fall back to parent only when both directory and branch are gone (#104)
- Safety-net timer (5s) plus stale status detection prevents sessions stuck in 'working' when process exit sentinel missed (#64)
- Safety-net verifies tmux pane liveness before resetting working sessions, instead of unconditional reset (#180)
- Session-scoped mobile routes pattern /session/:id/{feature} with context-aware tab navigation (#19)

### Message and streaming
- Chat streaming uses upsert pattern: INSERT on first assistant event per turn, UPDATE on subsequent events; turn boundaries detected on tool_result and new user messages (#103)
- Message streaming uses Anthropic message.id for in-place updates, reconciles DB-loaded messages by content matching or extension in last 10 messages (#150)
- Auto-scroll is conditional based on scroll position within 150px of bottom (#3)
- Session message limit raised to 10,000; stream event history replayed from database on resume to initialize dedup state (#59)
- Message queue drain only on process termination (#27)
- Queued messages stored in `queued_messages` table, rehydrated on server startup and session resume; in-memory queue changed from strings to objects with {content, attachments, queueId} (#154)

### Quality and evals
- Quality checks route through either CLI agent (`claude --print` subprocess) or LLM Gateway based on per-rule `execution_mode` setting; default is CLI (#44)
- Quality checks track running state in server memory Map and expose via REST endpoint to survive page reloads and reconnects (#75, #77)
- Quality review loop caps at 3 iterations per work cycle, resetting on manual user messages (#66)
- Quality rule failures with `send_fail_to_agent` enabled are collected and sent back to agent as formatted user messages after 500ms delay (#40)
- Quality checks skip entirely when send_fail_requires_spec set and no spec present (#63)
- Quality checks determine working directory by checking toolInput.file_path first, then falling back to session.working_directory from database (#83)
- Quality checks receive git context (commits, diffs) and conditional tool access based on hook_type='agent' flag (#57)
- Composite triggers (PRCreated) match multiple command patterns server-side ('gh pr create', 'git push') with parallel execution via Promise.all and duplicate prevention via runningChecks map (#80, #81, #82)
- Quality check cancellation uses AbortController pattern threaded through cliAgent.js and llmGateway.js, with server broadcasts as single source of truth for state updates (#89, #91, #94)
- Evals pipeline: Evidence → Checks → Judge; evidence from logs/DB/files/sub-agents with per-type truncation strategies; checks (equals, contains, comparisons, numeric_score with JSON field extraction via dot notation); LLM judge with confidence levels (#111, #115)
- Sub-agent evidence gathering uses sandboxed CLI: restricted tool set, plan-only permission mode, no MCP, scoped cwd; security hardened with path traversal prevention, read-only DB, parameterized SQL (#111)
- Eval authoring via natural language: server-side CLI agent drafts definitions, drafts saved as .yaml.draft, preview-run before publish, WebSocket progress updates via broadcastToAll (#120)
- Test runs detected/parsed/recorded in three pure modules, parsed via free Claude CLI agent, tracked with tool_use_id pairing, written immediately in 'parsing' status then updated async (#153)

### Pipeline orchestration
- Pipeline stages execute as dedicated sessions with `session_type` values and link to parent via `pipeline_id` and `pipeline_stage` columns (#159)
- Build plans parsed into chunks stored in `pipeline_chunks` table; QA reports parsed for 'Overall: pass|fail'; code reviews parsed for 'Blockers: N' to route autonomous stage transitions (#165)
- Pipeline escalations stored in `pipeline_escalations` table when retry cap exceeded or parse failures occur, surfaced as top banner in UI (#165)
- Planning escalations parsed from structured ESCALATE blocks, tracked in seven planning_questions columns, answered by owner via UI, logged to decisions.md and optionally appended to PRODUCT/ARCHITECTURE.md (#151)
- Pipeline sessions close when work completes but stay open during approval pauses (#175)
- Pipeline session recovery on startup checks tmux health (has-session + pane_current_command), marks orphans 'ended', resets stage-4 chunks to pending, hands other stages back to completion flow (#175)
- Per-pipeline gate configuration stored as JSONB `gated_stages` column defaulting to [1,2,3]; GATEABLE_STAGES constant defines which stages can be gated (1,2,3,5,6) (#177)
- PR creation is orchestrator-invoked at pipeline completion, encapsulated in pipelinePrCreator service with git/gh CLI test seams; failures stored but don't block completion (#179)
- Branch names include last 8 chars of pipeline ID as suffix (pipeline-<slug>-<8-char-id>) for uniqueness (#184)
- Pipeline state pills computed by pure describeState() function mapping status to {tone, label}; backend includes github_repo in GET /api/pipelines/:id for client-side URL construction (#186)

### WebSocket and real-time updates
- WebSocket architecture consolidated to single shared connection via AppContext with explicit subscribe/unsubscribe model instead of per-component connections (#53)
- WebSocket URLs derive from `window.location.host` to inherit protocol/hostname and route through Vite dev proxy, fixing Tailscale connectivity (#129)
- WebSocket events: session_name_updated, user_message, error, quality_result, session_status, message_queued, message_dequeued, message_deleted (#18, #25, #89, #92, #118)
- SessionList and QualityScorecard use WebSocket-only updates instead of polling (#53)
- Health-check polling pattern for detecting server availability during restarts (#16)
- WebSocket reconnect keeps messages visible and only clears CLI panel (#129)

### File operations and security
- File attachments stored in /uploads directory with multer, metadata in messages.attachments JSON column, served via /api/uploads with traversal protection (#24)
- File operations centralize path traversal protection in safeResolvePath() that validates paths stay within home directory, returns null for invalid paths triggering 403 responses (#97, #98)
- MCP file tools use resolveProjectPath() to validate relative paths against project root, checking for absolute paths, .. escapes, and symlink escapes; writes restricted to PRODUCT.md and ARCHITECTURE.md (#182)
- File tree walking capped at depth 10, file reads at 1 MB; binary files detected via NUL-byte heuristic and returned as base64 (#182)
- Git operations use async exec with Promise.all parallelization, 10-second TTL cache, switched from execSync with shell interpolation to execFileSync with argument arrays for security hardening (#32, #101)

### LLM integration
- LLM Gateway centralized at https://llm-gateway.replit.app with OpenAI-compatible chat completions endpoint; requires LLM_GATEWAY_KEY env var (#41)
- Voice transcription proxied through backend to LLM Gateway (keepAPIKeyServerSide) with multipart/form-data uploads limited to 25MB (#129)
- Model configuration centralized in `server/config/models.js` with role mapping (default, fast, strong, quality) and env var overrides; frontend fetches from `/api/models` (#121)
- Decision chat uses claude-sonnet-4-6 model with truncated project docs in system prompt (#163, #171)
- Session auto-naming uses Claude Haiku (#18)
- Context-doc generation uses Sonnet for per-PR extraction, processes in batches of 25, tracks runs in `context_doc_runs` table with WebSocket progress broadcasts (#155)
- Final context-doc rollup emits delimited markdown blocks (===BEGIN/END===) instead of JSON to avoid escaping overhead and truncation, raised token budget to 12000 (#166)

### Merge-field and prompt injection
- Merge-field system: {{field_name}} placeholders resolved server-side before CLI spawn; resolvers return string|null with context (workingDirectory, sessionId); unresolved fields remain as literals with explanatory note; {{last_pr}} resolver shells to gh CLI with 10s timeout (#126)
- xHigh effort level restricted to Opus 4.7 with auto-downgrade for other models; effort level persisted per session and as app-wide default (#121, #126)
- Plan mode on resumed sessions enforced via prompt prefix injection since CLI --permission-mode flag ignored on --resume (#76)
- Context auto-injection: tracks _lastContextRatio and _compactionDetected flags, triggers when context drops 40%+ from above 40%, injects ~50k char conversation history prioritizing recent messages via buildCompactionPreamble() (#93)
- Sub-agent tool transcripts stripped both server-side (before DB write) and client-side (during streaming) using boundary-marker parser with false-positive protection (#152)
- Assistant message sanitization strips six harness tag types (system-reminder, command-name, etc.) on both server write and client read paths; historical data cleaned via one-time script (#185)

### Project and deployment
- Project configuration via filesystem discovery with optional AI-driven setup automation (#14, #17)
- Auto-creates .mission-control.yaml at git root when missing to ensure project linkage (#113)
- Session-to-project linking uses case-insensitive path matching; one-time backfill at server startup links orphaned sessions by matching working_directory to project root_path (#158)
- GitHub repo detection falls back to git remote parsing before throwing NO_GITHUB_REPO errors, injected as test seam for unit testing (#157)
- Railway integration via GraphQL client creates project → service from repo → env vars → domain in sequence, stores railway_project_id/deployment_url in projects table (#137)
- Fix sessions run in isolated worktrees/branches and are idempotent (one per failure via fix_session_id race-safe UPDATE) with best-effort creation (#143)
- Server ownership detection uses lsof with case-insensitive path matching on macOS/Windows, case-sensitive on Linux (#137, #139)

### Testing and observability
- Dev server ports configured via environment variables with strictPort: true to fail loudly on conflicts; Command Center assigned 3001 (backend) and 5173 (frontend) (#127)
- Shell-out services use _setExecutorsForTests/_resetExecutorsForTests for unit test seams (#179, #184)
- ESM/CommonJS interop: unwrapDefault helper for tsx runtime compatibility, createRequire for importing CommonJS modules from ESM (#120, #121)

### Session lifecycle events
- Session lifecycle events made idempotent with `_sessionCompleteEmitted` flag to prevent duplicate events during quality-review respawns (#174)
- Interrupt mechanism sends Ctrl+C (SIGINT) via tmux with signal trap to write exit sentinel, sets _interrupted flag to skip quality checks, and immediately processes queued messages (#102)
- Tool use processing happens in 'assistant' event handler where tool_use blocks actually arrive, not standalone 'tool_use' handler (#51)
- Defense-in-depth validation: client normalizes input, server validates as backup (project name hyphen rules) (#60)

### UI and mobile patterns
- Sessions API uses UNION ALL to return all non-ended sessions plus N most recent ended ones, LEFT JOINs projects table for authoritative name resolution, wrapped in subquery with outer ORDER BY created_at DESC (#178, #181)
- Session search combines local filtering (title, lastAction) with debounced remote API calls (message content) using Set membership for 2+ character queries limited to 100 results (#87)
- Mobile dashboard uses horizontal scroll with snap points (#70)
- Chat Enter key behavior: desktop uses plain Enter to send, mobile uses Cmd+Ctrl+Enter (#123)
- Retro surfer UI theme with warm cream/sand backgrounds, coral/teal accents, and tactile design elements (#30, #31)

## Patterns tried and abandoned

**Current approach:** Quality checks appear in chat immediately with spinner that updates in-place (#75, 2026-04-06). **Previously tried:** Only appeared after completion. **Reason:** Poor real-time feedback.

**Current approach:** Chat streaming uses upsert pattern with INSERT on first assistant event, UPDATE on subsequent (#103, 2026-04-09). **Previously tried:** Separate insert per event causing duplicates and inflated message counts. **Reason:** Streaming events need in-place updates, not separate messages.

**Current approach:** Tool use processing in 'assistant' event handler (#51, 2026-04-02). **Previously tried:** Standalone 'tool_use' handler. **Reason:** tool_use blocks arrive in assistant events, dedicated handler never fired.

**Current approach:** Pipeline stages use independent presence checks (green/yellow/gray) (#51, 2026-04-02). **Previously tried:** Cascading done/pending logic. **Reason:** Showed misleading all-green status.

**Current approach:** Quality checks default to CLI execution (#44, 2026-04-02). **Previously tried:** API-only execution (#35, 2026-04-01). **Reason:** Cost savings; CLI execution is free.

**Current approach:** Session metrics show diff totals (+N/-N lines) (#50, 2026-04-02). **Previously tried:** Message counts then tool call counts. **Reason:** Code impact more meaningful than activity volume.

**Current approach:** Sessions sort by created_at DESC (#73, 2026-04-06). **Previously tried:** Sorted by last_activity_at. **Reason:** Prevented reordering during interaction.

**Current approach:** WebSocket-only updates for SessionList and QualityScorecard (#53, 2026-04-02). **Previously tried:** Polling at 30s and 15s intervals. **Reason:** Real-time updates more efficient and responsive.

**Current approach:** Interrupt sends SIGINT/Ctrl+C (#102, 2026-04-09). **Previously tried:** Escape key (#95, 2026-04-09). **Reason:** Escape ignored in --print mode.

**Current approach:** CLI session IDs persisted to database (#183, 2026-04-27). **Previously tried:** Memory-only tracking. **Reason:** Lost session identity on restart.

**Current approach:** Branch naming with pipeline ID suffix (#184, 2026-04-27). **Previously tried:** pipeline-<slug> without suffix. **Reason:** Caused push collisions.

**Current approach:** Context-doc rollup emits delimited markdown blocks (#166, 2026-04-27). **Previously tried:** JSON output. **Reason:** Avoided escaping overhead and truncation.

**Current approach:** Planning sessions have no rate limits or timeouts (#151, 2026-04-26). **Previously tried:** 10/hour rate limit and 180s timeout (#145, 2026-04-25). **Reason:** Tmux CLI processes don't need API-call semantics.

**Current approach:** Per-pipeline gated_stages JSONB column (#177, 2026-04-27). **Previously tried:** Hard-coded approval gates at stages 1-3. **Reason:** Needed configurable autonomy vs. control tradeoff.

**Current approach:** Sessions API uses UNION ALL with all non-ended plus N recent ended (#178, 2026-04-27). **Previously tried:** Flat ORDER BY query. **Reason:** Ended backlog hid active sessions.

**Current approach:** Tmux session recovery awaited before HTTP server starts (#180, 2026-04-27). **Previously tried:** Fire-and-forget recoverTmuxSessions(). **Reason:** Prevented websocket race conditions.

**Current approach:** Safety-net verifies tmux liveness before resetting (#180, 2026-04-27). **Previously tried:** Unconditional reset when missing from active map. **Reason:** Prevented false resets during recovery window.

**Current approach:** Worktree recovery attempts to recreate from branches (#104, 2026-04-09). **Previously tried:** Permanently falling back to parent directory. **Reason:** Preserved isolation instead of destructive merge.

**Current approach:** Database uses Neon serverless Postgres (#22, 2026-03-30). **Previously tried:** better-sqlite3. **Reason:** [REVIEW: migration rationale not documented in PRs].

**Current approach:** Queued messages persist to database (#154, 2026-04-26). **Previously tried:** In-memory-only queue. **Reason:** Lost messages on restart.

**Current approach:** Context-doc extraction uses Sonnet (#155, 2026-04-26). **Previously tried:** Haiku. **Reason:** Quality issues; cost increase accepted.

**Current approach:** Chat Enter key: desktop plain Enter, mobile Cmd+Ctrl+Enter (#123, 2026-04-16). **Previously tried:** Plain Enter creates newlines universally (#108, 2026-04-15). **Reason:** Desktop users expect Enter to send.

**Current approach:** File tree collapsed by default with sessionStorage persistence (#6, 2026-03-30). **Previously tried:** Auto-expanded two levels (#1, 2026-03-29). **Reason:** Gave users control over expansion state.

**Current approach:** Preview URL tracking is per-session dictionary (#8, 2026-03-30). **Previously tried:** Single global string (#1, 2026-03-29). **Reason:** Multiple sessions can run different servers.

## Integration points

**Claude CLI:** Primary execution environment via `claude` command with flags for permission mode, model selection, MCP config, worktree mode, resume. Invoked via tmux send-keys. (#2, #7, #11, #20, #76)

**LLM Gateway:** https://llm-gateway.replit.app with OpenAI-compatible chat completions endpoint. Used for all LLM features including session naming, quality checks (when execution_mode=api), voice transcription, eval judging, decision chat, context-doc generation. Requires LLM_GATEWAY_KEY env var. (#41, #44, #129, #155, #163)

**GitHub CLI (gh):** Used for PR operations (create, list, view), repository detection, Railway PR trigger detection. Timeout varies by operation (10s for last_pr merge field, polling interval for PR updates). (#157, #179, #111)

**Railway GraphQL API:** Creates projects, services, environment variables, domains. Stores railway_project_id and deployment_url. Used for one-click deployment and fix session spawning. (#137, #143)

**Git:** Operations via execFileSync with argument arrays for security. Used for worktree management, branch operations, status checks, diff computation, pipeline status. 10-second TTL cache on pipeline operations. (#32, #101)

**tmux:** Process isolation and recovery. Sessions named tmux-{sessionId}. Commands sent via send-keys, output tailed from .jsonl files. Recovery checks has-session + pane_current_command. (#12, #180)

**Neon Postgres:** Serverless database with async/await throughout, query() wrapper for parameter placeholders, TIMESTAMPTZ for timestamps, { fullResults: true } for UPDATE/DELETE validation. (#22, #125)

**Web Push API:** Push notifications for task completion, errors, context warnings. (#1, #2, #9)

**Claude Desktop:** MCP integration via stdio-to-HTTP bridge (mcp-stdio-bridge.js) using readline interface and environment variables for token/URL. (#167)

## Key technical decisions

**Tmux for session persistence.** Provides process isolation, recovery across restarts, and established tooling without custom process management. Sessions survive server crashes and can be manually inspected. (#12)

**Neon serverless Postgres over SQLite.** Migration from better-sqlite3 to Neon serverless Postgres required all operations to become async and changed query syntax. [REVIEW: migration rationale not documented in PRs]. (#22)

**Single shared WebSocket connection.** Consolidates to single connection via AppContext with explicit subscribe/unsubscribe instead of per-component connections. Reduces resource usage and simplifies state management. (#53)

**CLI execution for quality checks.** Defaults to `claude --print` subprocess to avoid API costs while maintaining full Claude capabilities. Rules can opt into paid LLM Gateway execution per-rule via execution_mode setting. (#44)

**Upsert pattern for chat streaming.** INSERT on first assistant event per turn, UPDATE on subsequent events. Turn boundaries detected on tool_result and new user messages. Prevents duplicate messages and inflated counts. (#103)

**CLI session ID persistence.** Enables full conversational continuity across restarts by preserving Claude's internal session identity, not just message history. (#183)

**Bearer token authentication.** Timing-safe comparison on all /api routes except /health, opt-in via MC_AUTH_TOKEN env var. Protects against timing attacks. (#53)

**Path traversal protection.** Centralized validation in safeResolvePath() and resolveProjectPath() that checks for absolute paths, .. escapes, and symlink escapes. Returns null for invalid paths triggering 403 responses. (#97, #98, #182)

**Merge-field system for dynamic prompts.** Server-side {{field_name}} resolution before CLI spawn with string|null resolvers. Unresolved fields remain as literals with explanatory note. Enables dynamic context injection. (#126)

**Delimited markdown blocks for context docs.** Emits ===BEGIN/END=== delimiters instead of JSON to avoid escaping overhead and truncation. Raised token budget to 12000. (#166)

**Worktree auto-creation and recovery.** Provides Git isolation without manual branch management. Recovery logic recreates from branches instead of destructive fallback to parent. (#7, #20, #104)

**Quality review loop iteration cap.** Prevents infinite loops while allowing agents to iterate on failures. Resets on manual user messages to distinguish automated cycles from fresh work. (#66)

**Pipeline session lifecycle.** Sessions close when work completes but stay open during approval pauses. Automatic recovery checks tmux health on startup. (#175, #176)

**Sub-agent sandboxing for evals.** Restricted tool set, plan-only mode, no MCP, scoped cwd, path traversal prevention, read-only DB, parameterized SQL. Prevents unintended side effects. (#111)

**Queued message persistence.** Database storage with rehydration on server startup and session resume prevents message loss during crashes or redeploys. (#154)

**Unique pipeline branch names.** Includes last 8 chars of pipeline ID as suffix to prevent push collisions when multiple pipelines work on same project. (#184)

**MCP file write restrictions.** Limits writes to PRODUCT.md and ARCHITECTURE.md to constrain blast radius of autonomous planning sessions while enabling living doc updates. (#182)

**Test seams via dependency injection.** Shell-out services use _setExecutorsForTests/_resetExecutorsForTests for unit test seams. Enables testing without mocking filesystem or subprocess calls. (#179, #184)