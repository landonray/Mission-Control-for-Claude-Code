# Cancel Quality Checks & Delete Queued Messages

**Date:** 2026-04-08
**Status:** Draft

## Summary

Two new user controls for the Command Center chat interface:

1. **Cancel individual quality checks** while they're running
2. **Delete queued messages** before they're sent to the agent

Both features add controls to existing UI elements — no new pages or panels.

---

## Feature 1: Cancel Individual Quality Checks

### Problem

Quality checks each run in their own subprocess (CLI) or API call, independent from the main session. They show a spinner in the UI while running, but there's no way to cancel one. If a check is slow, irrelevant, or stuck, the user has to wait or end the entire session.

### Design

#### Server: Track process handles

The `runningChecks` map in `qualityRunner.js` currently stores metadata only (rule name, severity, timestamp). It will also store a reference that allows cancellation:

- **CLI mode checks:** Store an `AbortController` that gets passed to the `cliAgent.run()` function. Calling `abort()` kills the subprocess.
- **API mode checks:** Store an `AbortController` passed to the `chatCompletion()` call. Calling `abort()` cancels the HTTP request.

The `cliAgent.js` module's `run()` function will accept an optional `signal` (AbortSignal) parameter. If the signal fires, it kills the child process.

#### Server: Cancel endpoint

```
POST /api/quality/cancel/:sessionId/:ruleId
```

- Looks up the running check in the `runningChecks` map
- Calls `abort()` on the stored AbortController
- Records the result as "cancelled" (not pass, not fail)
- Broadcasts `quality_result` with `result: 'cancelled'` to the UI
- Returns 200 on success, 404 if check not found or already finished

#### Server: Cancellation and send_fail_to_agent

When collecting quality failures to send back to the agent, cancelled checks are skipped. A cancelled check does not count as a failure and does not trigger a review loop iteration.

#### Client: Cancel button on running checks

The `QualityResultItem` component in `MessageList.jsx` adds an X button when `msg.result === 'running'`. Clicking it:

1. Calls `POST /api/quality/cancel/:sessionId/:ruleId`
2. Optimistically updates the UI to show "cancelled" state

#### Client: Cancelled state styling

Cancelled checks show with a muted/grey style, distinct from pass (green) and fail (red). The icon changes to a slash or stop icon. No expandable details since there's no analysis to show.

### Edge Cases

- **Check finishes before cancel arrives:** The cancel endpoint returns 404 (already done). The UI already shows the real result, so no action needed.
- **Session ends while checks running:** Existing cleanup logic handles this. Cancellation also cleans up — killed processes don't leave orphan entries in the running map.
- **Multiple checks running simultaneously:** Each has its own AbortController, so cancelling one doesn't affect the others.

---

## Feature 2: Delete Queued Messages

### Problem

When a message is sent while the agent is busy, it goes into an in-memory queue (`this.messageQueue` in `sessionManager.js`) and auto-sends when the agent finishes. The user has no visibility into the queue and no way to remove a message they no longer want sent.

### Design

#### Server: Queue visibility and management

Each queued message gets a unique ID (generated at queue time) so it can be targeted for deletion.

**New endpoints:**

```
GET /api/sessions/:id/queue
```
Returns the current message queue for a session (array of `{ id, content, queuedAt }`).

```
DELETE /api/sessions/:id/queue/:messageId
```
Removes a specific message from the queue by its ID. Returns 200 on success, 404 if not found (already sent or already deleted).

#### Server: WebSocket events

- **`message_queued`** — Broadcast when a message is added to the queue. Payload: `{ sessionId, messageId, content, queuedAt }`.
- **`message_dequeued`** — Broadcast when a message is removed from the queue (deleted by user). Payload: `{ sessionId, messageId }`.

These keep the frontend in sync without polling.

#### Server: Queue data structure change

The `messageQueue` array currently stores plain strings (the message text). It will store objects instead:

```
{ id: string, content: string, queuedAt: string }
```

All existing code that reads from the queue (`shift()`, `length`, etc.) is updated to work with these objects.

#### Client: Queued messages in the chat

Queued messages appear inline in the `MessageList` component, rendered as user messages with:

- **Muted/dimmed styling** — visually distinct from sent messages
- **"Queued" badge** — small label indicating the message hasn't been sent yet
- **X (delete) button** — removes the message from the queue

The messages array passed to `MessageList` will include queued messages with a `role: 'queued'` marker so the component can apply the right styling and controls.

#### Client: WebSocket integration

The `useWebSocket` hook handles `message_queued` and `message_dequeued` events:

- `message_queued`: Adds the message to local state so it appears in the chat
- `message_dequeued`: Removes it from local state (whether triggered by this client or another)

#### Client: Delete interaction

Clicking the X button on a queued message:

1. Calls `DELETE /api/sessions/:id/queue/:messageId`
2. Optimistically removes the message from the chat UI
3. If the server returns 404 (message already sent), shows a brief toast/notice: "Message already sent"

### Edge Cases

- **Message sends right as user clicks delete:** The delete endpoint checks the queue. If the message was already shifted off (being processed), returns 404. The UI shows a brief "too late" notice.
- **Multiple queued messages:** Each has a unique ID. Deleting one doesn't affect the others. The UI shows them in queue order.
- **Session switches:** Queued messages are per-session. Switching sessions shows that session's queue (or lack thereof). The initial queue state is fetched via the GET endpoint when subscribing to a session.

---

## Files to Modify

### Server
- `server/services/cliAgent.js` — Accept AbortSignal, kill subprocess on abort
- `server/services/qualityRunner.js` — Store AbortControllers in runningChecks, add cancel function, skip cancelled in failure collection
- `server/services/sessionManager.js` — Change messageQueue to store objects with IDs, add queue getter/deleter methods, broadcast queue events
- `server/routes/quality.js` — Add `POST /cancel/:sessionId/:ruleId` endpoint
- `server/routes/sessions.js` — Add `GET /:id/queue` and `DELETE /:id/queue/:messageId` endpoints
- `server/websocket.js` — Handle new event types (message_queued, message_dequeued)

### Client
- `client/src/components/Chat/MessageList.jsx` — Add cancel button to running quality checks, add queued message rendering with delete button
- `client/src/components/Chat/MessageList.module.css` — Styles for cancelled state and queued messages
- `client/src/components/Chat/ChatInterface.jsx` — Pass queued messages into MessageList, handle queue state
- `client/src/hooks/useWebSocket.js` — Handle message_queued and message_dequeued events

### Shared
- `server/services/llmGateway.js` — Accept AbortSignal for API mode cancellation (if not already supported)

---

## Out of Scope

- Editing queued messages (delete and re-send instead)
- Bulk cancel all quality checks (can be added later if needed, but per-check cancel covers the use case)
- Persisting queue to database (queue is ephemeral and short-lived; in-memory is fine)
- Reordering queued messages
