# Evals Module — Design Specification

## Purpose

Add an evaluation system to Mission Control that runs assertion-style tests against agent work after triggering events (session end, PR update, manual). Failures are reported back to the active CLI session as a single prose message containing current results and recent run history, giving the agent the feedback signal it needs to recognize regressions and course-correct.

## Scope

This spec covers:
- Project entity promotion and `.mission-control.yaml` discovery
- Eval definitions, evidence gathering, judging, run storage
- Triggers, orchestration, and failure reporting
- Quality tab UI
- Quality rules per-project scoping
- Agent-authored eval integration point

## Implementation Approach

Projects first, then evals on top. The minimal project entity and `.mission-control.yaml` discovery are built first, quality rules get per-project scoping, then the evals engine is built on that foundation.

---

## 1. Project Entity & Discovery

### Database

New `projects` table with minimal schema:

| Column | Type | Description |
|--------|------|-------------|
| id | UUID | Auto-generated primary key |
| name | TEXT | Display name, derived from directory name initially |
| root_path | TEXT | Absolute path to the project root (unique) |
| created_at | TIMESTAMP | When the record was created |
| settings | JSONB | Extensible blob for per-project overrides |

The `sessions` table gains a `project_id` foreign key.

### .mission-control.yaml

Lives in the project repo root. Declares codebase-level facts that travel with the code:

```yaml
project:
  name: event-scraper  # optional display name override

evals:
  folders:
    - evals/event-onboarding
    - evals/recipe-extraction

quality_rules:
  enabled:
    - no-hardcoded-secrets
    - require-error-handling
  disabled:
    - enforce-types
```

### Discovery Flow

1. Session starts with a working directory
2. Mission Control walks up the directory tree looking for `.mission-control.yaml`
3. If found, reads the file and checks the database for a project with a matching `root_path`
4. If no project record exists, auto-creates one
5. Session gets linked to the project via `project_id`

If no `.mission-control.yaml` exists, the session works like today — no project association, global quality rules apply, no evals available. Backward compatible.

---

## 2. Eval File Format & Folder Structure

Evals live in the project repo as YAML files. Each subfolder is a logical group — the unit of arming.

### Example Structure

```
event-scraper/
  .mission-control.yaml
  evals/
    event-onboarding/
      scrape-count.yaml
      specific-event-found.yaml
    recipe-extraction/
      recipe-matches-expected.yaml
      recipe-structure-valid.yaml
```

### Eval File Schema

```yaml
name: <string, required>          # Human-readable identifier
description: <string, required>   # What this eval checks and why
input: <map, required>            # Key-value input to the system being tested
expected: <string, optional>      # Natural language success description (required if judge_prompt is present)
evidence:                         # How to gather the actual result
  type: <log_query | db_query | sub_agent | file>
  # ...type-specific config (see Section 3)
  allow_empty: <boolean, optional, default false>
checks: <list, optional>          # Deterministic assertions (see below)
judge_prompt: <string, optional>  # Instructions for the LLM judge
judge:
  model: <default | fast | strong, optional>  # Model tier override
```

**Validation rule:** Every eval must have at least one of `checks` or `judge_prompt`. An eval with neither is rejected at load time.

**Eval types:**
- **Judge eval** — has `expected`, `judge_prompt`, and optionally `checks`
- **Deterministic eval** — has only `checks`, no judge call needed
- **Gated judge eval** — has `checks` that must pass before the judge is invoked

### Check Types (Starter Vocabulary)

| Type | Description | Config |
|------|-------------|--------|
| `regex_match` | Evidence matches a regex pattern | `pattern: <regex>` |
| `not_empty` | Evidence is non-empty | — |
| `json_valid` | Evidence parses as valid JSON | — |
| `json_schema` | Evidence conforms to a JSON schema | `schema: <path>` |
| `http_status` | HTTP response status matches | `status: <int>` |
| `field_exists` | A named field exists in the evidence | `field: <name>` |

New types are added deliberately to the engine, not invented per-eval.

