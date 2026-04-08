# Cancel Quality Checks & Delete Queued Messages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users cancel individual running quality checks and delete queued messages that haven't been sent yet.

**Architecture:** Two independent features that each follow the same pattern: add server-side cancel/delete logic, expose it via API endpoints, broadcast state changes over WebSocket, and add UI controls (X buttons) to existing components.

**Tech Stack:** Node.js/Express backend, React frontend, WebSocket for real-time updates.

---

## File Structure

### Server changes
- **Modify:** `server/services/cliAgent.js` — Accept AbortSignal to allow killing subprocesses
- **Modify:** `server/services/llmGateway.js` — Accept AbortSignal for API-mode cancellation
- **Modify:** `server/services/qualityRunner.js` — Store AbortControllers in runningChecks, add `cancelCheck()` export, skip cancelled checks in failure collection
- **Modify:** `server/routes/quality.js` — Add `POST /cancel/:sessionId/:ruleId` endpoint
- **Modify:** `server/services/sessionManager.js` — Change messageQueue to objects with IDs, add `getQueue()`/`deleteFromQueue()` methods, broadcast queue events
- **Modify:** `server/routes/sessions.js` — Add `GET /:id/queue` and `DELETE /:id/queue/:messageId` endpoints

### Client changes
- **Modify:** `client/src/components/Chat/MessageList.jsx` — Add cancel button on running quality checks, add queued message rendering with delete button
- **Modify:** `client/src/components/Chat/MessageList.module.css` — Styles for cancelled state, cancel button, and queued messages
- **Modify:** `client/src/hooks/useWebSocket.js` — Handle `message_queued` and `message_dequeued` events, expose `cancelQualityCheck` and `deleteQueuedMessage` functions
- **Modify:** `client/src/components/Chat/ChatInterface.jsx` — Pass new functions to MessageList, load initial queue state

---

## Task 1: Make cliAgent.js support cancellation via AbortSignal

**Files:**
- Modify: `server/services/cliAgent.js`

- [ ] **Step 1: Update `run()` to accept and wire up an AbortSignal**

The `run()` function currently returns a plain Promise wrapping `execFile`. We need it to accept an optional `signal` parameter so callers can abort the subprocess.

```js
// server/services/cliAgent.js — full file replacement
/**
 * CLI Agent — runs prompts via `claude` subprocess.
 *
 * Uses the Claude CLI on the user's Max plan instead of the paid
 * LLM Gateway API. Each call spawns a short-lived subprocess that
 * takes a prompt on stdin and returns the response on stdout.
 *
 * Supports two modes:
 *   - print mode (default): `claude --print` — single-shot, no tools
 *   - agent mode: full Claude session with tool access (Read, Glob, Grep, etc.)
 */

const { execFile } = require('child_process');

/**
 * Run a prompt via the Claude CLI and return the text response.
 *
 * @param {string} prompt - The full prompt to send
 * @param {object} [options] - Optional settings
 * @param {string[]} [options.allowedTools] - Tools to grant (e.g. ['Read', 'Glob', 'Grep'])
 * @param {string} [options.cwd] - Working directory for the subprocess
 * @param {number} [options.timeout] - Timeout in ms (default 120000)
 * @param {AbortSignal} [options.signal] - AbortSignal to cancel the subprocess
 * @returns {Promise<string>} The CLI's text output
 */
function run(prompt, options = {}) {
  const { allowedTools, cwd, timeout = 120000, signal } = options;

  const args = ['--print', '-p', prompt];

  if (allowedTools && allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
  }

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const child = execFile('claude', args, {
      maxBuffer: 1024 * 1024, // 1MB
      timeout,
      cwd: cwd || undefined,
    }, (error, stdout, stderr) => {
      if (signal?.aborted) {
        reject(new Error('Aborted'));
        return;
      }
      if (error) {
        reject(new Error(`CLI agent failed: ${error.message}`));
        return;
      }
      resolve(stdout || '');
    });

    if (signal) {
      const onAbort = () => {
        child.kill('SIGTERM');
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort);
      // Clean up listener if process exits normally
      child.on('exit', () => signal.removeEventListener('abort', onAbort));
    }
  });
}

module.exports = { run };
```

- [ ] **Step 2: Verify the server starts without errors**

Run: `cd "/Users/landonray/Coding Projects/Command Center/.claude/worktrees/synchronous-bouncing-globe" && node -e "require('./server/services/cliAgent')"`
Expected: No output (clean require)

- [ ] **Step 3: Commit**

```bash
git add server/services/cliAgent.js
git commit -m "feat: add AbortSignal support to cliAgent for quality check cancellation"
```

---

## Task 2: Make llmGateway.js support cancellation via AbortSignal

**Files:**
- Modify: `server/services/llmGateway.js`

- [ ] **Step 1: Update `chatCompletion()` to accept and forward an AbortSignal**

