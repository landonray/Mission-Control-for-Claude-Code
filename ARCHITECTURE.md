# Architecture

> Auto-generated from PR history. Edit freely — future roll-ups will preserve manual additions.

## System overview

Command Center is a Node.js web application with React frontend that manages Claude Code CLI sessions remotely. The system architecture consists of:

- **Backend**: Express server with Postgres database (via @neondatabase/serverless), WebSocket server for real-time communication, tmux session management
- **Frontend**: React SPA with mobile-responsive PWA capabilities, single shared WebSocket connection
- **Claude CLI integration**: Subprocess invocation with --print --input-format stream-json --output-format stream-json for bidirectional JSON communication
- **MCP layer**: Mission Control MCP server runs as part of main app sharing database/session infrastructure; supports both HTTP (main UI) and stdio (Claude Desktop) protocols via bridge

Key subsystems:
- Session lifecycle (spawn, resume, interrupt, cleanup)
- Quality assurance (evals, rules, enforcement)
- Pipeline orchestration (multi-stage workflow)
- Context document generation (PR history → living docs)
- Railway deployment integration
- Test run detection and parsing

## Data model

**Core tables**
- `sessions`: session_id, project_id, session_type (default/planning), session_name, working_directory, tmux_session_name, status (idle/working/reviewing/ended), lines_added, lines_removed, uncommitted_count, pipeline_id, pipeline_stage, created_at, last_activity_at, has_spec
- `messages`: session_id, role (user/assistant/quality), content, attachments (JSON), timestamp
- `stream_events`: session_id, event_type, event_data (JSON), timestamp — persisted immediately on broadcast for replay on resume
- `projects`: project_id, name, directory, projects_directory, github_repo, has_deployment, deployment_status, deployment_logs
- `servers`: server_id, name, directory, owner_project_id — MCP servers auto-discovered from filesystem
- `queued_messages`: session_id, message_id, content, timestamp — persists queued chat messages across restarts

**Quality assurance**
- `quality_rules`: rule_id, rule_name, trigger_type, execution_mode (cli/gateway), enabled, config (JSON with tool permissions, timeouts)
- `quality_reviews`: session_id, rule_name, status (running/passed/failed), analysis_content, iteration_count, started_at, completed_at
- `evals`: eval_id, project_id, name, description, yaml_path, is_draft, triggers (JSON)
- `eval_runs`: run_id, eval_id, session_id, status, started_at, completed_at
- `context_doc_runs`: run_id, project_id, status (running/completed/failed), progress, started_at
- `context_doc_extractions`: project_id, pr_number, extraction (JSON) — cached per-PR analysis

**Pipeline orchestration**
- `pipelines`: pipeline_id, project_id, spec_content, status, created_at
- `pipeline_stage_outputs`: pipeline_id, stage_number, output_content, created_at
- `pipeline_stage_prompts`: pipeline_id, stage_number, prompt_content, created_at
- `pipeline_chunks`: pipeline_id, stage_number, chunk_number, status, output
- `pipeline_escalations`: pipeline_id, stage_number, reason, created_at

**Decisions and planning**
- `decision_chats`: decision_id, question, draft_answer, final_answer, reasoning, messages (JSON), created_at, finalized_at
- `slash_commands`: command_id, command, prompt, created_at — stored commands with REST CRUD API

**Settings and tokens**
- `settings`: key, value — single row stores all app settings as JSON, backed up to .settings-backup.json on every save
- `mcp_tokens`: token (app-wide scope, not per-project) — clients call mc_list_projects then specify project_id explicitly

## Established patterns