### Evidence Sources (for log_query type)

| Source | Description |
|--------|-------------|
| `session_log` | Log from the session that triggered this eval run |
| `pr_diff` | Diff from the PR that triggered the run |
| `build_output` | stdout/stderr from the most recent build |

The `file` evidence type is separate — see Section 3.

### Variable Interpolation

Available in evidence queries, params, filter patterns, and extraction prompts:

| Namespace | Variables |
|-----------|-----------|
| `${input.*}` | Values from the eval's input map |
| `${eval.name}` | The eval's name |
| `${run.commit_sha}` | Commit at time of run |
| `${run.trigger}` | What triggered the run |
| `${project.root}` | Project root path |

### Examples

**Log query eval:**

```yaml
name: scrape-count
description: Verify the scraper found the expected number of events from the target URL
input:
  url: "https://example.com/events"
expected: "The scraper should find at least 15 events from this source"
evidence:
  type: log_query
  source: session_log
  filter:
    regex: "events? (found|scraped|extracted)"
checks:
  - type: regex_match
    pattern: "\\d+ events"
    description: "Log must contain an event count"
judge_prompt: |
  You are evaluating whether a web scraper found the expected number of events.
  Compare the evidence from the logs against the expected outcome.
  Pass if the logs show 15 or more events were found from the source URL.
  Fail if fewer events were found, no count is visible, or the scrape errored.
```

**Database query eval:**

```yaml
name: recipe-matches-expected
description: Verify the system created the correct extraction recipe for a given URL
input:
  url: "https://example.com/events"
expected: "Recipe should extract event name, date, venue, and price fields"
evidence:
  type: db_query
  query: "SELECT * FROM recipes WHERE source_url = :url ORDER BY created_at DESC LIMIT 1"
  params:
    url: "${input.url}"
checks:
  - type: not_empty
    description: "A recipe record must exist for this URL"
judge_prompt: |
  You are evaluating whether an auto-generated scraping recipe correctly
  captures the required fields. The expected fields are listed in the
  expected outcome. Check the recipe definition in the evidence to see
  if each field is represented. Pass if all expected fields are present
  and the extraction logic looks reasonable. Fail if fields are missing
  or the recipe structure is malformed.
```

**Sub-agent eval:**

```yaml
name: instructions-to-json-fidelity
description: Verify every instruction in step 3 was accurately translated to JSON in step 5
input:
  session_id: "${run.trigger_session}"
expected: "Every instruction from step 3 should have a corresponding valid JSON representation in step 5. No instructions should be dropped or misrepresented."
evidence:
  type: sub_agent
  context_source: session_log
  extraction_prompt: |
    Read the multi-agent log and extract two things:
    1. Every instruction listed in the step 3 output
    2. The final JSON produced in step 5
    Return as: { "instructions": [...], "final_json": {...} }
checks:
  - type: json_valid
    description: "Extracted evidence must be valid JSON"
  - type: field_exists
    field: "instructions"
    description: "Instructions array must be present"
  - type: field_exists
    field: "final_json"
    description: "Final JSON must be present"
judge_prompt: |
  You are evaluating whether a multi-agent system faithfully translated
  instructions into JSON output. Compare every instruction from the
  "instructions" array against the "final_json" structure.
  Pass if each instruction has a clear corresponding representation in
  the JSON. Fail if any instruction was dropped, misinterpreted, or
  only partially represented. Call out specific instructions that failed.
```

**Deterministic-only eval:**

```yaml
name: build-output-valid
description: Verify the page builder produces valid JSON output
input: {}
evidence:
  type: file
  path: "output/pages.json"
checks:
  - type: json_valid
    description: "Output must be valid JSON"
  - type: json_schema
    schema: "schemas/pages-schema.json"
    description: "Output must conform to the pages schema"
```

---

## 3. Evidence Gathering Engine

Four gatherer types, each with its own size cap, truncation strategy, and failure mode.

### Size Caps