```js
// server/services/llmGateway.js — full file replacement
/**
 * LLM Gateway client.
 *
 * Routes all AI API calls through the LLM Gateway instead of
 * hitting provider APIs directly. Uses the OpenAI-compatible
 * chat completions endpoint.
 */

const BASE_URL = 'https://llm-gateway.replit.app';
const API_KEY = process.env.LLM_GATEWAY_KEY;

/**
 * Send a chat completion request via the LLM Gateway.
 *
 * @param {object} opts
 * @param {string} opts.model - Model ID (e.g. 'claude-haiku-4-5')
 * @param {number} opts.max_tokens - Max tokens in response
 * @param {string} [opts.system] - System prompt
 * @param {Array} opts.messages - Array of {role, content} messages
 * @param {AbortSignal} [opts.signal] - AbortSignal to cancel the request
 * @returns {Promise<string>} The assistant's text response
 */
async function chatCompletion({ model, max_tokens, system, messages, signal }) {
  if (!API_KEY) {
    throw new Error('LLM_GATEWAY_KEY environment variable is not set');
  }

  // Prepend system message if provided (OpenAI-compatible format)
  const allMessages = system
    ? [{ role: 'system', content: system }, ...messages]
    : messages;

  const response = await fetch(`${BASE_URL}/api/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: allMessages,
      max_tokens,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM Gateway error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return data.content || '';
}

module.exports = { chatCompletion };
```

- [ ] **Step 2: Verify the server starts without errors**

Run: `cd "/Users/landonray/Coding Projects/Command Center/.claude/worktrees/synchronous-bouncing-globe" && node -e "require('./server/services/llmGateway')"`
Expected: No output (clean require)

- [ ] **Step 3: Commit**

```bash
git add server/services/llmGateway.js
git commit -m "feat: add AbortSignal support to llmGateway for quality check cancellation"
```

---

## Task 3: Add cancellation logic to qualityRunner.js

**Files:**
- Modify: `server/services/qualityRunner.js`

- [ ] **Step 1: Update the runningChecks map to store AbortControllers and add cancelCheck()**

The `runningChecks` map currently stores metadata objects like `{ ruleId, ruleName, severity, trigger, timestamp }`. We need to add an `abortController` property to each entry, and create an exported `cancelCheck()` function.

In `qualityRunner.js`, make these changes:

**Change 1:** In `broadcastRunning()`, accept and store the AbortController:

Replace the `broadcastRunning` function (lines 310-326):
```js
/**
 * Broadcast that a quality check is starting (so UI can show a spinner).
 */
function broadcastRunning(sessionId, rule, broadcast, abortController) {
  const entry = {
    ruleId: rule.id,
    ruleName: rule.name,
    severity: rule.severity,
    trigger: rule.fires_on,
    timestamp: new Date().toISOString(),
    abortController: abortController || null
  };

  // Track in memory so clients can recover running state on reload
  if (!runningChecks.has(sessionId)) runningChecks.set(sessionId, new Map());
  runningChecks.get(sessionId).set(rule.id, entry);

  if (broadcast) {
    broadcast({ type: 'quality_running', sessionId, ...entry, abortController: undefined });
  }
}
```

**Change 2:** In `runQualityCheck()`, create an AbortController, pass its signal to cliRun/chatCompletion, and return it alongside the result. Replace the function (lines 194-243):

```js
/**
 * Run a quality check prompt via the Anthropic SDK or CLI agent.
 * Agent-type rules get tool access (Read, Glob, Grep) so they can inspect actual files.
 *
 * @param {object} rule - The quality rule
 * @param {string} context - Conversation + git context
 * @param {object} [options] - Additional options
 * @param {string} [options.cwd] - Working directory for agent-type checks
 * @param {AbortSignal} [options.signal] - AbortSignal to cancel the check
 * Returns { result: 'pass'|'fail', details: string|null, analysis: string|null }
 */
