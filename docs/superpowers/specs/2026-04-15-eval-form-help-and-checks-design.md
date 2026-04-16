# Eval Form: Missing Check Types, Help Text, and Expected Outcome Field

**Date:** 2026-04-15
**Status:** Approved

## Problem

The eval creation form (CreateEvalForm.jsx) has three gaps:

1. **Missing check types:** The backend supports 11 check types but the UI dropdown only exposes 6. The 5 newer types (equals, contains, greater_than, less_than, numeric_score) can only be used by hand-editing YAML files.
2. **No explanation text:** The form has placeholder text in fields but no guidance explaining what each section does, what each option means, or how to use it. A user unfamiliar with the eval system would be lost.
3. **Missing Expected Outcome field:** The LLM Judge section requires an `expected` field in the backend, but the form doesn't expose it. The judge can't function without it.

## Solution

A single pass through `CreateEvalForm.jsx` and its CSS module that:

1. Adds the 5 missing check types to the dropdown with their configuration fields
2. Adds explanation text throughout (inline text for short explanations, hover tooltips for longer ones)
3. Adds the Expected Outcome field to the LLM Judge section

## Architecture

### Tooltip Component

A lightweight inline tooltip component — no external library. Renders an info icon that shows a popover on hover, styled to match the existing form aesthetic.

- Small reusable component, either defined at the top of CreateEvalForm.jsx or in its own file if it gets reused elsewhere
- CSS in the existing CreateEvalForm.module.css
- Accessible: uses `aria-describedby` pattern

### Help Text Strategy

Two tiers:

| Tier | When to use | Implementation |
|------|-------------|----------------|
| **Inline hint** | Short (1 sentence) context under a section title | Small muted text below the section header |
| **Hover tooltip** | Longer explanation that would clutter the form | Info icon + popover on hover |

## Detailed Changes

### EVIDENCE Section

**Inline hint under title:**
> "How the eval gathers data to check. Pick a source and configure how to collect it."

**Tooltips on each evidence type option (shown when selected or as description in dropdown):**

| Evidence Type | Tooltip |
|---------------|---------|
| Log Query | "Searches through logs (session logs, build output, or PR diffs) and optionally filters lines with a regex pattern." |
| File | "Reads the contents of a file at the path you specify." |
| Database Query | "Runs a SQL query against your database and returns the results." |
| Sub-Agent | "Sends a prompt to an LLM to extract or summarize information from a context source." |

**Tooltip on Max Bytes:**
> "The maximum amount of data to read. 50,000 (default) is good for most cases. Increase for large files or logs, decrease if you only need a small snippet."

**Tooltip on Timeout:**
> "How long to wait before giving up, in milliseconds. 30,000 (30 seconds) is the default. Increase for slow database queries or large file reads."

### INPUTS Section

**Inline hint under title:**
> "Variables passed to your eval at runtime. Use ${key} in other fields to reference them."

**Tooltip on key/value area:**
> "The left side is the variable name. The right side is the value — either a literal or a ${variable} reference that gets filled in at runtime."

### CHECKS Section

**Inline hint under title:**
> "Deterministic pass/fail rules applied to the evidence. Each check runs independently."

**New check types added to dropdown:**

| Check Type | Label | Config Fields |
|------------|-------|---------------|
| equals | Equals | `value` (required), `field` (optional) |
| contains | Contains | `value` (required), `field` (optional) |
| greater_than | Greater Than | `value` (required, numeric), `field` (optional) |
| less_than | Less Than | `value` (required, numeric), `field` (optional) |
| numeric_score | Numeric Score | `min` (optional), `max` (optional), `field` (optional) |

**Per-check-type help text (shown when check type is selected):**

| Check Type | Help Text |
|------------|-----------|
| Not Empty | "Passes if the evidence contains any non-whitespace content." |
| Regex Match | "Passes if the evidence matches the regular expression pattern you provide." |
| JSON Valid | "Passes if the evidence is valid JSON." |
| JSON Schema | "Passes if the evidence is valid JSON that conforms to the schema file you specify." |
| HTTP Status | "Passes if the evidence contains the HTTP status code you specify." |
| Field Exists | "Passes if the specified field path exists in the JSON evidence. Use dot notation for nested fields (e.g. data.user.id)." |
| Equals | (grouped — see below) |
| Contains | (grouped — see below) |
| Greater Than | (grouped — see below) |
| Less Than | (grouped — see below) |
| Numeric Score | "Checks that a numeric value falls within a range. Set a min, max, or both. Useful for scoring responses on a scale." |

**Grouped explanation for Equals, Contains, Greater Than, Less Than:**
> "Compares the evidence (or a field extracted from JSON evidence) against the value you provide. Equals checks for an exact match, Contains checks for a substring, Greater/Less Than compare numerically."

**Field Path tooltip (shown for checks that support it):**
> "Optional. If your evidence is JSON, use dot notation to extract a specific value before comparing (e.g. data.score). Leave empty to compare against the full evidence text."

### LLM JUDGE Section

**Inline hint under title:**
> "An LLM reviews the evidence and decides if the eval passes. Use this for subjective or complex judgments that can't be captured with deterministic checks."

**New field: Expected Outcome** (text input, required when Judge Prompt is filled in)
- Label: "Expected Outcome *" (asterisk shown when judge prompt has content)
- Placeholder: "Describe what a passing result looks like"
- Tooltip: "Describe what a passing result looks like in plain English. The judge LLM uses this as its success criteria."
- Validation: required if `judge_prompt` is non-empty

**Tooltip on Judge Prompt:**
> "Instructions for the LLM judge. Tell it what to look for in the evidence, what matters, and what should cause a failure."

**Tooltip on Model Tier:**
> "Which LLM to use. Default (Sonnet) is a good balance. Fast (Haiku) is cheaper but less capable. Strong (Opus) is the most capable but costs more."

## Files Changed

| File | Change |
|------|--------|
| `client/src/components/Quality/CreateEvalForm.jsx` | Add missing check types, help text, tooltip component, expected outcome field, config fields for new checks |
| `client/src/components/Quality/CreateEvalForm.module.css` | Styles for inline hints, tooltips, new fields |
| `client/src/__tests__/CreateEvalForm.test.jsx` | Update tests for new check types, expected outcome field, tooltip rendering |

## Validation Rules

- Expected Outcome field is required when Judge Prompt is non-empty (matches backend requirement)
- Value field is required for equals, contains, greater_than, less_than checks
- At least one of min or max is required for numeric_score
- Greater_than, less_than, and numeric_score value/min/max fields accept only numeric input

## What This Does NOT Change

- Backend logic (all 11 check types and the `expected` field are already supported)
- Evidence types (all 4 are already in the dropdown)
- Form layout or visual style beyond adding the new elements
- Any other pages or components
