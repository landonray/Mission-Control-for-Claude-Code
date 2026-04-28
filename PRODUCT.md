# Product

> Auto-generated from PR history. Edit freely — future roll-ups will preserve manual additions.

## Purpose and scope

Command Center (also referred to as Mission Control) is a web-based dashboard for managing remote Claude Code sessions. It enables users to:

- Create and manage multiple concurrent Claude Code sessions with filesystem isolation via git worktrees
- Monitor session activity in real-time through a three-panel desktop layout (session list, chat/files/CLI, preview panel)
- Run automated quality checks on code changes during implementation
- Execute comprehensive test suites (evals) on project state
- Run planning sessions that can escalate decisions to project owners
- Orchestrate multi-stage autonomous pipelines from spec refinement through code review and PR creation

The system runs as a Node.js Express server wrapping Claude CLI processes in persistent tmux sessions, with a React frontend communicating via WebSocket for real-time updates.

## Key features and current state

### Session management
- **Creation modes**: Manual sessions from dashboard, project-based sessions with optional GitHub template auto-setup, worktree-isolated sessions with automatic branch creation, and programmatic sessions via MCP tools (see #1, #14, #17, #7, #145)
- **Persistence**: Sessions survive server restarts via tmux wrapping with automatic recovery; CLI session IDs persisted to database enable proper resumption without synthetic preambles (see #12, #180, #183)
- **Types**: Five session types — `manual` (teal 'M' badge, default for dashboard-created sessions), `implementation`, `planning`, `extraction`, `eval_gatherer`, `spec_refinement`, `qa_design`, `implementation_planning`, `qa_execution`, `code_review` — with type-specific timeouts and quality check behavior (see #145, #173)
- **Auto-naming**: AI-generated session names from Claude Haiku after first user message, with validation (≤8 words, ≤60 chars); works for project-created and worktree sessions by detecting project/worktree basename (see #18, #28, #33, #45)
- **Archiving and filtering**: Sessions can be archived to hide from default view; dashboard filters to show only non-ended sessions by default with toggle controls and count badges (see #4, #13)
- **Queueing**: User messages queue when agent is busy and persist across server restarts via `queued_messages` table; users can delete queued messages or interrupt running operations to send queued messages immediately (see #25, #89, #92, #95, #154)
- **Context recovery**: Automatic re-injection of up to ~50k characters of conversation history when Claude's context window compacts (detected by 40%+ usage drop from above 40%) (see #93)
- **Resumption**: Builds context preamble from summary + key_decisions + original task + modified files + last 5 exchanges + git status; plan mode enforcement via prompt prefix injection since CLI ignores --permission-mode flag on resume (see #12, #76)
- **Safety net**: 5-second timer prevents stuck "working" state; stale status detection on WebSocket subscribe cross-checks database vs in-memory process state (see #64)
- **Status transitions**: Inserts 'reviewing' state while quality checks run; inserts 'waiting_for_owner' during planning escalations; graceful degradation prevents stuck sessions (see #75, #151, #175)

### Real-time communication
- **Chat interface**: Messages appear immediately when queued; streamed assistant messages update in-place indexed by Anthropic message.id; quality check results render with spinners and update in-place (see #25, #75, #150)
- **Voice input**: Record voice messages up to 2 minutes with automatic transcription via LLM Gateway Whisper API; auto-send on stop; state-aware UI with timer and error handling (see #129, #131, #132)
- **File attachments**: Upload via click/drag/paste with 20MB limit, image thumbnails, immediate server storage in `/uploads` directory; non-image attachments in session messages are candidates for spec documents (see #24, #63)
- **Slash commands**: Define reusable prompts triggered by typing `/` in chat input; stored in `slash_commands` table with full CRUD API (see #79)
- **Merge fields**: Dynamic placeholder resolution (e.g., `{{last_pr}}`) in chat messages and quality rule prompts via centralized registry with async resolvers (see #126)
- **Copy messages**: Hover-revealed copy button on messages with check-mark confirmation; two-tier fallback (navigator.clipboard → execCommand) (see #149)
- **Sanitization**: Strips hallucinated harness tags (`system-reminder`, `command-name`, `command-message`, `command-args`, `local-command-stdout`, `local-command-stderr`) from assistant messages both server-side and client-side to prevent Claude from treating its own output as system instructions (see #185)
- **Adaptive keyboard shortcuts**: Desktop uses Enter to send, mobile uses Cmd/Ctrl+Enter (see #108, #123)

### File browser and preview
- **File tree**: Collapsible file tree with session-scoped expansion state persisted to sessionStorage; defaults to collapsed (see #1, #6)
- **Inline editing**: Edit text/markdown/HTML files directly in browser with Cmd+S save shortcut; path traversal protection via `safeResolvePath()` validation (see #98, #97)
- **Git integration**: Display worktree badges, diff stats (lines added/removed), branch comparisons defaulting to main; real-time git status updates (see #1, #7, #20, #32, #47, #49, #50)
- **Preview panel**: "Run Server" button with auto-tab-switching when dev server detected; tracks URLs per session; pinned dev server ports (3001 backend, 5173 frontend) to avoid cross-project conflicts (see #8, #127)
- **CLI panel**: Displays tool calls and bash commands from nested stream-json blocks with database persistence; loads historical events from `/api/sessions/:id/stream-events` on navigation (see #42, #59)

### Quality rules system
- **Rule library**: 35 configurable lifecycle rules defaulting to off for most; rules cover error handling, code complexity, security patterns, test coverage, documentation, etc. (see #1, #2, #9)
- **Execution backends**: Per-rule mode selection — 'cli' mode uses free Claude CLI agent with `claude --print` subprocesses, 'api' mode uses LLM Gateway (previously Anthropic SDK); defaults to CLI mode (see #35, #41, #44, #46)
- **Triggers**: Eight supported lifecycle events — tool use, session stop, plus composite triggers like `PRCreated` that detect command patterns (`gh pr create`, `git push`) in Bash tool usage server-side (see #9, #46, #80, #81)
- **Enforcement**: Rules with `send_fail_to_agent` enabled send structured failure messages back to agent; failures collected and sent after 500ms delay; enforcement rules requiring spec skip entirely when no spec present (see #40, #63, #74)
- **Iteration limits**: Quality review loop capped at 3 iterations maximum, resets on manual user message; duplicate quality checks on session stop prevented via guard flag (see #66, #68)
- **Visibility**: Results render immediately with spinners in chat log, update in-place; session cards display green "reviewing" state while checks run; results persist across navigation via database storage (see #61, #75, #77)
- **Cancellation**: Individual abort controls for each running check with SIGTERM/fetch cancellation (see #89, #91, #94)
- **On-demand execution**: Play buttons to run individual rules on demand; scrollable rules list in UI (see #118)
- **Spec handling**: Spec detection follows two-tier fallback — on-disk files (`spec.md`, `SPEC.md`) then message attachments; `has_spec` flag persisted to sessions table (see #63, #74)
- **Project-specific overrides**: Per-project customization of rule prompts, severity, and triggers (see quality rules API endpoints)
- **Analytics**: Quality Analytics dashboard accessible from sidebar (see #34)

### Evals system
- **Organization**: Folder-based organization with YAML definitions; per-project armed/disarmed state; configurable retention policies (see #111)
- **Evidence gathering**: Collects evidence from session logs, build output, PR diffs, database queries, and sub-agents with enforced sandboxing (restricted tool set, plan-only permission, no MCP, scoped cwd) (see #111)
- **Check types**: Automated checks support `equals`, `contains`, `greater_than`, `less_than`, `numeric_score` with JSON field extraction via dot notation (see #115)
- **LLM judge**: Final verdicts rendered by LLM judge after automated checks; low-confidence indicators shown in UI (see #111)
- **Triggers**: Execute on `session_end` or `pr_updated` (via PR watcher service polling GitHub every 2 minutes) (see #111)
- **UI**: Quality tab with drill-down views; create eval folders and individual evals directly from UI with comprehensive validation; preview runs before publishing (see #111, #116)
- **AI authoring**: Natural language descriptions generate eval drafts via server-side CLI agent; draft-review-publish workflow with iterative refinement; WebSocket broadcast for real-time progress (see #120)
- **Security**: Path traversal prevention, input validation, read-only DB transactions, parameterized SQL, sub-agent isolation (see #111)

### Pipelines
- **Multi-stage orchestration**: Seven-stage workflow from spec refinement through code review — (1) Spec Refinement, (2) QA Design, (3) Implementation Planning, (4) Implementation (chunked), (5) QA Execution, (6) Code Review, (7) Complete (see #159, #165, #169, #186)
- **Approval gates**: Configurable per-pipeline gating via `gated_stages` JSONB column; defaults to stages 1-3 requiring approval; stages 4-7 run autonomously; gateable stages restricted to [1,2,3,5,6] (see #159, #177)
- **Chunk-based implementation**: Stage 4 parses build plan into chunks executed serially; chunk progress tracked in `pipeline_chunks` table (see #165, #169)
- **Fix cycles**: QA and review stages use output parsing to detect failures and retry; capped at 3 iterations before escalation (see #165, #174, #177)
- **Escalation**: When stuck, pipelines create escalations requiring project owner input via `pipeline_escalations` table (see #177)
- **Sessions and types**: Each stage runs in dedicated session with type-specific behavior; sessions close on stage transitions except during approval pauses (see #159, #175, #176)
- **Recovery**: Automatic sweep on server startup marks orphaned 'working' sessions as ended and re-enters orchestrator flow; stage-4 chunks reset to pending, other stages handed to normal completion flow (see #175)
- **PR creation**: Auto-create GitHub pull requests on completion with unique branch names per pipeline (`pipeline-<slug>-<8-char-id>`); manual retry UI when auto-creation fails (see #179, #184, #186)
- **Outcome summary**: Permanent "What happened" panel showing outcome, PR status, branch links, stage progress, fix cycles used, and timing (see #179, #186)
- **MCP tools**: `mc_start_pipeline` (with file attachment support), `mc_get_pipeline_status`, `mc_approve_stage`, `mc_reject_stage`, `mc_recover_pipeline` (see #169, ground-truth)

### Planning sessions and decision management
- **MCP-driven planning**: Planning sessions invoked via MCP tools (`mc_start_session` with `session_type: 'planning'`); auto-load PRODUCT.md/ARCHITECTURE.md context; write decisions to `docs/decisions.md` (see #145, #147)
- **Escalation workflow**: ESCALATE block parsing detects owner-input questions; status='waiting_for_owner' during escalation; owner answers logged via `/api/planning/escalations/:id/answer` and optionally appended to PRODUCT.md/ARCHITECTURE.md (see #151)
- **Unified Decisions dashboard**: Groups planning escalations and pipeline stage approvals by project; accessible from main navigation (see #163, #171)
- **AI thinking-partner**: Chat threads for each decision with LLM assistance via `decision_chats` table; polymorphic subject_type/subject_id columns support both escalation types (see #171)
- **Decision log format**: Locked format with timestamp, asking_session_id, planning_session_id, working_files, question, answer (see #145)
- **No rate limits**: Planning sessions (tmux CLI processes) have no rate limits or timeouts; passive usage tracking via `/api/planning/usage` (see #151)

### Projects and infrastructure
- **Discovery**: Filesystem-based project discovery walking up directory tree for `.mission-control.yaml`; falls back to git root detection and auto-creates default config (see #14, #113)
- **Auto-setup**: Optional auto-setup from GitHub README templates; planning agent reads README and runs installation with explicit port-selection rules (use existing PORT from .env, pick 4100–4999, verify with lsof, persist in .env and CLAUDE.md) (see #17, #136)
- **Cloning**: Clone from GitHub mode supporting https/SSH/shorthand URLs via `gh repo clone`; auto-setup agent runs post-clone; default `.mission-control.yaml` injected (see #135, #136)
- **Project detail page**: `/projects/:id` page showing metadata, local dev servers with kill controls (ownership verified via cwd), session history, Railway hosting with one-click deploy (see #137, #138, #139, #140, #141, #142, #143)
- **Test runs tracking**: Automated detection of test commands (vitest, jest, pytest); LLM-based output parsing via free Claude CLI agent; `test_runs` table with live WebSocket updates; Test Runs panel on project detail page (see #153)
- **Context document generation**: Manual Generate Context Docs button with live progress tracking; per-PR extractions cached using Sonnet; batched roll-up in chunks of 25 PRs; retries resume from cached work; file preview modals; output in delimiter-based markdown blocks (===BEGIN/END===); PRODUCT.md and ARCHITECTURE.md generated (see #155, #157, #160, #166, #168)
- **Server management**: List local dev servers (lsof finds listeners on pinned PORT/VITE_PORT); kill servers with ownership validation (process cwd must be inside project path) (see #137, #139)
- **Railway hosting**: One-click deploy creates Railway project, service from repo, provisions env vars (excluding PORT, VITE_PORT, NODE_ENV), and provisions public domain; cleanup deletes empty Railway projects on failure; postinstall hook installs client dependencies; setup.sh skips Neon database setup when DATABASE_URL present (see #137, #140, #141)
- **Case-insensitive matching**: Project discovery uses LOWER() comparisons throughout; deepest (longest) root_path wins when multiple projects match (see #158)

### MCP server
- **Protocol**: JSON-RPC 2.0 over HTTP (not stdio/SSE) with app-wide bearer tokens stored in `mcp_tokens` table; stdio-to-HTTP bridge available for Claude Desktop (see #145, #147, #167)
- **Authentication**: Previously per-project tokens, now app-wide with project_id passed explicitly on tool calls (see #147)
- **Tools**: 13 total — `mc_list_projects`, `mc_start_session`, `mc_send_message`, `mc_get_session_status`, `mc_get_project_context`, `mc_list_project_files`, `mc_read_project_file`, `mc_write_project_context`, `mc_start_pipeline`, `mc_get_pipeline_status`, `mc_approve_stage`, `mc_reject_stage`, `mc_recover_pipeline` (see ground-truth)
- **File operations**: `mc_list_project_files` browses tree with configurable depth (default 3, max 10); `mc_read_project_file` reads contents with 1MB cap and binary detection (NUL-byte heuristic on first 4KB); `mc_write_project_context` restricts writes to PRODUCT.md and ARCHITECTURE.md only; all paths validated via `resolveProjectPath()` against project root (see #182)
- **Context tools**: `mc_get_project_context` returns {exists, path, content} tuples for PRODUCT.md/ARCHITECTURE.md/decisions.md; missing files return gracefully instead of throwing (see #164)
- **Setup guides**: Tabbed configuration snippets for Claude Code (HTTP) and Claude Desktop (stdio); descriptions read from PRODUCT.md → README.md → CLAUDE.md in priority order (see #147)

### Mobile experience
- **Layout**: Horizontal scrolling session cards with snap behavior; session title in back nav bar; responsive header with proper truncation (see #67, #70, #71)
- **Navigation**: Context-aware tabs — Dashboard+Settings when browsing, Chat+Files+Preview when in session; Quality tab added for evals/rules (see #3, #13, #19, #21, #105, #119)
- **PWA support**: Installable progressive web app (see #1, #2)
- **Responsive fixes**: Chat message overflow corrected with flexbox min-width: 0 pattern; padding tightened; message width 100% on mobile; mobile-appropriate composer placeholder (see #128)

### UI and visual design
- **Theme**: Retro surfer aesthetic with warm cream/sand palette, grain textures, embossed effects, Quicksand font (see #30, #31)
- **Background images**: Artistic backgrounds on left and right panels (see #109, #110)
- **Status indicators**: Gradient buttons with glow shadows; throbGreen/throbYellow animations for working sessions; session type badges with color coding (teal 'M' for manual, green 'I' for implementation) (see #4, #21, #173)
- **Tone-coded pills**: CSS classes (`.tone_success`, `.tone_info`, `.tone_warn`, `.tone_error`, `.tone_muted`) for consistent visual feedback across pipeline states, quality results, etc. (see #186)
- **Selected session**: Darker tan background (#d0bb9c) for visual distinction (see #122)

### Model configuration
- **Centralized config**: Single config file (`server/config/models.js`) with roles (default, fast, strong, quality) and env var override capability (see #121)
- **Dynamic selection**: Frontend fetches configuration from `/api/models` instead of defining locally (see #121)
- **Default model**: Claude Opus 4.7 (upgraded from Opus 4.6) (see #121)
- **Effort levels**: xHigh effort level for Opus 4.7 with automatic downgrade for non-supporting models; persisted per session and as app-wide default (see #126)
- **Gateway compatibility**: Uses undated model identifiers (e.g., `claude-haiku-4-5`) instead of dated versions (see #124)

### Session search
- **Real-time filtering**: 300ms debounced search across session titles, last actions, and message content (see #86, #87)
- **Backend integration**: Local filtering for title/lastAction, remote `/api/history/search` for message content; results stored as Set of session IDs (see #87)
- **Collapsible groups**: Project-based grouping with expand/collapse controls (see #86)

### Worktree management
- **Automatic cleanup**: On session end, clean worktrees deleted silently; uncommitted changes trigger modal with commit & keep branch, delete everything, or leave as-is options (see #101)
- **GitHub PR detection**: Warning modals with "Keep Branch" option prevent accidental PR closures during cleanup (see #107)
- **Auto-recreation**: Resume logic recreates missing worktree directories from branches (see #104)
- **Interrupt handling**: SIGINT (Ctrl+C) stops agent and skips quality checks for interrupted work; signal trap ensures exit sentinel written on interrupt (exit code 130) (see #102)

## Product decisions and rationale

### Session persistence and recovery
**Current approach**: Sessions wrapped in tmux with file-based output tailing (100ms polling); `recoverTmuxSessions()` on startup to reconnect; CLI session IDs persisted to database and restored on resume; tmux recovery completes before HTTP server starts listening to ensure active session map populated before WebSocket connections (#12, #180, #183). **Rationale**: Enables sessions to survive server restarts and allows resuming ended sessions by continuing the conversation. **Alternative considered**: Direct process spawning without tmux would lose sessions on restart.

### Quality check execution backends
**Current approach**: Per-rule mode selection with 'cli' as default using free `claude --print` subprocesses; 'api' mode uses LLM Gateway (#44, #46). **Rationale**: CLI execution avoids API costs for routine quality checks. **Previous approach**: Exclusive LLM Gateway API execution (#41, 2026-04-02).

### Quality check iteration limits
**Current approach**: Capped at 3 iterations maximum per session, reset on manual user message (#66, #68). **Rationale**: Prevents infinite loops when rules fail with send_fail_to_agent enabled. **Alternative considered**: Unbounded iteration would allow quality-fix cycles to run indefinitely.

### Permission mode defaults
**Current approach**: `--permission-mode acceptEdits` (auto-approve edits) as default (#2). **Previous approach**: 'default' mode prompted everything (#1, 2026-03-29). **Rationale**: Reduces friction for typical coding workflows where edit approvals are noise.

### Session auto-naming
**Current approach**: AI-generated names from Claude Haiku after first user message, validated (≤8 words, ≤60 chars) (#18, #33). **Previous approach**: Timestamp-based names (#1, 2026-03-29). **Rationale**: Human-readable names improve discoverability and reduce cognitive overhead when managing multiple sessions.

### Database backend
**Current approach**: Neon serverless Postgres with async/await query wrapper (#22). **Previous approach**: better-sqlite3 synchronous SQLite (#1, 2026-03-29). **Rationale**: Postgres enables multi-user deployments and remote access; async patterns match Node.js conventions.

### Pipeline approval gating
**Current approach**: Configurable per-pipeline via `gated_stages` JSONB column; defaults to stages 1-3 requiring approval (#159, #177). **Rationale**: Allows project owners to control autonomy level; critical early stages (spec, QA design, plan) default to requiring review while implementation/QA/review can run autonomously.

### Planning session constraints
**Current approach**: No rate limits or timeouts for planning sessions (tmux CLI processes); passive usage tracking via `/api/planning/usage` (#151). **Previous approach**: 10/hour rate limit and 180-second default timeout (#145, 2026-04-25). **Rationale**: Planning sessions need extended thinking time and don't consume metered resources the same way API calls do; HTTP request timeout semantics don't apply to long-running tmux processes.

### MCP token scoping
**Current approach**: App-wide tokens with project_id passed explicitly on tool calls (#147). **Previous approach**: Per-project tokens where each token was scoped to single project_id (#145, 2026-04-25). **Rationale**: Simplifies token management; allows single Claude Desktop configuration to access all projects; aligns with typical API key patterns.

### Enter key behavior
**Current approach**: Adaptive by screen size — desktop Enter sends, mobile Cmd/Ctrl+Enter sends (#123). **Previous approach**: Uniform Cmd/Ctrl+Enter across all platforms (#108, 2026-04-15). **Rationale**: Desktop users expect Enter to send in chat interfaces; mobile users need Enter for newlines due to smaller keyboards.

### Context document triggers
**Current approach**: Manual-only button for Generate Context Docs (#155). **Deferred**: Automatic PR-merge webhook and scheduled job automation. **Rationale**: Manual trigger gives users control; automatic generation can be added later when usage patterns stabilize.

### Worktree defaults
**Current approach**: Worktree isolation enabled by default (#7). **Rationale**: Prevents file conflicts when running multiple sessions in same project; follows git worktree best practices.

### Model selection and effort levels
**Current approach**: Centralized model config with dynamic frontend fetching; xHigh effort restricted to Opus 4.7 with auto-downgrade (#121, #126). **Rationale**: Keeps model capabilities in sync with backend; prevents users from selecting effort levels unsupported by chosen model.

### Pipeline branch naming
**Current approach**: `pipeline-<slug>-<8-char-id>` to prevent collisions (#184). **Previous approach**: `pipeline-<slug>` caused non-fast-forward push failures (#179, 2026-04-27). **Rationale**: Multiple pipelines for same spec need unique branch names; last 8 chars of UUID sufficient for uniqueness.

### Session type defaults
**Current approach**: 'manual' type with teal 'M' badge as default for dashboard-created sessions (#173). **Previous approach**: 'implementation' type as default (pre-#173). **Rationale**: Better semantic clarity; implementation type should be explicit choice or pipeline-assigned.

## Scoping decisions

### Quality check capabilities
- Quality checks run server-side watching streaming events, not as CLI hooks (#35). Hook-based PostToolUse approach removed (#81, 2026-04-07).
- Quality checks have git context and tool access via `--allowedTools` flag when running in agent mode (#57).
- Quality checks requiring spec skip entirely when no spec present instead of failing noisily (#63, #74).

### Session state management
- In-memory status takes precedence over database with automatic reconciliation (#26).
- Sessions preserve full conversational context across restarts via tmux + database (#12, #180, #183).
- Message queue persisted to `queued_messages` table with rehydration on startup/resume (#154).

### File operations
- Attachment storage uses crypto.randomBytes prefix for sanitized filenames (#24).
- Inline editing restricted to text/markdown/HTML files (#98).
- All file paths validated via `safeResolvePath()` to prevent directory traversal (#97, #182).

### Test and eval execution
- Test detection and parsing are separate pure modules; parser uses free Claude CLI agent instead of regex (#153).
- Eval sub-agents run with enforced sandboxing (restricted tools, plan-only, no MCP, scoped cwd) (#111).
- Test runs table includes raw output truncation (head+tail kept, middle dropped) before LLM parse (#153).

### Context document generation
- Per-PR extractions cached using Sonnet (claude-sonnet-4-5) instead of Haiku for quality (#155).
- Batched roll-up in chunks of 25 PRs to manage token usage (#155, #160).
- GitHub PR fetching via `gh` CLI with 50KB diff truncation (#155).
- Output format uses delimiter-based markdown blocks (===BEGIN/END===) instead of JSON with escaped strings (#166).

### MCP file tools
- `mc_write_project_context` restricts writes to PRODUCT.md and ARCHITECTURE.md only — no arbitrary file writes (#182).
- Binary detection uses NUL-byte heuristic on first 4KB (#182).
- File tree walking capped at depth 10 (#182).

### Pipeline execution
- Stage 4 chunks reset to pending on recovery (too risky to auto-advance) (#175).
- Code review runs in read-only 'plan' permission mode (#159).
- Fix cycles cap at 3 iterations before escalation (#177).

### Mobile UX
- Voice recorder limited to 2 minutes (#129).
- Chat composer placeholder simplified on mobile (no keyboard shortcuts) (#128).

## Superseded product decisions

### Error handling
**Current state**: Chat input always enabled unless empty; error state cleared when sending new message (#27, 2026-03-30). **Previously**: Input disabled during ERROR state (#26, 2026-03-30). **Reason**: Allows users to retry failed operations without being locked out.

### Session end confirmation
**Current state**: No confirmation dialog (#29, 2026-03-31). **Previously**: Browser confirm() dialog on end session (pre-#29). **Reason**: Reduces friction for intentional actions; users can always resume.

### File tree expansion
**Current state**: Default collapsed with session-scoped persistence (#6, 2026-03-30). **Previously**: Auto-expand two levels deep (#1, 2026-03-29). **Reason**: Cleaner initial view; users expand what they need.

### Session grouping on mobile
**Current state**: Project-based groups (#13, 2026-03-30). **Previously**: Active/Recent status grouping (#1, 2026-03-29). **Reason**: Better aligns with user mental model.

### Project creation
**Current state**: Filesystem-based discovery (#14, 2026-03-30). **Previously**: Preset database table with icons/descriptions/MCP configs (#1, 2026-03-29). **Reason**: Reflects actual directory structure; eliminates manual preset maintenance.

### Message queueing visibility
**Current state**: Messages appear immediately in UI when process busy (#25, 2026-03-30). **Previously**: Hold-until-ready behavior (#1, 2026-03-29). **Reason**: Gives users immediate feedback that input was received.

### Auto-scroll behavior
**Current state**: Conditional scroll based on user position (within 150px of bottom) (#3, 2026-03-30). **Previously**: Unconditional scroll-to-bottom (#1, 2026-03-29). **Reason**: Respects user reading position.

### Session card metrics
**Current state**: Git diff totals (+N -N) with always-visible display (#50, 2026-04-02). **Previously**: Message counts (#1 and earlier), then conditional diff display (#48, 2026-04-02). **Reason**: Diff stats more meaningful for code review; always showing them highlights productivity.

### Quality check backend
**Current state**: Defaults to CLI mode via cliAgent.js (#44, 2026-04-02). **Previously**: Exclusive LLM Gateway API execution (#41, 2026-04-02). **Reason**: CLI execution is free and fast for routine checks.

### Max Effort toggle
**Current state**: Completely removed (#112, 2026-04-15). **Previously**: Per-session Max Effort toggle in session controls dropdown (#106, 2026-04-12). **Reason**: Feature removed during development; replaced by xHigh effort level for Opus 4.7 (#126).

### Assistant message streaming
**Current state**: Updates messages in place indexed by Anthropic message.id with lookback reconciliation (#150, 2026-04-25). **Previously**: Exact-content deduplication that returned early when content matched and blocked in-place growth (pre-#150). **Reason**: Supports real-time streaming updates visible to user.

### Clipboard copy implementation
**Current state**: Two-tier fallback (navigator.clipboard → execCommand) with error logging (#149, 2026-04-25). **Previously**: Only navigator.clipboard.writeText with empty catch block (pre-#149). **Reason**: Increases compatibility with older browsers and non-HTTPS contexts.

### Session list ordering
**Current state**: Sorted by created_at DESC (#73, 2026-04-06). **Previously**: Sorted by last_activity_at causing cards to reorder during interaction (pre-#73). **Reason**: Predictable stable ordering reduces cognitive load.

### Worktree cleanup
**Current state**: Automatic cleanup on session end with modal for uncommitted changes (#101, 2026-04-09). **Previously**: Manual cleanup only (pre-#101). **Reason**: Reduces filesystem clutter; modal prevents accidental data loss.

### Interrupt mechanism
**Current state**: SIGINT (Ctrl+C) with quality checks skipped for interrupted sessions (#102, 2026-04-09). **Previously**: Escape key interrupt (#95, 2026-04-09). **Reason**: SIGINT is standard signal for process interruption; properly terminates tmux processes.

### Spec presence detection
**Current state**: Persistent has_spec flag set on first user message (#74, 2026-04-06). **Previously**: Attachment-only approach failed on session resume (pre-#74). **Reason**: Avoids redundant disk scans on every quality check.

### Context doc extraction model
**Current state**: Sonnet (claude-sonnet-4-5) (#155, 2026-04-26). **Previously**: Haiku per original spec (pre-#155). **Reason**: Sonnet produces higher-quality extractions worth the cost.

### Pipeline completion behavior
**Current state**: Stage-3 approval parses build plan into chunks and advances to stage 4 (#165, 2026-04-27). **Previously**: Pipeline ended at stage 3 (#159, 2026-04-27). **Reason**: Phase 2 extends pipeline to full implementation.

### Pipeline gating model
**Current state**: Per-pipeline `gated_stages` JSONB column (#177, 2026-04-27). **Previously**: Hard-coded stages 1-3 gating (pre-#177). **Reason**: Allows project-specific autonomy preferences.

### Sessions API query
**Current state**: UNION ALL with outer ORDER BY created_at DESC, LEFT JOIN to projects table (#178, #181, 2026-04-27). **Previously**: Incomplete ordering after UNION split, filesystem path basename for project names (#178, 2026-04-27). **Reason**: Ensures newest-first ordering; uses authoritative project names.

### CLI session recovery order
**Current state**: Awaited before HTTP server starts (#180, 2026-04-27). **Previously**: Fire-and-forget call allowing websocket connections before active session map populated (pre-#180). **Reason**: Prevents race condition where clients connect before sessions are recovered.

### Pipeline PR branch naming
**Current state**: `pipeline-<slug>-<8-char-id>` (#184, 2026-04-27). **Previously**: `pipeline-<slug>` causing non-fast-forward push failures (#179, 2026-04-27). **Reason**: Unique branches for multiple pipelines on same spec.

## Open questions and known gaps

- [REVIEW: Should context doc generation support automatic PR-merge webhook triggers, or keep manual-only?]
- [REVIEW: Test run parser uses "free Claude CLI agent" — clarify what "free" means (cost model? different tier?)]
- [REVIEW: Decision log review workflow described as "asynchronous in batches" — document who/when/how batches are reviewed]
- Historical session data sanitization relies on one-time script plus read-path belt-and-suspenders; unclear if all persisted hallucinated tags from before #185 have been caught
- Fix-cycle wording changed twice in rapid succession (#179→#186); monitor for stability
- Whether 12000-token limit in context doc final rollup is sufficient for very large repositories (hundreds of PRs) not validated