async function runQualityCheck(rule, context, options = {}) {
  try {
    if (options.signal?.aborted) return null;

    const isAgent = rule.hook_type === 'agent';
    const tools = isAgent ? getAllowedTools(rule) : [];

    const agentInstructions = isAgent && tools.length > 0
      ? `\n\nYou have access to these tools: ${tools.join(', ')}. Use them to read and inspect the actual code files — do not rely solely on the conversation context. Check the real files to verify changes were made correctly.`
      : '';

    const prompt = `${rule.prompt}${agentInstructions}

Context about what just happened:
${context}

IMPORTANT: After your evaluation, report the result by including one of these markers at the very end of your response:
QUALITY_RESULT:${rule.id}:${rule.severity}:PASS
or
QUALITY_RESULT:${rule.id}:${rule.severity}:FAIL:[brief reason]`;

    let fullText;

    const systemPrompt = 'You are a code quality reviewer. Be concise. Evaluate the code change and report PASS or FAIL with the exact QUALITY_RESULT marker format requested. Use the git state provided in the context to verify what actually happened — do not claim commits do not exist unless you have checked the git log. Focus your review on the actual code changes shown in the context.';

    if (rule.execution_mode === 'cli') {
      fullText = await cliRun(`${systemPrompt}\n\n${prompt}`, {
        allowedTools: tools.length > 0 ? tools : undefined,
        cwd: options.cwd || undefined,
        timeout: isAgent ? 180000 : 120000,
        signal: options.signal,
      }) || '';
    } else {
      fullText = await chatCompletion({
        model: 'claude-sonnet-4-20250514',
        max_tokens: isAgent ? 1000 : 500,
        system: systemPrompt,
        messages: [{ role: 'user', content: prompt }],
        signal: options.signal,
      }) || '';
    }

    const analysis = fullText.replace(/QUALITY_RESULT:\S+:\w+:(?:PASS|FAIL)(?::.*)?/g, '').trim();
    const match = fullText.match(/QUALITY_RESULT:(\S+):(\w+):(PASS|FAIL)(?::(.*))?/);
    if (match) {
      const [, , , result, details] = match;
      return { result: result.toLowerCase(), details: details || null, analysis };
    }
    return { result: 'pass', details: 'Quality check completed (no explicit marker)', analysis };
  } catch (e) {
    if (e.message === 'Aborted' || e.name === 'AbortError') return null;
    console.error(`[QualityRunner] Error running check ${rule.id}:`, e.message);
    return null;
  }
}
```

**Change 3:** Similarly update `runSpecComplianceCheck()` to accept `options.signal` and pass it through. Replace lines 250-305:

```js
/**
 * Run spec-compliance check with the actual spec document content.
 * Uses a more thorough prompt that includes the spec text.
 * Returns { result: 'pass'|'fail', details: string|null, analysis: string|null }
 */
async function runSpecComplianceCheck(rule, specContent, specPath, conversationContext, options = {}) {
  try {
    if (options.signal?.aborted) return null;

    const prompt = `You are a strict spec compliance reviewer. A spec document is attached below.

## Spec Document (from ${specPath})
${specContent}

## Recent Conversation Context
${conversationContext}

## Your Task
Enumerate EVERY requirement from the spec document above. For each one, determine whether it is:
- Fully implemented
- Partially implemented (explain what's missing)
- Missing entirely

Create a detailed checklist:
- [x] Requirement description (fully done)
- [ ] Requirement description (what's missing or incomplete)

If ALL requirements are fully met, respond with:
QUALITY_RESULT:${rule.id}:${rule.severity}:PASS

If ANY requirements are missing or incomplete, respond with a detailed list of what's unfinished, then:
QUALITY_RESULT:${rule.id}:${rule.severity}:FAIL:[count] requirements incomplete`;

    let fullText;

    const specSystemPrompt = 'You are a strict spec compliance reviewer. Be thorough — enumerate every requirement from the spec and check each one. Use the git state provided in the context to verify what was actually committed. Do not claim commits do not exist unless you have checked the git log. If you cannot confirm a requirement was implemented from the conversation context or git history, mark it incomplete.';

    if (rule.execution_mode === 'cli') {
      const tools = getAllowedTools(rule);
      fullText = await cliRun(`${specSystemPrompt}\n\n${prompt}`, {
        allowedTools: tools.length > 0 ? tools : undefined,
        cwd: options.cwd || undefined,
        signal: options.signal,
      }) || '';
    } else {
      fullText = await chatCompletion({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        system: specSystemPrompt,
        messages: [{ role: 'user', content: prompt }],
        signal: options.signal,
      }) || '';
    }
    const analysis = fullText.replace(/QUALITY_RESULT:\S+:\w+:(?:PASS|FAIL)(?::.*)?/g, '').trim();
    const match = fullText.match(/QUALITY_RESULT:(\S+):(\w+):(PASS|FAIL)(?::(.*))?/);
    if (match) {
      const [, , , result, details] = match;
      return { result: result.toLowerCase(), details: details || null, analysis };
    }
    return { result: 'pass', details: 'Spec check completed (no explicit marker)', analysis };
  } catch (e) {
    if (e.message === 'Aborted' || e.name === 'AbortError') return null;
    console.error(`[QualityRunner] Error running spec compliance check:`, e.message);
    return null;
  }
}
```

**Change 4:** In `onToolUse()`, create an AbortController per check and pass it through. Replace the `Promise.all(matchingRules.map(...))` block (lines 407-441):

```js
  await Promise.all(matchingRules.map(async (rule) => {
    if (rule.hook_type === 'command') return;

    // Skip if this rule is already running for this session (prevents duplicate triggers)
    const sessionRunning = runningChecks.get(sessionId);
    if (sessionRunning && sessionRunning.has(rule.id)) {
      console.log(`[QualityRunner] Rule "${rule.name}" already running for session ${sessionId.slice(0, 8)} — skipping duplicate`);
      return;
    }

    const abortController = new AbortController();
    broadcastRunning(sessionId, rule, broadcast, abortController);

    const result = await runQualityCheck(rule, context, { cwd: toolCwd, signal: abortController.signal });
    if (result) {
      await saveAndBroadcast(sessionId, rule, result, broadcast);

      // Collect failures for rules with send_fail_to_agent enabled
      if (result.result === 'fail' && rule.send_fail_to_agent) {
        console.log(`[QualityRunner] Rule "${rule.name}" failed with send_fail_to_agent (onToolUse) — will message agent`);
        failuresToSend.push({
          ruleId: rule.id,
          ruleName: rule.name,
          analysis: result.analysis,
          details: result.details,
        });
      }
    } else {
      // Error or cancelled — clean up running tracker so it doesn't stick forever
      const sr = runningChecks.get(sessionId);
      if (sr) {
        sr.delete(rule.id);
        if (sr.size === 0) runningChecks.delete(sessionId);
      }
    }
  }));
