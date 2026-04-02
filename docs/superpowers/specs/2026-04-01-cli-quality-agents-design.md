# CLI-Based Quality Check Agents

## Problem

Quality checks in Command Center currently run through the LLM Gateway API (`llm-gateway.replit.app`), which costs money per token. The user is on a Claude Max plan, which means CLI-spawned `claude --print` processes are included in the subscription at no additional cost. The goal is to move quality check execution from paid API calls to free CLI agents.

## Design

### Hybrid Execution Model

Each quality rule gets a configurable `execution_mode` that determines how it runs: via the CLI (`claude --print` subprocess) or via the existing LLM Gateway API. This allows per-rule control over which backend handles the check.

- **Default:** All quality rules default to `cli` mode.
- **LLM Gateway stays** for session naming and as a fallback for any rule explicitly set to `api` mode.

### Data Model Change

Add a column to the `quality_rules` table:

```sql
execution_mode TEXT DEFAULT 'cli'
```

Valid values: `'cli'` or `'api'`.

All existing seeded rules get `execution_mode: 'cli'` by default.

### New Service: `cliAgent.js`

A new service at `server/services/cliAgent.js` that wraps CLI subprocess spawning.

**Interface:**

```javascript
async function run({ prompt, ruleId, severity }) → { result: 'pass'|'fail', details: string|null, analysis: string }
```

**Behavior:**

- Appends the `QUALITY_RESULT:ruleId:severity:PASS/FAIL` marker instruction to the prompt (same format `qualityRunner` currently appends before sending to the API)
- Spawns `claude --print -p "<prompt>"` as a child process via `child_process.execFile`
- Captures stdout once the process exits
- Parses the `QUALITY_RESULT` marker from stdout
- Returns the same `{ result, details, analysis }` shape that `runQualityCheck()` already produces
- No concurrency cap initially; can be added later if machine resources become a concern

### Quality Runner Routing

In `qualityRunner.js`, the `runQualityCheck()` and `runSpecComplianceCheck()` functions add a branch based on `execution_mode`:

```
if rule.execution_mode === 'cli':
    response = cliAgent.run(prompt)
else:
    response = chatCompletion(prompt)
```

The prompt construction and result parsing remain identical regardless of execution mode. The only thing that changes is the backend that processes the prompt.

### New API Endpoint

```
PUT /api/quality/rules/:id/execution-mode
Body: { "mode": "cli" | "api" }
```

Updates the `execution_mode` column for a given rule. Returns the updated rule.

### Frontend: Rules Config UI

In `RulesConfig.jsx`, add an execution mode control to each rule's settings panel:

- A toggle or dropdown showing **CLI** / **API**
- Positioned alongside the existing severity selector and enable/disable toggle
- Calls `PUT /api/quality/rules/:id/execution-mode` on change

## What Stays the Same

- Event detection in `sessionManager.js` (watching the `--print` stream for tool-use events)
- Quality result storage, scorecard, analytics, and all frontend display components
- The `QUALITY_RESULT` marker format and parsing logic
- The `llmGateway.js` service (still used for session naming and `api`-mode rules)
- Hooks generator (unchanged; this is about server-side quality execution, not CLI hooks)

## What Changes

| Component | Change |
|-----------|--------|
| `server/database.js` | Add `execution_mode` column to `quality_rules` schema and seed data |
| `server/services/cliAgent.js` | New file — wraps `claude --print` subprocess spawning |
| `server/services/qualityRunner.js` | Route checks through `cliAgent` or `chatCompletion` based on `execution_mode` |
| `server/routes/quality.js` | New endpoint for updating execution mode |
| `client/src/components/Quality/RulesConfig.jsx` | Add execution mode toggle per rule |