**Session lifecycle**
- Sessions spawn inside tmux by default (`tmux new-session -d -s <session-name> <claude-command>`) with fallback to direct child processes (#12)
- Server reconnects to existing tmux sessions on startup by listing tmux sessions and matching session names (#12)
- Working directory persisted to database and restored on resume; context preambles built from prior messages for tmux-recovered sessions (#28, #37, #83, #85)
- Session state cleanup (error, permission, message queue) happens at process lifecycle boundaries — exit handlers and message send (#27)
- Session status reconciliation happens inline during API reads, marking stale sessions as ended when not found in memory (#5)
- Resume guard uses try-finally for cleanup safety to prevent stuck resumeInProgress flags (#85)

**WebSocket communication**
- Single shared WebSocket at /ws with subscribe_session/unsubscribe_session pattern (#53, #59)
- Stream events persist to database immediately on broadcast and load from DB on session init (#42)
- Duplicate detection via dbEventCountRef to handle WebSocket replay overlap (#42)
- Session resumption replays stream_events_history from database to initialize deduplication state (#59)
- WebSocket URLs derive from window.location.host to work behind Vite proxy on any hostname (#129)

**Claude CLI invocation**
- Base invocation: `claude --print --input-format stream-json --output-format stream-json` for bidirectional JSON communication (#2)
- MCP servers configured via `--mcp-config <path>` with nested JSON structure instead of multiple --mcp flags (#2)
- Tmux output polling at 100ms interval for reading session output (#12)
- Plan mode enforcement on resumed sessions uses read-only prompt prefix since --permission-mode flag ignored by CLI on --resume (#76)

**Message and stream event handling**
- Streaming events: INSERT on first assistant event + UPDATE on subsequent events to prevent duplicates (#103)
- Assistant messages indexed by Anthropic message.id for in-place updates during streaming; DB-loaded messages reconciled by content match (#150)
- Message deduplication checks last 10 messages by role and content instead of only most recent (#65, #69)
- Sub-agent tool transcripts stripped from chat messages via sanitization utility duplicated across client and server (#152)
- Queued messages persist in queued_messages table with CRUD service, queue rehydration on session recovery, sendMessage fromQueue flag to skip duplicate inserts (#154)

**Quality assurance execution**
- Quality checks broadcast 'quality_running' events immediately and transition sessions to 'reviewing' state separate from 'working'/'idle' (#75, #77)
- Running checks tracked server-side in memory and restored on reconnection via GET endpoint (#75)
- Quality rules check both has_spec database flag AND on-disk spec file presence; spec documents can come from chat attachments or filesystem (#63, #74)
- Quality rules implemented as composite triggers (PRCreated) that pattern-match tool inputs server-side rather than generating Claude Code hooks (#80, #81)
- Parallel execution via Promise.all for performance (#82)
- AbortController pattern passed through cliAgent and llmGateway for surgical cancellation via AbortSignal (#89, #91, #94)
- Session interrupt sets _interrupted flag to skip quality checks on user-initiated stops (#95, #102)
- Quality review iteration counter tracks up to 3 retries per session and resets on manual user message (#66)

**Evals pipeline**
- Evidence gathering → automated checks → LLM judge flow with pluggable evidence modules (log, database, sub_agent, pr_diff, build_output) (#111)
- YAML-based configuration, batch-based runs with atomic state tracking, trigger-based execution model (#111)
- Sub-agents restricted to read-only tools in plan mode with no MCP, all file paths validated against project root, parameterized SQL queries, size caps enforced at evidence gathering (#111)
- WebSocket-based real-time updates during AI-assisted authoring, agent investigation phase with Read/Glob/Grep tools, draft lifecycle as .yaml.draft files, preview runs before publishing (#120)

**LLM integration**
- Centralized through llmGateway.js service using OpenAI-compatible format instead of provider-specific SDKs (#41)
- Hybrid execution: free claude --print CLI subprocess or paid LLM Gateway API based on execution_mode, maintaining identical prompt construction and result parsing (#44)
- Voice transcription proxies through backend at /api/transcribe to keep LLM Gateway API key server-side only (#129)
- Model configuration centralized in server/config/models.js with role-based environment overrides (MODEL_DEFAULT, MODEL_FAST, etc.) and dynamic /api/models endpoint (#121)

**Git and worktree management**
- Git pipeline operations converted to async/await with parallel execution via Promise.all, 10-second TTL cache, worktreeReady guard to prevent stale status display (#32)
- Diff stats calculated inline during assistant event processing by inspecting tool_use content blocks (#51)
- Pipeline stages use independent presence checks instead of cascading statuses (#51)
- Worktree lifecycle: attempt recreation from branches before fallback to parent directory, check both local and remote branch existence, preserve worktree_name in database (#104)
- PR integration via gh CLI: backend uses gh pr list to detect open PRs before branch deletion, gracefully handles missing gh CLI (#107)
- Worktree cleanup uses frontend-driven flow with modal for uncommitted changes; backend isolated in worktreeCleanup.js service using execFileSync for shell injection prevention (#101)

**Security and validation**
- Path traversal protection centralized in safeResolvePath(): resolve path, check it starts with home directory, reject if outside (#53, #97)
- Git operations use execFileSync with argument arrays to prevent command injection (#53)
- Bearer token authentication for WebSocket and API endpoints (#54)
- Server ownership checks use case-insensitive path matching via CASE_INSENSITIVE_FS constant (#139, #141)
- All file operations validate paths against home directory boundary; evals validate against project root (#111)

**Database patterns**
- Postgres async/await with query() and parameterized $1, $2 syntax throughout (#22, #25)
- fullResults: true flag passed to Neon client to return accurate rowCount for UPDATE/DELETE statements, enabling proper 404 detection (#125)
- Session metrics (lines_added, lines_removed, uncommitted counts) incrementally updated during tool event processing and stored in database rather than computed on demand (#47, #48)
- Settings backup to .settings-backup.json on every save; restore on init if database empty (#22)

**Context and planning**
- Planning sessions are session_type='planning' that auto-load PRODUCT.md and ARCHITECTURE.md, skip quality review via skipQualityChecks flag (#145)
- MCP tools include mc_get_project_context for session-less context retrieval, notifications/initialized and notifications/cancelled handlers (#164, #167)
- MCP tokens converted from per-project to app-wide scope; clients call mc_list_projects first then specify project_id explicitly (#147)
- stdio-to-HTTP bridge (mcp-stdio-bridge.js) translates Claude Desktop stdio protocol to Mission Control HTTP MCP endpoint using MC_MCP_TOKEN and MC_MCP_URL from environment (#167)
- Compaction detection watches for 40%+ drop in context usage ratio and auto-injects full conversation history via buildCompactionPreamble (#93)

**Context document generation**
- Cached per-PR extractions (context_doc_extractions table), batched rollup (25 PRs per batch), runs tracked in context_doc_runs with WebSocket progress broadcasts (#155)
- gh CLI for PR fetching with parallel processing (#155)
- Final rollup emits delimited markdown (===BEGIN/END=== markers) instead of JSON to avoid escaping overhead (#166)
- Server restart recovery with manual resume and extraction caching (#160)

**Pipeline orchestration**
- Three tables: pipelines, pipeline_stage_outputs, pipeline_stage_prompts; sessions gain pipeline_id/pipeline_stage foreign keys (#159)
- Dependency-injected orchestrator for testability (#159)
- Pipeline chunks tracked in pipeline_chunks table, QA/review outputs parsed for routing (Overall: pass|fail, Blockers: N), escalations recorded when fix cycles exceed cap (#165)
- Phase 1: planning stages 1-3 with approval gates; Phase 2: autonomous implementation stages 4-7 with fix cycles capped at 3 (#159, #165)

**Railway integration**
- Encapsulated in server/services/railway.js with GraphQL mutations (#137)
- Deployment status/logs stored in projects table to survive restarts (#142)
- Status polling: BUILDING → DEPLOYING → SUCCESS/FAILED with build logs surfaced in UI (#142)
- Auto-spawn fix sessions on deployment failure (#143)

**Frontend state management**
- React pinned to 18.3.1 across dependency tree using npm overrides and Vite dedupe to prevent version conflicts (#148)
- Session state uses guard flags (_qualityStopDispatched, _interrupted) to prevent duplicate event handlers (#64, #95)
- 5-second safety-net timer transitions stuck 'working' sessions to 'idle' if exit signal missed (#68)
- Slash commands menu uses forwardRef/useImperativeHandle for keyboard handling (#79)

**File handling**
- File uploads use multer with sanitized filenames and random ID prefixes; attachments metadata stored as JSON in messages.attachments column (#24)
- Session summaries auto-generate asynchronously with LLM or heuristic fallback, extracting key_decisions as JSON array (#2, #12)
- Logging for subsystem debugging: autoname.log captures all AutoName output and stderr (#33)

**Port and deployment**
- Ports read from .env variables with strictPort: true to fail loudly on conflicts (#127)
- Project detail route enriches project objects with sessions array, github_repo, servers array, deployment status from single endpoint (#137, #138)

## Patterns tried and abandoned

**WebSocket architecture**
- Per-session WebSocket connections → single shared connection with subscribe/unsubscribe pattern (#53)
- SessionList 30-second polling → WebSocket broadcasts only (#53)
- Clearing messages on session end → keeping them visible in UI (#53)
- Content-based message deduplication → ID-based matching with last-10-message scan (#53, #65, #69)

**Database and storage**
- SQLite synchronous API with db.prepare() → Postgres async/await with query() and parameterized syntax (#22, #25)
- Preset projects table and seeding → pure filesystem-based project discovery from projects_directory (#14)

**Git and diff tracking**
- Synchronous execSync for git operations → async exec with Promise.all for parallel execution (#32)
- Standalone tool_use event handler → iterate message.content blocks in assistant events (#51)
- Cascading pipeline status logic → independent presence checks for each stage (#51)

**Quality and enforcement**
- PostToolUse hook in .claude/settings.json for PR automation → quality rules trigger system (#81)
- Sequential quality rule execution (for loops) → parallel execution with Promise.all (#82)
- Direct Anthropic SDK integration → centralized LLM Gateway service with OpenAI-compatible format (#41)
- Quality checks via CLI hooks → server-side detection from stream events with hybrid CLI/API execution (#35, #44)

**UI and interaction**
- Auto-expanding file tree folders to depth 2 → default collapsed with sessionStorage persistence per session (#6)
- Timestamp-based session names → AI-generated names via Claude Haiku after first user message (#18)
- Global previewUrl state → per-session previewUrls object keyed by sessionId (#8)
- Cyan running session indicators → green throbbing outlines for working, yellow for waiting (#4)
- Tool call counts on session cards → diff totals showing lines added/removed (#47, #49, #50)
- Message counts on session cards → diff totals display (#50)
- Browser confirm() dialogs for non-destructive actions → immediate action execution (#29)
- Status guards preventing message sends in non-working states → trust sendMessage to handle state internally (#88)
- Optimistic UI updates for cancellation and deletion → server broadcast as single source of truth (#91, #92)
- Escape key for interrupt → SIGINT (Ctrl+C) for actual process termination (#102)
- Enter to send message → Cmd/Ctrl+Enter to send (desktop), Enter for newline as default (#108)
- CSS variable for selected session tile → hardcoded darker tan color (#122)
- Desktop-only keyboard shortcuts → responsive behavior with different shortcuts for mobile vs desktop (#123)
- Hardcoded model IDs scattered across files → centralized config with environment overrides (#121)
- Dated model names for gateway → undated model name formats (#124)
- Hardcoded dev server ports → environment variable configuration with strict port enforcement (#127)
- Per-project MCP token scoping → app-wide tokens with explicit project_id arguments (#147)
- Hardcoded WebSocket URLs (:3001) → dynamic URLs from window.location.host (#129)
- Instant "Live" deployment claim → real-time status polling with build logs (#142)
- Assistant messages appearing all at once → streaming incrementally as they arrive (#150)
- Context doc JSON string extraction → delimited markdown blocks to prevent truncation (#166)
- PR prompts starting with `--` → prompts prefixed with `--` separator and `===` banners (#156)
- Output tailing from end-of-file → tailing from start with UUID-based deduplication → reverted back to end-of-file tailing (#161, #162)
- Per-project decisions form → centralized decisions dashboard with thinking-partner chat (#163)
- Confirmation dialogs on all context doc actions → confirmation only for destructive overwrites (#168)

**Features removed entirely**
- Max effort toggle feature → completely removed from codebase (#112)
- Planning session timeouts and rate limits → removed since they run as tmux CLI processes, not API calls (#151)

## Integration points

**Claude CLI**
- Invoked as subprocess with --print --input-format stream-json --output-format stream-json
- MCP servers configured via --mcp-config with nested JSON structure
- Tmux wrapping for persistence and reconnection
- Stream event parsing for tool calls, assistant messages, and context updates

**GitHub**
- gh CLI for PR listing to prevent destructive branch deletion (#107)
- gh CLI for PR fetching during context document generation (#155)
- GitHub integration for project creation workflow from repository READMEs (#17)
- Auto-creation of .mission-control.yaml config in git repositories (#113)

**Railway**
- GraphQL API via server/services/railway.js for deployment mutations (#137)
- Status polling and build log retrieval (#142)
- Environment variable copying for deployment configuration (#137)

**LLM Gateway**
- OpenAI-compatible HTTP API via llmGateway.js service (#41)
- Voice transcription proxied through backend to keep API key server-side (#129)
- Hybrid execution mode with free CLI fallback (#44)

**MCP (Model Context Protocol)**
- HTTP endpoint for main UI sessions
- stdio-to-HTTP bridge for Claude Desktop integration (#167)
- Tools: mc_list_projects, mc_get_project_context, mc_create_session, mc_send_message, mc_escalate_question (#145, #147, #164)
- App-wide token scope with explicit project_id arguments (#147)

**Neon Database**
- Serverless Postgres via @neondatabase/serverless driver (#22)
- Connection pooling and async/await throughout
- fullResults: true for accurate rowCount on mutations (#125)

**Tmux**
- Session spawning with `tmux new-session -d -s <session-name>`
- Session listing and reconnection on server startup
- Output polling at 100ms intervals
- SIGINT delivery for session interruption (#95, #102)

## Key technical decisions

**Tmux wrapping for session persistence**
Sessions wrap Claude CLI in tmux rather than running as direct child processes. This enables server restarts without losing session state, with context recovery from database on reconnection. Tmux output is polled at 100ms intervals (#12, #83).

**Server-side quality rule execution**
Quality checks execute server-side by detecting patterns in stream events rather than relying on Claude CLI lifecycle hooks. This centralizes enforcement logic and enables hybrid execution modes (free CLI or paid API) (#35, #44, #80, #81).

**Single shared WebSocket connection**
All clients share one WebSocket connection with subscribe/unsubscribe pattern instead of per-session connections. This reduces overhead and simplifies state management. Session resumption replays history from database to handle reconnection (#53, #59).

**Streaming message updates via message.id indexing**
Assistant messages are indexed by Anthropic message.id to enable in-place updates during streaming. DB-loaded messages are reconciled by content match. This prevents duplicate messages while allowing real-time updates (#150).

**Delimited markdown for context documents**
Context document rollup emits delimited markdown (===BEGIN/END=== markers) instead of JSON to avoid escaping overhead and truncation issues with large documents. This format is more robust for LLM parsing (#166).

**Case-insensitive path matching for cross-platform compatibility**
Session-to-project linking uses LOWER() comparisons on paths to handle macOS/Windows filesystem behavior. Deepest-match-wins for nested projects. Server ownership checks use CASE_INSENSITIVE_FS constant (#139, #141, #158).

**Parallel quality rule execution**
Quality rules execute in parallel via Promise.all rather than sequential for loops. This improves performance when multiple rules trigger on the same event (#82).

**AbortController for surgical cancellation**
Quality checks use AbortController pattern passed through execution layers (cliAgent, llmGateway) to enable surgical termination of individual checks without affecting the session (#89, #91, #94).

**Postgres over SQLite**
Replaced SQLite synchronous API with Postgres async/await for scalability and better concurrency handling. All queries use parameterized syntax ($1, $2) to prevent SQL injection (#22, #25).

**Centralized LLM Gateway service**
All LLM calls route through llmGateway.js service using OpenAI-compatible format instead of provider-specific SDKs. This enables hybrid execution modes and centralizes API key management (#41, #44).

**Path validation at system boundaries**
All file operations validate paths via safeResolvePath() to enforce home directory boundary. Git operations use execFileSync with argument arrays to prevent command injection. Evals validate against project root (#53, #97, #101, #111).

**Database-backed message queue**
Queued messages persist in queued_messages table instead of in-memory array. This prevents message loss on server restart and enables queue draining without duplication via fromQueue flag (#154).

**Cached PR extractions for context docs**
Context document generation caches per-PR extractions in database to avoid re-processing on partial failures. Batched rollup (25 PRs per batch) with WebSocket progress broadcasts (#155, #160).

**Session state guards for concurrency safety**
Session state uses guard flags (_qualityStopDispatched, _interrupted, resumeInProgress) with try-finally cleanup to prevent duplicate event handlers and stuck states (#64, #85, #95).

**Incremental metric updates over computed values**
Session metrics (lines_added, lines_removed, uncommitted_count) are incrementally updated during tool event processing and stored in database rather than computed on demand. This improves performance and enables historical tracking (#47, #48).