```

**Change 5:** In `onSessionStop()`, do the same — create AbortController per check. Replace the `Promise.all(stopRules.map(...))` block (lines 496-545):

```js
  await Promise.all(stopRules.map(async (rule) => {
    if (rule.hook_type === 'command') return;

    // If rule requires a spec document to run, skip it when no spec is found AND no spec was attached to this session
    if (rule.send_fail_requires_spec && !spec.found && !hasSpecFlag) {
      console.log(`[QualityRunner] Rule "${rule.name}" requires spec document but none found — skipping`);
      return;
    }

    const abortController = new AbortController();
    broadcastRunning(sessionId, rule, broadcast, abortController);

    let result;

    // For spec-compliance with a real spec file, use the enhanced check
    if (rule.id === 'spec-compliance' && spec.found) {
      console.log(`[QualityRunner] Spec file found at ${spec.path} — running enforcement-mode check`);
      result = await runSpecComplianceCheck(rule, spec.content, spec.path, context, { cwd, signal: abortController.signal });
    } else {
      result = await runQualityCheck(rule, context, { cwd, signal: abortController.signal });
    }

    if (!result) {
      // Error or cancelled — clean up running tracker
      const sr = runningChecks.get(sessionId);
      if (sr) {
        sr.delete(rule.id);
        if (sr.size === 0) runningChecks.delete(sessionId);
      }
      return;
    }

    await saveAndBroadcast(sessionId, rule, result, broadcast);

    // Collect failures for rules with send_fail_to_agent enabled
    if (result.result === 'fail' && rule.send_fail_to_agent) {
      // If requires_spec is set, only send when a spec file is present or was attached to this session
      if (rule.send_fail_requires_spec && !spec.found && !hasSpecFlag) {
        console.log(`[QualityRunner] Rule "${rule.name}" failed but no spec found — skipping send to agent`);
      } else {
        console.log(`[QualityRunner] Rule "${rule.name}" failed with send_fail_to_agent — will message agent`);
        failuresToSend.push({
          ruleId: rule.id,
          ruleName: rule.name,
          analysis: result.analysis,
          details: result.details,
          specPath: spec.found ? spec.path : null,
        });
      }
    }
  }));
```

**Change 6:** Add the `cancelCheck()` function before the module.exports:

```js
/**
 * Cancel a running quality check for a session.
 * Returns true if the check was found and cancelled, false otherwise.
 */
function cancelCheck(sessionId, ruleId, broadcast) {
  const sessionRunning = runningChecks.get(sessionId);
  if (!sessionRunning) return false;

  const entry = sessionRunning.get(ruleId);
  if (!entry || !entry.abortController) return false;

  // Abort the subprocess/API call
  entry.abortController.abort();

  // Clean up running tracker
  sessionRunning.delete(ruleId);
  if (sessionRunning.size === 0) runningChecks.delete(sessionId);

  // Broadcast cancelled result to UI
  if (broadcast) {
    broadcast({
      type: 'quality_result',
      sessionId,
      ruleId,
      ruleName: entry.ruleName,
      result: 'cancelled',
      severity: entry.severity,
      details: null,
      analysis: null,
      trigger: entry.trigger,
      timestamp: new Date().toISOString()
    });
  }

  console.log(`[QualityRunner] Cancelled check "${ruleId}" for session ${sessionId.slice(0, 8)}`);
  return true;
}
```

**Change 7:** Update the module.exports to include `cancelCheck`:

```js
module.exports = { onToolUse, onSessionStop, invalidateRulesCache, getRunningChecks, cancelCheck };
```

- [ ] **Step 2: Verify the server starts without errors**

Run: `cd "/Users/landonray/Coding Projects/Command Center/.claude/worktrees/synchronous-bouncing-globe" && node -e "const qr = require('./server/services/qualityRunner'); console.log(typeof qr.cancelCheck)"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add server/services/qualityRunner.js
git commit -m "feat: add quality check cancellation with AbortController support"
```

---

## Task 4: Add the cancel quality check API endpoint

**Files:**
- Modify: `server/routes/quality.js`

- [ ] **Step 1: Add the POST /cancel/:sessionId/:ruleId endpoint**

Add this route in `server/routes/quality.js`, after the existing `router.get('/results/running/:sessionId', ...)` route (after line 236):

```js
// Cancel a running quality check
router.post('/cancel/:sessionId/:ruleId', (req, res) => {
  const { sessionId, ruleId } = req.params;
  const { getSession } = require('../services/sessionManager');

  // Get the session's broadcast function for notifying listeners
  const session = getSession(sessionId);
  const broadcast = session ? (event) => session.broadcast(event) : null;

  const { cancelCheck } = require('../services/qualityRunner');
  const cancelled = cancelCheck(sessionId, ruleId, broadcast);

  if (cancelled) {
    res.json({ success: true, message: 'Quality check cancelled' });
  } else {
    res.status(404).json({ error: 'Check not found or already completed' });
  }
});
```

- [ ] **Step 2: Verify the route loads without errors**

Run: `cd "/Users/landonray/Coding Projects/Command Center/.claude/worktrees/synchronous-bouncing-globe" && node -e "require('./server/routes/quality')"`
Expected: No output (clean require)

- [ ] **Step 3: Commit**

```bash
git add server/routes/quality.js
git commit -m "feat: add API endpoint to cancel individual quality checks"
```

---

## Task 5: Add message queue management to sessionManager.js

**Files:**
- Modify: `server/services/sessionManager.js`

- [ ] **Step 1: Change messageQueue to store objects with IDs instead of plain strings**

In the constructor (around line 129), the queue initialization stays the same:
```js
this.messageQueue = [];
```

Add a counter for generating queue IDs. Near the top of the file (after the existing imports/variables), add:
```js
let queueIdCounter = 0;
```

- [ ] **Step 2: Update sendMessage() to store queue objects and broadcast**

In `sendMessage()` (around line 893-895), replace the line:
```js
      this.messageQueue.push(text);