| Type | Default Cap | Truncation Strategy |
|------|-------------|-------------------|
| `log_query` | 50KB | Head + tail with "[truncated — X lines omitted]" |
| `db_query` | 50KB | Row-count (keep first N rows, note "X more rows omitted"). Never cut mid-row. |
| `sub_agent` | 200KB | No truncation. If exceeded, eval fails with "evidence too large" error. |
| `file` | 50KB | Head + tail with "[truncated — X lines omitted]" |

All caps configurable per-eval in the YAML.

### Log Query Gatherer

- Reads from the defined source (`session_log`, `pr_diff`, or `build_output`)
- Applies filters (regex, time window) to extract the relevant slice
- Returns matching content as a string
- **Failure mode:** Source doesn't exist → error state

### Database Query Gatherer

- Executes declared SQL against the project's database
- Binds parameters from interpolation namespaces
- Returns query results as JSON
- **Safety:** Read-only credentials required. The project declares `DATABASE_URL_READONLY` in `.mission-control.yaml` or `.env`. The gatherer refuses to run if this isn't configured — it will not fall back to the primary connection string. Connection is also opened in a read-only transaction as a second layer.
- **Failure mode:** DB unreachable, query syntax error, timeout → error state

### File Gatherer

- Reads the contents of a specific file relative to the project root
- Path supports variable interpolation (e.g., `${input.output_file}`)
- Returns file contents as a string
- **Failure mode:** File doesn't exist → error state

### Sub-Agent Gatherer

- Writes context source to a temporary file in a sandboxed temp directory
- Invokes a Claude CLI session with the file path injected into the extraction prompt
- Agent reads the file as needed — selective about what it extracts
- Temp files cleaned up after eval completes
- **Timeout:** 5 minutes (configurable per-eval)
- **Isolation:** Sandboxed configuration with:
  - Read-only access to the context temp file only
  - No MCP servers
  - No tools that mutate state (no file writes, no git operations, no network calls beyond LLM)
  - No access to tmux sessions or other running agents
  - Permission mode locked to most restrictive setting
- **Failure mode:** Agent errors, timeout, garbled response → error state

### Empty Evidence Handling

"Evidence exists" is an implicit check. If the gatherer returns empty results, the eval fails immediately as a check failure without invoking the judge. To opt in to empty evidence being valid:

```yaml
evidence:
  type: db_query
  allow_empty: true
```

### Execution Order

