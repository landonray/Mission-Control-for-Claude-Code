# Product

> Auto-generated from PR history. Edit freely — future roll-ups will preserve manual additions.

## Purpose and scope

Command Center (Mission Control) is a web dashboard for managing remote Claude Code sessions across multiple projects. It enables:

- Starting, resuming, and monitoring Claude Code agent sessions from a browser
- Real-time streaming of agent activity with file browsing and preview panels
- Automated quality assurance through evals and quality rules
- Multi-stage pipeline orchestration from spec to shipped code
- AI-assisted planning sessions that maintain product and architecture documentation

The system is designed for developers managing multiple Claude-driven codebases, with particular focus on session persistence across server restarts and automated enforcement of project standards.

## Key features and current state

**Session management**
- Sessions spawn inside tmux by default and reconnect on server restart, preserving state across crashes (#12, #83, #85)
- AI-generated session names after first message via Claude Haiku, with inline editing (#18, #90, #124)
- Full-text search across session titles, actions, and message content with collapsible project groups (#86, #87)
- Session cards display code impact metrics: diff totals (lines added/removed), uncommitted counts, and cascading pipeline status (#47, #48, #49, #50)
- Context auto-recovery after Claude compaction events by re-injecting full conversation history (~50k chars, recent messages prioritized) (#93)
- Session interrupt via SIGINT (Ctrl+C) stops the agent and skips quality checks on user-initiated stops (#95, #102)

**Real-time communication**
- Single shared WebSocket at /ws handles streaming, subscriptions, file watching, heartbeat with subscribe_session/unsubscribe_session pattern (#1, #53, #59)
- Assistant messages stream incrementally as they arrive instead of appearing all at once (#150)
- WebSocket URLs derive from window.location.host to work behind Vite proxy including Tailscale (#129)
- Stream event history replays from database on session resume to initialize deduplication state (#59, #161)

**Quality assurance**
- Evals system with folder-based organization, AI-assisted authoring, draft/publish workflow, and auto-triggering on session completion or PR updates (#111, #115, #116, #117, #118, #120)
- Quality rules with 21 lifecycle hooks (all OFF by default) for monitoring and automation across session, context, workspace, and team events (#9)
- Quality checks run server-side via LLM Gateway or free CLI subprocess with per-rule execution mode configuration (#35, #41, #44, #46)
- Real-time execution state with spinners, 'reviewing' status separate from 'working'/'idle', and persistence across page reloads (#75, #77)
- Rule enforcement sends failures back to agent as follow-up messages, forcing continued work until requirements satisfied (max 3 retries) (#40, #66)
- Parallel execution of quality rules via Promise.all for performance (#82)
- Cancellation support via AbortController pattern for surgical termination of individual checks (#89, #91, #94)

**File and attachment handling**
- File attachment support for images, PDFs, code files with drag-drop/paste and 20MB per-file limit (#24)
- Inline file editing in the file browser with automatic worktree cleanup on session end (#98, #101)
- Worktree path persistence across resume cycles with automatic recreation from branches before fallback (#104)
- Prevention of accidental branch deletion when open PRs exist, with warning and branch preservation option (#107)

**Project and repository integration**
- Project creation workflow with GitHub integration and auto-setup from designated repository READMEs (#17)
- Git repositories without `.mission-control.yaml` automatically get config created at session start, enabling quality rules by default (#113)
- Project detail page as central hub for server controls, Railway hosting, sessions, planning activity, and test runs (#137, #138, #145, #153)
- Session backfill links orphaned sessions to projects using case-insensitive path matching, deepest-match-wins for nested projects (#158)

**Voice and mobile UX**
- Voice input with recording, transcription via proxied LLM Gateway, and auto-stop; cancel-without-send supported (#129, #131, #132)
- Mobile-responsive PWA with adaptive navigation, horizontal scrolling session cards, visible session titles in back bar (#3, #13, #19, #67, #70, #71, #72)
- Keyboard shortcuts adapt to screen size: Enter vs Cmd+Enter for send, mobile Quality tab (#108, #123, #105, #119)

**Deployment and hosting**
- One-click Railway hosting with environment variable copying, status polling, build log surfacing, and auto-spawn fix sessions on failure (#137, #138, #142, #143)
- Railway integration with BUILDING → DEPLOYING → SUCCESS/FAILED status tracking and build logs surfaced in UI (#142)
- Claude Desktop MCP support via stdio-to-HTTP bridge with tabbed configuration snippets (#167)

**Planning and documentation**
- Planning sessions (session_type='planning') auto-load PRODUCT.md and ARCHITECTURE.md, skip quality review loop, run without timeouts or rate limits (#145, #151)
- Mission Control MCP server enables Claude Code to escalate product/architecture questions to planning sessions instead of prompting users, with decisions logged to docs/decisions.md (#145, #147, #151)
- Centralized decisions dashboard with LLM thinking-partner chat for conversing through escalated questions before finalizing answers (#163)
- Context document generation (PRODUCT.md and ARCHITECTURE.md) from PR history with live progress tracking, caching, and manual trigger (#155, #166)
- Server restart recovery for interrupted context-doc runs with manual resume and extraction caching (#160)

**Pipeline orchestration**
- Multi-stage pipeline orchestration (Phase 1: planning stages 1-3 with approval gates; Phase 2: autonomous implementation stages 4-7 with fix cycles) takes specs through to shipped code (#159, #165)
- Pipeline chunks tracked for granular progress, QA/review outputs parsed for routing (Overall: pass|fail, Blockers: N), escalations recorded when fix cycles exceed cap of 3 (#165)

**Message and state management**
- Queued chat messages persist across server restarts and drain without duplication via queued_messages table (#154)
- Message queue evolved from ephemeral array to structured objects with IDs/timestamps, synced via WebSocket events (message_queued, message_dequeued, message_deleted) (#89, #92)
- Plan mode enforcement injects read-only prompt prefix on resumed sessions to prevent file editing when plan mode active (#76)
- CLI panel displays actual tool calls and bash commands by parsing nested stream content blocks, with database persistence across reloads (#42)

**Test and build integration**
- Real-time test run detection and parsing during Claude sessions, with pass/fail counts and failure details on project detail page (#153)
- Test detection uses pattern matching over Bash commands; parsing delegated to free Claude CLI agent with structured JSON prompt (#153)
- Test output truncated to 50k chars (head+tail preserved) for large failures (#153)

## Product decisions and rationale

**Session persistence over ephemerality**
Sessions wrap Claude CLI in tmux to survive server restarts rather than treating each invocation as ephemeral. This reflects the reality that development work spans multiple days and interruptions. Context preambles rebuild state from prior messages when tmux sessions are recovered (#12, #37, #83).

**AI-generated names instead of timestamps**
Session names are generated by Claude Haiku after the first message rather than using timestamps or manual naming. This improves discoverability in the session list without requiring user input. The prompt was tightened to prevent conversational responses (#18, #90).

**Diff metrics over tool counts**
Session cards show lines added/removed instead of tool/message counts because code impact is more meaningful than activity volume for evaluating session progress (#47, #49, #50).

**Server-side quality checks instead of CLI hooks**
Quality rules execute server-side by detecting patterns in stream events rather than relying on Claude CLI lifecycle hooks. This enables hybrid execution (free CLI subprocess or paid LLM Gateway API) and centralizes enforcement logic (#35, #44, #80, #81).

**Single shared WebSocket instead of per-session connections**
A single WebSocket connection with subscribe/unsubscribe pattern replaced per-session connections to reduce overhead and simplify state management. Session resumption replays history from database to initialize deduplication (#53, #59).

**Inline streaming over batch updates**
Assistant messages stream incrementally as they arrive instead of appearing all at once. This provides real-time feedback during long-running operations (#150).

**Immediate execution for non-destructive actions**
Retry/Resume actions execute immediately without confirmation dialogs to reduce friction. Confirmation is reserved for destructive overwrites like regenerating existing context documents (#168).

**Case-insensitive path matching for cross-platform compatibility**
Session-to-project linking uses case-insensitive path comparisons via LOWER() to handle macOS/Windows filesystem behavior. Deepest-match-wins for nested projects (#139, #141, #158).

**Delimited markdown over JSON for context docs**
Context document rollup emits delimited markdown (===BEGIN/END=== markers) instead of JSON to avoid escaping overhead and truncation issues with large documents (#166).

**3-iteration cap on fix cycles**
Pipeline Phase 2 limits fix cycles to 3 before escalation to prevent infinite loops while allowing reasonable retry attempts (#165).

## Scoping decisions

**Features removed**
- Max effort toggle removed completely from codebase — no documented rationale (#112)
- Preset projects system with database seeding replaced by pure filesystem-based project discovery (#14)
- Confirmation dialogs removed for non-destructive actions like session end, replaced with immediate execution (#29)

**Features not implemented**
- Multi-user collaboration is not in scope — sessions are single-user, no real-time co-editing
- Session sharing or read-only spectator mode not mentioned in any PR
- Custom quality rule authoring UI — rules are YAML files on disk, no in-app editor beyond AI-assisted evals authoring

**Intentional constraints**
- Quality rules default to OFF to prevent surprise automation; users must opt in (#9)
- File attachments capped at 20MB per file (#24)
- Quality review limited to 3 retry iterations per session to prevent infinite enforcement loops (#66)
- Planning sessions run without timeouts or rate limits since they use tmux CLI processes, not API calls (#151)
- Evals sub-agents restricted to read-only tools in plan mode with no MCP for security (#111)

## Open questions and known gaps

**Unclear interactions**
- Relationship between quality rule enforcement (#40) and hybrid CLI/API execution modes (#44) — whether enforcement works identically in both modes not explicitly confirmed
- Decision log format locked for future extraction pipeline but no validation that format is actually parseable (#145, #151)
- Whether backfill migration running on every server startup (idempotent) has ongoing performance implications (#158)

**Error handling gaps**
- Railway cleanup on failed service creation is best-effort and silently ignores errors; may leave inconsistent state if deletion fails (#140)
- Test output truncation (50k chars, head+tail preserved) may lose critical context in middle of large failures (#153)
- Worktree cleanup flow trusts GitHub CLI presence; gracefully returns safe defaults if missing but unclear if this is sufficient (#107)

**UX ambiguities**
- Session auto-naming logic duplicated in both createSession and resumeSession paths; full decision tree for when naming triggers is distributed across multiple changes (#26, #28, #45, #90)
- Selected session tile uses hardcoded darker tan color instead of CSS variable; rationale for hardcoding not documented (#122)
- Whether 3-iteration cap on pipeline fix cycles was empirically validated or chosen arbitrarily (#165)

**Feature status**
- VAPID/notification code preserved in Settings UI despite being flagged in review — unclear if this is temporary or intended (#53)
- PR #126 extraction failed completely — content unknown for that batch