```
with:
```js
      const queueId = `q_${++queueIdCounter}_${Date.now()}`;
      this.messageQueue.push({ id: queueId, content: text, queuedAt: new Date().toISOString() });
      this.broadcast({
        type: 'message_queued',
        sessionId: this.id,
        messageId: queueId,
        content: text,
        queuedAt: new Date().toISOString()
      });
```

- [ ] **Step 3: Update all queue consumers to use `.content` instead of plain string**

There are multiple places that do `const nextMsg = this.messageQueue.shift()` followed by `this.sendMessage(nextMsg)`. Each needs to extract `.content`. Find and update each occurrence:

**Location 1** (around line 499-500, inside handleTmuxProcessExit):
Replace:
```js
      const nextMsg = this.messageQueue.shift();
      setTimeout(() => this.sendMessage(nextMsg), 100);
```
with:
```js
      const nextMsg = this.messageQueue.shift();
      setTimeout(() => this.sendMessage(nextMsg.content), 100);
```

**Location 2** (around line 620-621, inside spawnDirectProcess process close handler):
Replace:
```js
        const nextMsg = this.messageQueue.shift();
        setTimeout(() => this.sendMessage(nextMsg), 100);
```
with:
```js
        const nextMsg = this.messageQueue.shift();
        setTimeout(() => this.sendMessage(nextMsg.content), 100);
```

**Location 3** (around line 646-648, inside process error handler):
Replace:
```js
        const nextMsg = this.messageQueue.shift();
        setTimeout(() => this.sendMessage(nextMsg), 100);
```
with:
```js
        const nextMsg = this.messageQueue.shift();
        setTimeout(() => this.sendMessage(nextMsg.content), 100);
```

**Location 4** (around line 853-855, inside processStreamEvent result handler):
Replace:
```js
                const nextMsg = this.messageQueue.shift();
                setTimeout(() => this.sendMessage(nextMsg), 100);
```
with:
```js
                const nextMsg = this.messageQueue.shift();
                setTimeout(() => this.sendMessage(nextMsg.content), 100);
```

- [ ] **Step 4: Add getQueue() and deleteFromQueue() methods to the Session class**

Add these methods to the Session class, after the existing `end()` method:

```js
  getQueue() {
    return this.messageQueue.map(({ id, content, queuedAt }) => ({ id, content, queuedAt }));
  }

  deleteFromQueue(messageId) {
    const index = this.messageQueue.findIndex(m => m.id === messageId);
    if (index === -1) return false;

    this.messageQueue.splice(index, 1);
    this.broadcast({
      type: 'message_dequeued',
      sessionId: this.id,
      messageId,
      timestamp: new Date().toISOString()
    });
    return true;
  }
```

- [ ] **Step 5: Verify the server starts without errors**

Run: `cd "/Users/landonray/Coding Projects/Command Center/.claude/worktrees/synchronous-bouncing-globe" && node -e "require('./server/services/sessionManager')"`
Expected: No output (clean require)

- [ ] **Step 6: Commit**

```bash
git add server/services/sessionManager.js
git commit -m "feat: add queue IDs and delete support for message queue management"
```

---

## Task 6: Add queue API endpoints to sessions routes

**Files:**
- Modify: `server/routes/sessions.js`

- [ ] **Step 1: Add GET /:id/queue and DELETE /:id/queue/:messageId endpoints**

Add these routes in `server/routes/sessions.js`, after the existing `POST /:id/end` route (after line 237):

```js
// Get queued messages for a session
router.get('/:id/queue', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.json({ queue: [] });
  }
  res.json({ queue: session.getQueue() });
});

