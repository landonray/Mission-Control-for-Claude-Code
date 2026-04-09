# Mission Control
![Mission Control 2026-04-01 at 10 26 53 AM](https://github.com/user-attachments/assets/a606053b-b951-4263-84a6-a4d438969957)

**Claude Code in your browser. From your couch.**

The Claude CLI is incredible, but it lives in the terminal. VS Code and Cursor are a faceful. Claude Desktop is nice, but (1) it's stuck on the desktop so you can't take it with you and (2) no hooks.

Mission Control is as close to "Claude Desktop on the web" as you can get — a full web UI for Claude Code that runs on your home server and is accessible from any device. Create sessions, stream output in real-time, approve permissions from your phone, browse files, enforce quality rules, and get push notifications when Claude needs you. All without leaving the browser.

## What's Included

- **Session Management** — Create, monitor, resume, archive, and manage multiple Claude Code sessions simultaneously, organized by project
- **Real-time Streaming** — WebSocket-based live streaming of AI agent output, messages, tool use, and permission requests
- **File Browser** — Browse project file trees, preview code with syntax highlighting, render Markdown, view git status, and compare diffs across branches
- **Live Preview** — Built-in iframe preview panel for web projects (hit the preview tab to see your app running)
- **Quality Rules Engine** — 21+ lifecycle hooks (SessionStart, Stop, PostToolUse, PreToolUse, SubagentStop, PRCreated, and more) with prompt-based, agent-based, and CLI-based rules, scorecards, and analytics
- **File Attachments** — Drag-and-drop or pick files (images, PDFs, code, archives) to send alongside messages — up to 10 files, 20MB each
- **Interrupt & Send** — Stop Claude mid-task and immediately send a new instruction without killing the session
- **Message Queue Control** — View, reorder, and delete queued messages before they're processed
- **Slash Commands** — Create custom quick-prompt shortcuts (/quality-check, /run-tests, etc.) accessible from the chat input
- **Project Creation** — Create new GitHub repos with local git init + `gh repo create` + auto-scaffolding in one step
- **Session Persistence** — Tmux-backed sessions survive server restarts; automatic recovery on startup
- **Push Notifications** — Web Push API alerts for permission requests, task completion, errors, and context window warnings
- **MCP Integration** — Configure Model Context Protocol servers to auto-attach to new sessions
- **Session History & Search** — Search previous sessions and messages, view full conversation logs, and generate daily digests
- **Session Summaries** — Auto-generated summaries showing branch, key actions, files changed, and message count
- **Mobile Support** — Responsive design with tab-based navigation on mobile, 3-panel layout on desktop, installable as a PWA

## Prerequisites

You'll need all of these installed on the machine that will run Mission Control:

### Node.js 18+

```bash
# macOS
brew install node
```

### Claude Code CLI

This is what Mission Control wraps — the actual Claude Code agent.

```bash
npm install -g @anthropic-ai/claude-code
```

Run it once to authenticate:

```bash
claude
```

### PostgreSQL (via Neon)

Mission Control uses [Neon](https://neon.tech) serverless PostgreSQL as its database. You'll need:

1. A Neon account (free tier works fine)
2. A project named `command-center` in your Neon dashboard
3. The connection string (`DATABASE_URL`) for that project

The database schema is auto-created on first startup — no manual migrations needed. Tables include sessions, messages, quality rules, MCP configs, notification settings, and more.

**Automatic setup (optional):** If you store a `NEON_API_KEY` in `~/setup-tools/.env`, the setup script will fetch your connection string automatically. Otherwise, just create a `.env` file manually (see below).

### tmux (recommended)

Sessions run inside tmux so they survive server restarts. Without it, sessions fall back to direct child processes (which die if the server restarts).

```bash
# macOS
brew install tmux
```

### Anthropic API Key

Mission Control uses the Anthropic API directly for two things: auto-naming sessions (via Haiku) and running server-side quality checks. Both are extremely cheap — session naming costs fractions of a penny per session. The SDK reads your key from the `ANTHROPIC_API_KEY` environment variable.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

Add it to your `.env` file (see below) or your shell profile.

**Why server-side hooks?** Claude Code's CLI hooks only fire inside the CLI process. Since Mission Control runs sessions via `--print` mode over WebSocket, those lifecycle hooks (PostToolUse, Stop, etc.) never fire. Mission Control reimplements them server-side — it watches the stream for tool use events and runs quality rule prompts against the Anthropic API directly. This is what powers the Quality Rules Engine.

### GitHub CLI (optional)

Only needed for the "Create New Project" feature.

```bash
brew install gh
gh auth login
```

## Setup

### 1. Clone the repo

```bash
git clone <your-repo-url> command-center
cd command-center
```

### 2. Install dependencies

```bash
npm install
cd client && npm install && cd ..
```

### 3. Configure environment

Create a `.env` file in the project root:

```bash
DATABASE_URL=postgresql://user:pass@host/dbname?sslmode=require
ANTHROPIC_API_KEY=sk-ant-...
NODE_ENV=development
```

Get your `DATABASE_URL` from the Neon dashboard (project → Connection Details → Connection string).

Or, if you have a Neon API key stored at `~/setup-tools/.env`:

```bash
# setup.sh will auto-fetch the connection string
# Just run npm dev and it handles it
```

### 4. Build the frontend

```bash
npm run build
```

### 5. Start the server

```bash
# Production
npm start

# Development (server + Vite HMR)
npm run dev
```

The server starts on `http://0.0.0.0:3000`. In dev mode, the Vite frontend runs on `http://localhost:5173` and proxies API/WebSocket requests to the backend.

## Remote Access with Tailscale

This is how you use Mission Control from your phone, tablet, or any other device on your network.

1. Install [Tailscale](https://tailscale.com) on your server and on your phone/tablet
2. Start Tailscale on both devices
3. Find your server's Tailscale IP: `tailscale ip -4`
4. Open your browser and go to `http://<tailscale-ip>:5173` (dev) or `http://<tailscale-ip>:3000` (production)

Since Tailscale creates an encrypted private network, there's no need for an auth layer or HTTPS — only your devices can reach it. Install it as a PWA on your phone for the full "Claude Desktop on your phone" experience.

## Architecture

| Layer | Tech |
|-------|------|
| **Frontend** | React 18, React Router 6, Vite |
| **Backend** | Node.js, Express |
| **Database** | PostgreSQL via [Neon](https://neon.tech) serverless |
| **Real-time** | WebSocket (`ws`) for session streaming and notifications |
| **Process Management** | Claude Code CLI spawned as child processes, tmux for persistence |
| **Notifications** | Web Push API with auto-generated VAPID keys |
| **File Uploads** | multer middleware (20MB limit, 10 files max) |
| **Network** | Tailscale (private, no public internet exposure) |

## API

All routes are under `/api/`. WebSocket endpoint: `/ws`.

| Route | Description |
|-------|-------------|
| `GET /api/health` | Health check |
| `/api/sessions` | Session CRUD, status, messaging, resume, archive |
| `/api/files` | File tree, content, git status/diffs, branch comparison |
| `/api/projects` | Project listing and creation |
| `/api/mcp` | MCP server configuration |
| `/api/quality` | Quality rules, results, hooks, analytics |
| `/api/history` | Session history, search, digests, summaries |
| `/api/notifications` | Push subscriptions and settings |
| `/api/settings` | App settings |
| `/api/slash-commands` | Custom slash command management |
| `/api/upload` | File attachment uploads |
