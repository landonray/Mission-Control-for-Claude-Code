# Mission Control

Web-based dashboard for monitoring and interacting with Claude Code sessions running on a Mac Studio. Provides reliable remote access from any device via Tailscale with real-time streaming, file browsing, quality assurance, and persistent session management.

## Quick Start

```bash
# Install dependencies
npm install
cd client && npm install && cd ..

# Build the frontend
npm run build

# Start the server
npm start
```

The server starts on `http://0.0.0.0:3000` (configurable via `PORT` env var).

## Development

```bash
# Run server and client dev server concurrently
npm run dev
```

- Backend: `http://localhost:3000`
- Frontend dev server: `http://localhost:5173` (proxies API and WebSocket to backend)

## Features

- **Session Management** — Create, monitor, resume, and manage multiple Claude Code sessions simultaneously
- **Real-time Streaming** — WebSocket-based live streaming of AI agent output, messages, and permission requests
- **File Browser** — Browse project file trees, preview code with syntax highlighting, render Markdown, and view git diffs
- **Quality Rules Engine** — Configure and enforce quality rules that hook into Claude Code lifecycle events with pass/fail scorecards and analytics
- **Project Creation** — Create new GitHub projects with local git init + `gh repo create` in one step
- **Session Persistence** — Tmux-backed sessions survive server restarts; automatic recovery on startup
- **Push Notifications** — Web Push API alerts for permission requests, task completion, errors, and context window warnings
- **MCP Integration** — Configure Model Context Protocol servers to auto-attach to new sessions
- **Session History** — Search previous sessions, view message logs, and daily digests
- **Mobile Support** — Responsive design with tab-based navigation on mobile, 3-panel layout on desktop
- **PWA** — Installable as a Progressive Web App with service worker and offline support

## Architecture

- **Backend:** Node.js / Express on port 3000
- **Frontend:** React 18 + React Router 6 (Vite)
- **Database:** SQLite via better-sqlite3 (local, stored as `mission-control.db`)
- **Real-time:** WebSocket (ws) for session streaming, file change notifications, and heartbeat
- **Process Management:** Claude Code CLI spawned as child processes; tmux for persistence
- **Notifications:** Web Push API with VAPID keys (auto-generated)
- **Network:** Tailscale-only (no public internet, no auth layer needed)

## Configuration

Copy `.env.example` to `.env` and adjust as needed:

```bash
cp .env.example .env
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT`   | `3000`  | Server port |

### App Settings (via UI)

Settings are stored in SQLite and managed through the Settings page:

- **Projects Directory** — Root path where projects are stored
- **GitHub Username** — Used for project creation with `gh`

### MCP Servers

MCP server configurations are managed in Settings > MCP Servers. Servers flagged for auto-connect will be attached to every new session via `--mcp-config`.

### Quality Rules

The Quality Rules Engine is configured in Settings > Quality Rules. It supports 21+ lifecycle hooks (SessionStart, Stop, PostToolUse, etc.) with three rule types:

- **Prompt** — LLM evaluates against custom instructions
- **Agent** — Claude Code runs additional validation
- **Command** — Shell script execution

Toggle rules on/off, customize prompts, and install hooks to `~/.claude/settings.json` with one click.

## API Routes

All routes are under `/api/`:

| Route | Description |
|-------|-------------|
| `GET /api/health` | Health check |
| `/api/sessions` | Session CRUD, status, messaging |
| `/api/files` | File tree, content, git status/diffs/branches |
| `/api/projects` | Project listing and creation |
| `/api/mcp` | MCP server configuration CRUD |
| `/api/quality` | Quality rules, results, hooks management |
| `/api/history` | Session history, search, daily digests |
| `/api/notifications` | Push subscriptions, settings, test |
| `/api/settings` | App settings (projects dir, GitHub username) |

WebSocket endpoint: `/ws`

## Project Structure

```
├── server/
│   ├── index.js                      # Express server entry point
│   ├── database.js                   # SQLite schema, migrations, seed data
│   ├── websocket.js                  # WebSocket server (streaming, subscriptions, heartbeat)
│   ├── routes/
│   │   ├── sessions.js               # Session CRUD + messaging
│   │   ├── files.js                  # File tree, content, git ops
│   │   ├── projects.js               # Project listing + creation (gh CLI)
│   │   ├── notifications.js          # Push notification management
│   │   ├── mcp.js                    # MCP server configs
│   │   ├── history.js                # Session history + digests
│   │   ├── quality.js                # Quality rules + results
│   │   └── settings.js               # App settings
│   └── services/
│       ├── sessionManager.js         # Claude Code CLI process manager (direct + tmux)
│       ├── fileWatcher.js            # Filesystem watcher + git integration
│       ├── notificationService.js    # Web Push API
│       └── hooksGenerator.js         # Quality hooks config generator
├── client/
│   ├── src/
│   │   ├── App.jsx                   # Route definitions, responsive layout switching
│   │   ├── main.jsx                  # Entry point, service worker registration
│   │   ├── components/
│   │   │   ├── Dashboard/            # Session cards, project cards, new session modal, project creation
│   │   │   ├── Chat/                 # Chat interface, message list, permission prompts, context indicator
│   │   │   ├── FileBrowser/          # File tree, code/markdown preview, diffs, mobile file browser
│   │   │   ├── Quality/              # Rules config, scorecard, analytics history
│   │   │   ├── Layout/              # Desktop 3-panel layout + mobile tab layout
│   │   │   ├── PreviewPanel/         # Right-side preview panel (files/quality)
│   │   │   ├── Settings/             # General settings page
│   │   │   ├── Notifications/        # Push notification settings
│   │   │   ├── History/              # Session history + digests
│   │   │   ├── MCP/                  # MCP server management
│   │   │   ├── common/               # Reusable UI components (PillSelector)
│   │   │   ├── shared/               # Shared components (FolderPicker)
│   │   │   └── ErrorBoundary.jsx     # React error boundary
│   │   ├── context/
│   │   │   └── AppContext.jsx        # Global state (useReducer)
│   │   ├── hooks/
│   │   │   ├── useWebSocket.js       # WebSocket connection + session streaming
│   │   │   └── useMediaQuery.js      # Responsive breakpoint hook
│   │   └── utils/
│   │       ├── api.js                # HTTP client wrapper
│   │       └── format.js             # Text formatters
│   └── public/                       # PWA manifest, service worker, icons
├── docs/                             # Design specs and documentation
└── package.json
```

## Database

SQLite database (`mission-control.db`) is created automatically on first run. Tables:

- `sessions` — Session metadata (status, working dir, model, tmux session name, context usage)
- `messages` — Conversation history (role, content, tool calls/results)
- `session_summaries` — AI-generated summaries and key actions
- `mcp_servers` — MCP server configurations
- `notification_subscriptions` — Web Push endpoints and keys
- `notification_settings` — Notification preferences per event type
- `app_settings` — General settings
- `daily_digests` — Daily session summary digests
- `quality_rules` — Quality rule definitions and configurations
- `quality_results` — Quality rule execution results

## Requirements

- **Node.js 18+**

- **Claude Code CLI** — required to run Claude Code sessions

  ```bash
  npm install -g @anthropic-ai/claude-code
  ```

  Authenticate on first run:
  ```bash
  claude
  ```

- **tmux** — recommended for session persistence across server restarts (sessions fall back to direct child processes without it)

- **GitHub CLI (`gh`)** — required for the "Create New Project" feature (not needed for other features)

  ```bash
  # macOS
  brew install gh
  ```

  Authenticate:
  ```bash
  gh auth login
  ```

- **Tailscale** — for remote access from other devices (optional for local use)
