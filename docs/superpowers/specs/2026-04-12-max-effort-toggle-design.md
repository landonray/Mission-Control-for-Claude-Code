# Max Effort Toggle — Design Spec

## Overview

Add a per-session "Max Effort" toggle to the session controls dropdown menu. When enabled, passes `--effort max` to the Claude CLI, telling Claude to use maximum thinking depth on every response in that session.

## Motivation

The Claude CLI supports an `--effort` flag with levels: low, medium, high, max. The default behavior (no flag) is high. For complex tasks, max effort produces deeper, more thorough responses. The user wants a quick way to flip this on per session without leaving the chat interface.

## Design

### Database

Add a `max_effort` column to the `sessions` table:
- Type: `INTEGER` (0 or 1, SQLite-style boolean)
- Default: `0` (off — Claude uses its default high effort)
- Migration: `ALTER TABLE sessions ADD COLUMN max_effort INTEGER DEFAULT 0`

### Backend API

**Endpoint:** `POST /api/sessions/:id/max-effort`

- Request body: `{ "maxEffort": true | false }`
- Updates `session.maxEffort` in memory and `max_effort` in the database
- Response: `{ "success": true, "maxEffort": true|false, "note": "Takes effect on next message." }`
- Follows the same pattern as `POST /:id/permission-mode`

### CLI Integration

In `SessionProcess.buildArgs()`, after the model selection block:

- If `this.maxEffort` is truthy, push `--effort`, `max` to the args array
- If falsy, do not pass `--effort` at all (Claude defaults to high)

### Session Lifecycle

- **Creation:** `max_effort` defaults to `0` (off). No change to the new session modal.
- **Resume:** `max_effort` is read from the database row and set on the SessionProcess, just like `model` and `permissionMode`.
- **Persistence:** Survives pause/resume and server restarts.

### Frontend

**Location:** SessionControls dropdown menu, between Permission Mode and MCP Servers sections.

**Component:** A menu row with:
- Label: "Max Effort"
- A toggle switch (on/off) — not a PillSelector, since there are only two states
- Visual indicator showing current state (on = highlighted/active color)

**Behavior:**
- Reads initial state from `session.max_effort`
- On toggle, calls `POST /api/sessions/:id/max-effort` with the new value
- Updates local state immediately (optimistic)
- Change takes effect on the next message sent to the session

### Testing

**Unit tests:**
- `buildArgs()` includes `--effort max` when `maxEffort` is true, omits it when false
- API endpoint validates input and updates database
- SessionProcess correctly initializes `maxEffort` from database on resume

**Integration tests:**
- Toggle renders in session controls menu
- Clicking toggle calls the API and updates visual state
- Toggle state persists after page reload

## Out of Scope

- Global default effort setting
- Per-message effort control
- Effort level selector (low/medium/high/max) — just on/off for max
- Changes to the new session creation modal