// Delete a queued message
router.delete('/:id/queue/:messageId', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or not active' });
  }

  const deleted = session.deleteFromQueue(req.params.messageId);
  if (deleted) {
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Message not found in queue (may have already been sent)' });
  }
});
```

- [ ] **Step 2: Verify the route loads without errors**

Run: `cd "/Users/landonray/Coding Projects/Command Center/.claude/worktrees/synchronous-bouncing-globe" && node -e "require('./server/routes/sessions')"`
Expected: No output (clean require)

- [ ] **Step 3: Commit**

```bash
git add server/routes/sessions.js
git commit -m "feat: add API endpoints for viewing and deleting queued messages"
```

---

## Task 7: Add cancel and delete UI controls to the frontend

**Files:**
- Modify: `client/src/hooks/useWebSocket.js`
- Modify: `client/src/components/Chat/MessageList.jsx`
- Modify: `client/src/components/Chat/MessageList.module.css`
- Modify: `client/src/components/Chat/ChatInterface.jsx`

- [ ] **Step 1: Update useWebSocket.js to handle queue events and expose action functions**

Add a `queuedMessages` state and handlers for `message_queued` / `message_dequeued`. Also expose `cancelQualityCheck` and `deleteQueuedMessage` functions.

At the top of `useWebSocket`, add state:
```js
  const [queuedMessages, setQueuedMessages] = useState([]);
```

Inside the `ws.onmessage` switch statement, add two new cases (after the `quality_result` case, before `error`):

```js
            case 'message_queued': {
              setQueuedMessages(prev => {
                if (prev.some(m => m.id === data.messageId)) return prev;
                return [...prev, {
                  id: data.messageId,
                  content: data.content,
                  queuedAt: data.queuedAt
                }];
              });
              break;
            }

            case 'message_dequeued': {
              setQueuedMessages(prev => prev.filter(m => m.id !== data.messageId));
              break;
            }
```

In the `session_ended` case, also clear queued messages:
```js
            case 'session_ended':
              setStatus('ended');
              resumingRef.current = false;
              setResuming(false);
              setMessages([]);
              setStreamEvents([]);
              setQueuedMessages([]);
              clearEvents();
              break;
```

Add two action functions after the existing `clearSendError` callback:

```js
  const cancelQualityCheck = useCallback((ruleId) => {
    return api.post(`/api/quality/cancel/${sessionId}/${ruleId}`).catch(() => {});
  }, [sessionId]);

  const deleteQueuedMessage = useCallback((messageId) => {
    setQueuedMessages(prev => prev.filter(m => m.id !== messageId));
    return api.delete(`/api/sessions/${sessionId}/queue/${messageId}`).catch(() => {});
  }, [sessionId]);
```

Update the return object to include the new state and functions:

```js
  return {
    messages,
    setMessages,
    status,
    errorMessage,
    pendingPermission,
    streamEvents,
    sendMessage,
    approvePermission,
    resuming,
    sendError,
    clearSendError,
    optimisticMessagesRef,
    queuedMessages,
    cancelQualityCheck,
    deleteQueuedMessage
  };
```

Also, in the reconnect handler (inside `ws.onclose`), add a fetch for the queue state. In the `Promise.all` array, add a fourth fetch:

```js
                api.get(`/api/sessions/${sessionId}/queue`).catch(() => ({ queue: [] })),