1. Gather evidence
2. If evidence gathering errors → "error" state, stop
3. If evidence is empty and `allow_empty` is not set → "fail" with reason "no evidence gathered," stop
4. Run **all** checks (don't short-circuit — report all failures at once)
5. If any check failed → "fail" with all failures reported, stop
6. If no `judge_prompt` → "pass," stop (deterministic-only eval)
7. Call judge
8. Parse response (strip fences, extract JSON, validate schema)
9. If parse fails → "error" state, log raw response, stop
10. Record verdict

---

## 4. The Judge

Single LLM call through the existing LLM Gateway. Uniform interface for every eval.

### System Prompt (standard, not author-written)

```
You are an evaluation judge. Your job is to determine whether
gathered evidence satisfies an expected outcome. You will receive
the expected outcome, the evidence, and specific judging criteria.

Evaluate strictly against the criteria provided. Do not infer
intent or give partial credit unless the criteria explicitly
allow it. If the evidence is ambiguous, say so and assign low
confidence.

When citing evidence in your reasoning, quote the specific text
from the evidence section that supports your verdict. Do not
paraphrase. Every factual claim in your reasoning must reference
actual text from the evidence.

Respond in exactly this JSON format:
{
  "result": "pass" or "fail",
  "confidence": "low" or "medium" or "high",
  "reasoning": "Your explanation, with direct quotes from evidence"
}
```

### Prompt Structure

```
## Expected Outcome
{expected}

## Evidence
{evidence}

## Judging Criteria
{judge_prompt}
```

### Verdict Structure

| Field | Values | Description |
|-------|--------|-------------|
| `result` | pass, fail | The judgment |
| `confidence` | low, medium, high | How certain the judge is |
| `reasoning` | prose | Explanation with evidence quotes |

### Robust Response Parsing

1. Strip markdown fences if present
2. Extract the first JSON object from the response
3. Validate against expected schema (must have `result`, `confidence`, `reasoning`)
4. If parsing fails after all that → "error" state, raw response logged for debugging

### Confidence Handling

Any low-confidence verdict (pass or fail) gets an amber flag in the dashboard. In the feedback message, low-confidence verdicts are explicitly marked: "Judge confidence was low — verify before acting on this result."

### Model Selection

Constrained enum mapped at the gateway layer:

| Tier | Current Mapping | Use Case |
|------|----------------|----------|
| `default` | Sonnet | Most evals |
| `fast` | Haiku | Simple checks, high volume |
| `strong` | Opus | Complex reasoning, nuanced judgment |

Eval files never reference model names directly. Model rotations don't require updating evals.

### No Caching

Judge results are never cached. Even if evidence is identical between runs, caching would hide changes to the judge prompt itself. If you tighten a judge prompt and re-run, you need the new verdict.

---

## 5. Triggers, Run Orchestration & Failure Reporting

### Triggers

Configurable per eval folder. Available trigger types:

| Trigger | Fires When |
|---------|-----------|
| `session_end` | Session is marked complete or tmux pane exits |
| `pr_updated` | A watched PR receives a new commit |
| `manual` | User clicks "Run Armed Evals" in dashboard (always available) |

Each armed folder has its triggers configured in the arming UI. The auto-send setting (whether results are delivered to the CLI session) is also per-folder.

### Run Orchestration

- When a trigger fires, all evals in all armed folders configured for that trigger type run in parallel
- **No queuing.** Triggers are disabled while a batch is running. Missed triggers are ignored. Manual trigger is always available after the batch completes.
- A "run batch" groups all individual eval runs under one umbrella with shared timestamp and trigger source
- Batch is complete when all evals finish

**Per-eval timeouts:** 5 minutes for sub-agent, 30 seconds for log_query and db_query. Configurable per-eval. Timeout → error state.

### Run Storage

Every run stores:

| Field | Description |
|-------|-------------|
| eval_name | Name of the eval |
| eval_folder | Folder the eval belongs to |
| batch_id | Links to the trigger event |
| commit_sha | Commit at time of run |
| trigger_source | session_end, pr_updated, manual |
| timestamp | When the run executed |
| input | Input values used |
| evidence | Full snapshot of gathered evidence |
| check_results | All check outcomes (pass and fail) |
| judge_verdict | result, confidence, reasoning (null for deterministic evals) |
| duration | Total execution time |
| state | pass, fail, error |

**Retention:** 90 days or 100 runs per eval, whichever is larger. Configurable in project settings.

### Failure Reporting

If zero failures: silence. No message sent.

If one or more failures and auto-send is enabled for the folder, a single prose message is delivered to the active tmux CLI session:

```
Eval run complete: 8 evals ran, 2 failed, 1 error.

PASSED: specific-event-found (event-onboarding/)
PASSED: build-output-valid (event-onboarding/)
PASSED: instructions-to-json-fidelity (page-builder-fidelity/)
PASSED: component-count (page-builder-fidelity/)
PASSED: schema-valid (page-builder-fidelity/)

FAILED: recipe-matches-expected (recipe-extraction/)
Expected: Recipe should extract event name, date, venue, and price fields
Evidence: {"source_url": "https://...", "fields": ["name", "date", "venue"]}
Judge reasoning: "The recipe extracts 'name', 'date', and 'venue' but
the 'price' field is missing. Quoting evidence: '"fields":
["name", "date", "venue"]' — no price field present."
Confidence: high

FAILED: scrape-count (event-onboarding/)
Expected: The scraper should find at least 15 events from this source
Check failure: regex_match — pattern "\d+ events" not found in log
(Judge was not invoked — structural check failed)

ERROR: page-output-exists (event-onboarding/)
Evidence gathering failed: file "output/pages.json" not found
(Infrastructure issue, not a regression)

LAST 3 RUNS:
  recipe-matches-expected:    PASS abc1234 → PASS def5678 → FAIL ghi9012
  scrape-count:               PASS abc1234 → FAIL def5678 → FAIL ghi9012
  specific-event-found:       FAIL abc1234 → FAIL def5678 → PASS ghi9012
  build-output-valid:         PASS abc1234 → PASS def5678 → PASS ghi9012
  instructions-to-json:       PASS abc1234 → PASS def5678 → PASS ghi9012
  component-count:            PASS abc1234 → PASS def5678 → PASS ghi9012
  schema-valid:               PASS abc1234 → PASS def5678 → PASS ghi9012
  page-output-exists:         PASS abc1234 → PASS def5678 → ERROR ghi9012
```

**Delivery:** `tmux send-keys` to the active session. If no active session exists, results are stored and surfaced in the dashboard, optionally pushed as a notification.

---

## 6. Quality Tab UI

New tab in the session view alongside Files, Preview, and CLI.

### Layout

**Tab name:** "Quality"

**Section 1: Quality Rules** (collapsible, collapsed by default if no active rules)
- Shows rules enabled for this project with override indicators
- Toggle rules on/off per project
- Shows resolved state: global default → YAML override → DB override

**Section 2: Eval Folders** (collapsible)
- Lists all eval folders discovered from the project
- Each folder shows:
  - Folder name and eval count
  - Armed/disarmed toggle
  - Configured triggers (pills: `session_end`, `pr_updated`)
  - Auto-send toggle
  - Last run status: row of colored dots (green = pass, red = fail, amber = low confidence, gray = error)
- Expanding a folder shows individual evals with name, description, evidence type indicator, last verdict
- Clicking an eval drills into run history

**Section 3: Run History** (collapsible, bottom of tab)
- Recent run batches: timestamp, trigger source, commit SHA, summary (X passed, Y failed, Z errors)
- Expanding a batch shows each eval's result
- Drilling into a single run shows: input, evidence snapshot, check results, judge verdict and reasoning

**Manual run button:** "Run Armed Evals" at the top of the tab.

---

## 7. Quality Rules — Per-Project Scoping

### Priority Chain

1. Per-project database overrides (highest — your personal preferences)
2. `.mission-control.yaml` declarations (codebase-level defaults)
3. Global quality rule defaults (lowest)

### What Changes

- Global quality rules become project defaults
- Per project, any rule can be overridden: enable, disable, or change settings
- Overrides stored in the project's `settings` JSON blob
- The Quality tab shows the resolved state and lets you toggle overrides

### What Stays the Same

- Global settings page still exists for setting defaults
- Quality rules fire on the same events, same way
- Existing quality rule execution is unchanged

### Agent-Authored Evals Integration

- New quality rule type: `eval_authoring`
- When triggered, invokes an authoring prompt that tells the agent to propose new eval YAML files
- Agent writes files to the eval folder path declared in `.mission-control.yaml`
- The evals module is unaware of authorship — human-written and agent-written evals are identical files

---

## 8. Resolved Open Questions

| Question | Resolution |
|----------|-----------|
| Evidence size limits | Differentiated: 50KB log/db, 200KB sub-agent. Configurable per-eval. |
| Concurrent run conflicts | No queuing. Triggers disabled during batch execution. |
| Eval timeouts | 5 min sub-agent, 30s log/db. Configurable. Timeout → error. |
| Failed evidence gathering | Distinct "error" state. Shown in dashboard, noted in message, excluded from failure count. |
| Empty evidence | Implicit "evidence exists" check. Fails without judge call unless `allow_empty: true`. |
| Judge response parsing | Strip fences, extract first JSON, validate schema. Parse failure → error state. |
| DB safety | Read-only credentials required (`DATABASE_URL_READONLY`). Gatherer refuses to run without them. Read-only transaction as second layer. |
| Sub-agent isolation | Sandboxed: read-only context file access only, no MCP servers, no mutation tools, no tmux access. |
