# Product

> Auto-generated from PR history. Edit freely — future roll-ups will preserve manual additions.

## Purpose and scope

Command Center (also called Mission Control) is a web-based dashboard for managing multiple Claude Code sessions. It enables coordinated multi-session workflows including autonomous pipeline orchestration, quality enforcement, eval-driven testing, and planning escalations.

Core capabilities:
- Web UI for creating, monitoring, and interacting with Claude Code sessions
- Autonomous pipeline orchestration with planning and execution stages
- Quality rules and evals for automated validation
- Planning sessions via MCP server for decision-capture workflows
- Railway deployment integration with auto-fix sessions
- Voice input and file attachments for multi-modal interactions
- Context document generation from PR history

## Key features and current state

### Session management
- Sessions run in isolated tmux processes that survive server restarts with automatic recovery (#12, #180)
- Each session can use dedicated Git worktree for isolated development, enabled by default (#7, #20, #104)
- Sessions preserve full conversational continuity across restarts via persisted CLI session IDs (#183)
- Per-session model selection between Opus (default), Sonnet, and Haiku with visual badges (#11)
- AI-powered session naming generates descriptive 3-6 word titles from first user message using Claude Haiku (#18, #28, #45)
- Sessions can be resumed after ending with context preamble reconstruction from summary, task, decisions, modified files, and recent exchanges (#12)
- Manual sessions display with teal "M" badge to differentiate from pipeline/MCP-initiated sessions (#173)
- All active sessions visible in dashboard regardless of ended session backlog (#178, #181)
- Session search across title, last action, and message content with debounced remote queries (#87)
- Collapsible project groups organize sessions by Git repository (#86)

### Chat interface
- Three-panel desktop layout (sessions list, chat, file browser) and mobile-responsive tabbed PWA (#1, #2, #13, #19, #21)
- File attachments via drag-and-drop or paste with immediate upload (#24)
- Voice input with live transcription and auto-send workflow (#129, #131)
- Message streaming with in-place updates during agent responses (#150)
- Copy buttons and clean markdown rendering with proper ordered/unordered list handling (#133, #146, #149)
- Queued messages persist across server restarts and display with queued badge (#154)
- Interrupt button sends SIGINT to stop agent and immediately process queued messages (#102)
- Chat input remains enabled during ERROR states to allow retry attempts (#27)
- Enter key sends on desktop, Cmd+Ctrl+Enter on mobile (#123)
- Context auto-injection after Claude's compaction when context drops 40%+ (#93)

### Quality enforcement
- Quality rules with 21 lifecycle hooks covering session events, tool execution, subagent coordination, context management, and workspace changes (#1, #2, #9)
- Rules execute via CLI agent (free, default) or LLM Gateway (paid) based on per-rule execution_mode toggle (#44)
- Results appear inline in chat with expandable analysis and "Send as message" button (#35, #43)
- Real-time UI feedback with 'reviewing' status during checks (#75)
- Review loop caps at 3 iterations per work cycle, resetting on manual user messages (#66)
- Rules can automatically restart agents when checks fail via send_fail_to_agent flag (#40)
- Composite triggers (PRCreated) match multiple command patterns server-side for PR creation/updates (#80, #81)
- Rules skip when send_fail_requires_spec set and no spec present (#63)
- Cancel button stops running checks via AbortController pattern (#89, #91, #94)

### Evals system
- Folder-organized eval definitions with Evidence → Checks → Judge pipeline (#111, #115)
- Evidence from logs, database, files, or sub-agent subprocess with per-type truncation (#111)
- Checks support equals, contains, comparisons, and numeric_score with JSON field extraction (#115)
- LLM judge with confidence levels for subjective assessment (#115)
- Execution triggers on session_end or pr_updated (polled via gh CLI) (#111)
- AI-assisted authoring via natural language with preview-run before publish (#120)
- Quality tab UI shows eval status and results (#117, #118)
- Sub-agents run in sandboxed CLI with restricted tools, plan-only mode, no MCP, scoped cwd (#111)

### Pipeline orchestration
- Three-stage planning workflow: spec refinement → QA design → implementation planning (#159)
- Autonomous execution stages: implementation → QA → code review → fix cycle (#165)
- Per-pipeline approval gate selection allows choosing which stages pause for human review (#177)
- Pipeline sessions close when work completes but stay open during approval pauses (#175, #176)
- Automatic recovery for sessions orphaned by server restarts (#175)
- Build plans parsed into chunks for incremental work (#165)
- QA reports and code reviews parsed to route autonomous stage transitions (#165)
- Escalations to owner when retry cap exceeded or parse failures occur (#165)
- Auto-creates GitHub PRs on completion with unique branch names to prevent collisions (#179, #184)
- Manual retry if PR creation automation fails (#179)
- Detail page with tone-coded state pills and permanent "What happened" summary panel (#186)

### Decision tracking
- Planning escalations parsed from structured ESCALATE blocks in planning session output (#151)
- Centralized decisions dashboard shows escalations and pipeline approvals (#163, #171)
- LLM thinking-partner chat before locking answers (#163, #171)
- Answers logged to decisions.md and optionally appended to PRODUCT.md/ARCHITECTURE.md (#151)
- Read-only project context access via mc_get_project_context MCP tool (#164)

### Context documents
- Auto-generates PRODUCT.md and ARCHITECTURE.md from PR history via manual button trigger (#155, #166, #168)
- Uses Sonnet for per-PR extraction, caches results for idempotent retries (#155)
- Processes in batches of 25 with live progress tracking (#155)
- Final rollup emits delimited markdown blocks with 12000 token budget (#166)
- Interrupted runs resume using cached extractions (#160)

### File browser
- Syntax highlighting, diff viewer (inline/side-by-side), and live change monitoring (#1, #3, #6)
- Per-session folder expansion state with sessionStorage persistence (#6)
- Inline editing for text/markdown/HTML files with Cmd+S save shortcut (#98)
- Editable file path input for direct navigation (#23)

### Development workflow
- Dev server auto-detection with "Run Server" button and per-session preview URL tracking (#8)
- Session metrics show code impact (diff totals with +N/-N lines) instead of message/tool counts (#47, #49, #50)
- Pipeline status shows uncommitted file counts and cascades correctly (#48, #51)
- Push notifications for task completion, errors, and context warnings (#1, #2, #9)

### Project management
- Filesystem-based discovery with optional AI-driven setup automation (#14, #17)
- Auto-creates .mission-control.yaml at git root when missing (#113)
- GitHub repo cloning with auto-setup and port-conflict-aware initialization (#135, #136)
- Project names resolved from database instead of filesystem paths (#181)

### Deployment and hosting
- Railway integration enables one-click deployment with env sync and live status tracking (#137, #138, #140, #141)
- Auto-spawning Claude fix sessions on Railway deployment failures (#143)
- Test run visibility with auto-detection, LLM-based parsing, and live updates (#153)

### MCP server
- JSON-RPC 2.0 over HTTP with app-wide bearer auth (#145, #147)
- Tools for autonomous planning sessions with decision-log capture and escalation workflow (#145, #147, #151)
- Stdio-to-HTTP bridge for Claude Desktop integration with tabbed UI snippets (#167)
- File tools for reading project files and writing context docs (PRODUCT.md, ARCHITECTURE.md only) (#182)

## Product decisions and rationale

**Session persistence via tmux.** Sessions survive server restarts and can be resumed after ending. Tmux provides process isolation and recovery without requiring custom process management. (#12, #180)

**AI-powered session naming.** Generates descriptive names from first user message instead of timestamps, making session lists more scannable. Uses Haiku to keep costs low. (#18)

**Worktrees enabled by default.** Provides Git isolation without requiring developers to manually manage branches. Worktrees are auto-created on session start and cleaned up on end. (#7, #20, #101)

**Quality checks default to CLI execution.** Running checks through `claude --print` subprocess avoids API costs while maintaining full Claude capabilities. Rules can opt into paid LLM Gateway execution per-rule. (#44)

**Review loop capped at 3 iterations.** Prevents infinite loops while allowing agents to iterate on quality failures. Resets on manual user messages to distinguish automated cycles from fresh work. (#66)

**Pipeline approval gates are configurable.** Per-pipeline gated_stages selection allows owners to choose autonomy vs. control tradeoff per project. Stages 1-3 (planning) and 5-6 (QA, review) are gateable; stage 4 (implementation) always runs autonomously. (#177)

**Context auto-injection after compaction.** When Claude's context drops 40%+ from above 40%, system automatically injects ~50k char conversation history to preserve continuity. Prioritizes recent messages. (#93)

**Queued messages persist to database.** Messages queued while agent is working survive server restarts, preventing message loss during crashes or redeploys. (#154)

**CLI session IDs persisted.** Enables full conversational continuity across restarts by preserving Claude's internal session identity, not just message history. (#183)

**Unique pipeline branch names.** Includes last 8 chars of pipeline ID as suffix (pipeline-<slug>-<8-char-id>) to prevent push collisions when multiple pipelines work on same project. (#184)

**MCP file writes restricted to PRODUCT.md and ARCHITECTURE.md.** Limits blast radius of autonomous planning sessions while enabling them to update living docs. All file operations validate paths against project root. (#182)

**Evals use sub-agent sandboxing.** Evidence-gathering agents run with restricted tools, plan-only mode, no MCP, and scoped cwd to prevent unintended side effects during test execution. (#111)

**Context-doc generation uses Sonnet.** Upgraded from Haiku despite higher cost after quality issues with per-PR extraction. Caches results to enable idempotent retries without re-processing. (#155)

## Scoping decisions

**No automatic worktree cleanup for uncommitted changes.** When ending sessions with uncommitted worktree changes, system shows modal with commit/delete/leave options instead of silently destroying work. (#101)

**No rate limits or timeouts on planning sessions.** Planning sessions run as tmux CLI processes, not API calls, so they don't need API-call semantics like rate limits or timeouts. (#151)

**Session list limited to recent ended sessions.** Dashboard shows all non-ended sessions plus N most recent ended ones via UNION ALL query, preventing ended backlog from hiding active sessions. (#178, #181)

**File tree walking capped at depth 10, file reads at 1 MB.** MCP file tools enforce limits to prevent resource exhaustion from pathological projects. Binary files detected via NUL-byte heuristic and returned as base64. (#182)

**Evidence truncation varies by type.** Evals use different strategies: head+tail for logs, first 100 items for database queries, first 10 files for filesystem evidence. (#111)

**File attachments in pipeline dialog limited to .md/.txt under 512KB.** Client-side FileReader validates MIME type and extension before populating editable textarea. (#169)

## Superseded product decisions

**Current state:** Sessions sort by created_at DESC for stable chronological order (#73, 2026-04-06). **Previously:** Sorted by last_activity_at causing reordering during interaction (#1, 2026-03-29).

**Current state:** Quality checks appear in chat immediately with spinner that updates in-place when complete (#75, 2026-04-06). **Previously:** Only appeared after completion.

**Current state:** Interrupt mechanism sends SIGINT/Ctrl+C via tmux (#102, 2026-04-09). **Previously:** Escape key (#95, 2026-04-09), but Escape was ignored in --print mode.

**Current state:** Chat Enter key behavior: desktop uses plain Enter to send, mobile uses Cmd+Ctrl+Enter (#123, 2026-04-16). **Previously:** Enter created newlines universally (#108, 2026-04-15).

**Current state:** Default model is claude-opus-4-7 (#121, 2026-04-16). **Previously:** claude-opus-4-6.

**Current state:** Quality rules and evals coexist as separate systems (#111, 2026-04-15). **Previously:** Quality rules were the sole automated quality mechanism.

**Current state:** Sessions preserve CLI session IDs across restarts (#183, 2026-04-27). **Previously:** Lost session identity on restart, requiring full context reconstruction.

**Current state:** Pipeline branch names include pipeline ID suffix for uniqueness (#184, 2026-04-27). **Previously:** Used pipeline-<slug> causing push collisions.

**Current state:** File tree expansion defaults to collapsed with sessionStorage persistence (#6, 2026-03-30). **Previously:** Auto-expanded two levels (#1, 2026-03-29).

**Current state:** Preview URL tracking is per-session dictionary (#8, 2026-03-30). **Previously:** Single global string (#1, 2026-03-29).

**Current state:** Session lifecycle hooks cover 21 events across all lifecycle phases (#9, 2026-03-30). **Previously:** Limited to 3 events (PreToolUse, PostToolUse, Stop) (#1, #2, 2026-03-29).

**Current state:** Pipeline stages use independent presence checks (green/yellow/gray) (#51, 2026-04-02). **Previously:** Cascading done/pending logic showed misleading all-green status.

**Current state:** Session cards show diff totals (+N/-N lines) (#50, 2026-04-02). **Previously:** Message counts (#1, 2026-03-29) then tool call counts.

**Current state:** Quality checks route through CLI agent (free, default) or LLM Gateway based on per-rule toggle (#44, 2026-04-02). **Previously:** All checks used paid API calls (#35, 2026-04-01).

**Current state:** Pipeline detail page uses tone-coded state pills and permanent "What happened" summary panel (#186, 2026-04-27). **Previously:** Mixed-signals UI with inline completion banner.

## Open questions and known gaps

**Decision log (docs/decisions.md) integration deferred.** PR #155 mentions incorporating decision log into context-doc generation but does not specify when or how.

**Test run truncation strategy may lose context.** Head+tail approach (drop middle) may lose critical information depending on output structure. (#153)

**Voice recorder timeout and error handling may need tuning.** LLM Gateway 10s timeout and network error handling based on real-world conditions not yet validated. (#129)

**Sub-agent tool transcript stripping may have edge cases.** Boundary-marker parser includes false-positive protection but real-world tool outputs may expose gaps. (#152)

**Worktree cleanup strategy for crashed sessions unclear.** Automatic worktree removal mentioned in hooks but not in session termination flow. (#7, #9, #20, #101)

**Attachment storage lacks cleanup for orphaned files.** No discussion of cleanup when messages deleted or sessions removed. (#24)

**Context-doc generation decision on when to incorporate decision log.** Deferred to future work without timeline. (#155)