```

And in the `.then()` destructuring, add it:
```js
              ]).then(([msgResult, qualityResult, runningResult, queueResult]) => {
```

And at the end of the `.then()` callback, set the queue state:
```js
                  setQueuedMessages(queueResult.queue || []);
```

- [ ] **Step 2: Update ChatInterface.jsx to pass new props to MessageList**

In `ChatInterface.jsx`, destructure the new values from `useWebSocket`:

Replace the existing destructuring (around line 20-24):
```js
  const {
    messages, setMessages, status, errorMessage, pendingPermission,
    streamEvents, sendMessage, approvePermission, resuming,
    sendError, clearSendError, optimisticMessagesRef,
    queuedMessages, cancelQualityCheck, deleteQueuedMessage
  } = useWebSocket(sessionId);
```

Also load the initial queue when the session loads. In the `loadMessages` function (around line 68), add to the `Promise.all`:
```js
            api.get(`/api/sessions/${sessionId}/queue`).catch(() => ({ queue: [] })),
```

Update the destructuring in the `.then()` and set queuedMessages. Actually, since `queuedMessages` is managed by `useWebSocket`, we should load the initial queue there instead. Add an effect in `useWebSocket.js` to load queue on mount:

After the main `useEffect` that sets up the WebSocket (after line 327), add:
```js
  // Load initial queue state when session changes
  useEffect(() => {
    if (!sessionId) return;
    api.get(`/api/sessions/${sessionId}/queue`)
      .then(data => setQueuedMessages(data.queue || []))
      .catch(() => setQueuedMessages([]));
  }, [sessionId]);
```

Update the `<MessageList>` component call in `ChatInterface.jsx` (around line 402):
```jsx
      <MessageList
        messages={messages}
        loading={loading}
        streamEvents={streamEvents}
        status={status}
        sendMessage={sendMessage}
        queuedMessages={queuedMessages}
        onCancelCheck={cancelQualityCheck}
        onDeleteQueued={deleteQueuedMessage}
      />
```

- [ ] **Step 3: Update MessageList.jsx to render cancel buttons and queued messages**

Update the `QualityResultItem` component to accept and show a cancel button. Change its signature and add the button:

```jsx
function QualityResultItem({ msg, sendMessage, onCancel }) {
  const [expanded, setExpanded] = useState(false);
  const isRunning = msg.result === 'running';
  const isFail = msg.result === 'fail';
  const isCancelled = msg.result === 'cancelled';
  const hasAnalysis = msg.analysis && msg.analysis.length > 0;
  const hasDetails = msg.details && msg.details.length > 0;
  const isExpandable = !isRunning && !isCancelled && (hasAnalysis || hasDetails);

  const handleSendAsMessage = (e) => {
    e.stopPropagation();
    const parts = [
      `**Quality Review: ${msg.ruleName}** — ${msg.result.toUpperCase()}`,
    ];
    if (msg.details) parts.push(msg.details);
    if (msg.analysis) parts.push(`**Analysis:**\n${msg.analysis}`);
    sendMessage(parts.join('\n\n'));
  };

  const handleCancel = (e) => {
    e.stopPropagation();
    if (onCancel) onCancel(msg.ruleId);
  };

  const stateClass = isRunning ? styles.qualityRunning
    : isCancelled ? styles.qualityCancelled
    : isFail ? styles.qualityFail
    : styles.qualityPass;

  return (
    <div
      className={`${styles.qualityResult} ${stateClass} ${isExpandable ? styles.qualityClickable : ''}`}
      onClick={() => isExpandable && setExpanded(!expanded)}
    >
      <div className={styles.qualityIcon}>
        {isRunning ? <Loader size={14} className={styles.qualitySpinner} />
          : isCancelled ? <X size={14} />
          : isFail ? <ShieldAlert size={14} />
          : <ShieldCheck size={14} />}
      </div>
      <div className={styles.qualityBody}>
        <span className={styles.qualityLabel}>
          {isExpandable && (expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
          {msg.ruleName}
          {isRunning && <span className={styles.qualityRunningText}>reviewing</span>}
          {isCancelled && <span className={styles.qualityCancelledText}>cancelled</span>}
          <span className={`${styles.qualityBadge} ${styles[`severity-${msg.severity}`]}`}>{msg.severity}</span>
        </span>
        {msg.details && <span className={styles.qualityDetails}>{msg.details}</span>}
        {expanded && (
          <div className={styles.qualityAnalysis}>
            {hasAnalysis && <MarkdownPreview content={msg.analysis} />}
            {sendMessage && (
              <button className={styles.qualitySendBtn} onClick={handleSendAsMessage}>
                <Send size={12} />
                Send as message
              </button>
            )}
          </div>
        )}
      </div>
      {isRunning && onCancel && (
        <button className={styles.qualityCancelBtn} onClick={handleCancel} title="Cancel this check">
          <X size={12} />
        </button>
      )}
      {msg.timestamp && <span className={styles.qualityTime}>{formatDate(msg.timestamp)}</span>}
    </div>
  );
}
```

Add a new `QueuedMessageItem` component before the `MessageList` export:

```jsx
function QueuedMessageItem({ msg, onDelete }) {
  const handleDelete = (e) => {
    e.stopPropagation();
    if (onDelete) onDelete(msg.id);
  };

  return (
    <div className={`${styles.message} ${styles.userMessage} ${styles.queuedMessage}`}>
      <div className={styles.avatar}>
        <User size={16} />
      </div>
      <div className={styles.content}>
        <div className={styles.meta}>
          <span className={styles.role}>You</span>
          <span className={styles.queuedBadge}>Queued</span>
        </div>
        <div className={styles.text}>
          <MarkdownPreview content={msg.content.trim()} />
        </div>
      </div>
      <button className={styles.queuedDeleteBtn} onClick={handleDelete} title="Remove from queue">
        <X size={14} />
      </button>
    </div>
  );
}
```

Update the `MessageList` component signature and render:

```jsx
export default function MessageList({ messages, loading, streamEvents, status, sendMessage, queuedMessages = [], onCancelCheck, onDeleteQueued }) {
```

Inside the JSX return, after the messages map and before the WorkingIndicator, add the queued messages:

```jsx
      {/* Queued messages — shown after all regular messages, before working indicator */}
      {queuedMessages.map((msg) => (
        <QueuedMessageItem key={msg.id} msg={msg} onDelete={onDeleteQueued} />
      ))}
```

Update the `QualityResultItem` render call to pass `onCancel`:
```jsx
        if (msg.role === 'quality') {
          return <QualityResultItem key={i} msg={msg} sendMessage={sendMessage} onCancel={onCancelCheck} />;
        }
```

- [ ] **Step 4: Add CSS styles for cancelled state, cancel button, and queued messages**

Add these styles to the end of `client/src/components/Chat/MessageList.module.css`:

```css
/* Cancelled quality check */
.qualityCancelled {
  background: color-mix(in srgb, var(--text-muted) 6%, transparent);
  border-left-color: var(--text-muted);
  opacity: 0.7;
}

.qualityCancelled .qualityIcon {
  color: var(--text-muted);
}

.qualityCancelledText {
  font-size: 11px;
  font-weight: 400;
  color: var(--text-muted);
  font-style: italic;
}

.qualityCancelBtn {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.qualityCancelBtn:hover {
  background: color-mix(in srgb, var(--error, #ef4444) 15%, transparent);
  color: var(--error, #ef4444);
}

/* Queued messages */
.queuedMessage {
  opacity: 0.6;
  position: relative;
}

.queuedBadge {
  font-size: 10px;
  font-weight: 500;
  padding: 1px 5px;
  border-radius: 4px;
  text-transform: uppercase;
  background: color-mix(in srgb, var(--warning, #f59e0b) 15%, transparent);
  color: var(--warning, #f59e0b);
}

.queuedDeleteBtn {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.15s, background 0.15s, color 0.15s;
}

.queuedMessage:hover .queuedDeleteBtn {
  opacity: 1;
}

.queuedDeleteBtn:hover {
  background: color-mix(in srgb, var(--error, #ef4444) 15%, transparent);
  color: var(--error, #ef4444);
}
```

- [ ] **Step 5: Verify the frontend builds without errors**

Run: `cd "/Users/landonray/Coding Projects/Command Center/.claude/worktrees/synchronous-bouncing-globe/client" && npx vite build 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/useWebSocket.js client/src/components/Chat/MessageList.jsx client/src/components/Chat/MessageList.module.css client/src/components/Chat/ChatInterface.jsx
git commit -m "feat: add cancel quality check and delete queued message UI controls"
```

---

## Task 8: Integration testing — verify both features end-to-end

**Files:** None (manual verification)

- [ ] **Step 1: Start the dev server and verify it runs**

Run the server and confirm both features are accessible:
1. Server starts without errors
2. Navigate to a session in the browser
3. Verify the quality check cancel button appears when a check is running (the X button next to the spinner)
4. Verify queued messages appear with "Queued" badge and X button when sending a message while the agent is working

- [ ] **Step 2: Test quality check cancellation**

1. Start a session and trigger a quality check (e.g., edit a file to trigger PostToolUse checks)
2. While the check is running (spinner visible), click the X button
3. Verify: the spinner stops, check shows as "cancelled" (greyed out)
4. Verify: the cancelled check doesn't trigger a send_fail_to_agent loop
5. Verify: other running checks (if any) continue unaffected

- [ ] **Step 3: Test queued message deletion**

1. Start a session and send a message so the agent is working
2. While the agent is working, send another message (it should queue)
3. Verify: the queued message appears dimmed with a "Queued" badge
4. Click the X on the queued message
5. Verify: the message disappears from the chat
6. When the agent finishes, verify: the deleted message is NOT sent

- [ ] **Step 4: Test edge cases**

1. Cancel a check and immediately see the result arrive (race condition) — should show the real result, not cancelled
2. Queue multiple messages, delete the middle one — the others should send in order
3. Refresh the page while checks are running — running checks should show spinners on reload (existing behavior preserved)
4. Refresh the page while messages are queued — queued messages should appear (loaded via GET /queue endpoint)

- [ ] **Step 5: Commit any fixes found during testing**

```bash
git add -A
git commit -m "fix: address integration testing feedback for cancel checks and delete queue"
```

---

## Task 9: Create pull request

- [ ] **Step 1: Push branch and create PR**

```bash
git push -u origin worktree-synchronous-bouncing-globe
gh pr create --title "feat: cancel quality checks and delete queued messages" --body "$(cat <<'EOF'
## Summary
- Users can now cancel individual quality checks while they're running (X button next to spinner)
- Users can now delete queued messages before they're sent to the agent (X button on queued messages)
- Queued messages appear inline in the chat with a "Queued" badge and dimmed styling

## Test plan
- [ ] Start a session, trigger quality checks, verify cancel button appears and works
- [ ] Send messages while agent is working, verify queue appears with delete controls
- [ ] Verify cancelled checks don't trigger send_fail_to_agent loops
- [ ] Verify page refresh preserves running check spinners and queued message visibility
- [ ] Verify deleting a queued message prevents it from being sent

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
