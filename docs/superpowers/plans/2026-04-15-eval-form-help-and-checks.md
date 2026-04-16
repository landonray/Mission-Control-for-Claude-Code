# Eval Form: Missing Check Types, Help Text, and Expected Outcome Field — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the 5 missing check types to the eval creation form dropdown, add explanation text (inline hints + hover tooltips) throughout all sections, and ensure the Expected Outcome field is properly surfaced for the LLM Judge.

**Architecture:** The form already exists as a single component (`CreateEvalForm.jsx`) with sub-components for Evidence, Checks, and Inputs. We'll add a small `Tooltip` component inline, extend the `CHECK_TYPES` array, add config field rendering for new check types, add inline hint text under section titles, and wire tooltips to labels that need longer explanations. All styling goes in the existing CSS module.

**Tech Stack:** React, CSS Modules, Vitest + React Testing Library, lucide-react (Info icon)

---

### Task 1: Add Tooltip Component and CSS Styles

**Files:**
- Modify: `client/src/components/Quality/CreateEvalForm.jsx:1-3` (imports)
- Modify: `client/src/components/Quality/CreateEvalForm.jsx` (add Tooltip component before EvidenceFields, ~line 33)
- Modify: `client/src/components/Quality/CreateEvalForm.module.css` (add tooltip + hint styles at end)

- [ ] **Step 1: Write the failing test for Tooltip rendering**

Add to `client/src/__tests__/CreateEvalForm.test.jsx` after the existing imports and mocks. First, update the lucide-react mock to include `Info`:

```jsx
vi.mock('lucide-react', () => ({
  ChevronLeft: (props) => React.createElement('span', { 'data-testid': 'icon-chevron-left', ...props }),
  Plus: (props) => React.createElement('span', { 'data-testid': 'icon-plus', ...props }),
  Trash2: (props) => React.createElement('span', { 'data-testid': 'icon-trash', ...props }),
  Info: (props) => React.createElement('span', { 'data-testid': 'icon-info', ...props }),
}));
```

Then add a test:

```jsx
it('shows tooltip text when hovering an info icon', async () => {
  render(<CreateEvalForm {...defaultProps} />);

  // Evidence section should have a tooltip on Max Bytes
  const infoIcons = screen.getAllByTestId('icon-info');
  expect(infoIcons.length).toBeGreaterThan(0);

  // Hover the first info icon
  fireEvent.mouseEnter(infoIcons[0].closest('span[class]') || infoIcons[0].parentElement);

  await waitFor(() => {
    // Check that some tooltip text becomes visible
    const tooltipTexts = document.querySelectorAll('[role="tooltip"]');
    expect(tooltipTexts.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/__tests__/CreateEvalForm.test.jsx`
Expected: FAIL — no info icons found

- [ ] **Step 3: Add Tooltip component and CSS**

In `client/src/components/Quality/CreateEvalForm.jsx`, update the import at line 2:

```jsx
import { ChevronLeft, Plus, Trash2, Info } from 'lucide-react';
```

Add the Tooltip component right after the `JUDGE_MODELS` constant (before the `EvidenceFields` function, around line 32):

```jsx
function Tooltip({ text }) {
  const [show, setShow] = useState(false);
  return (
    <span className={styles.tooltipWrap} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <Info size={13} className={styles.tooltipIcon} />
      {show && <span className={styles.tooltipPopover} role="tooltip">{text}</span>}
    </span>
  );
}
```

In `client/src/components/Quality/CreateEvalForm.module.css`, add at the end:

```css
.sectionHint {
  font-size: 11px;
  color: var(--text-muted);
  margin: -6px 0 8px 0;
  line-height: 1.4;
}

.labelWithTooltip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.tooltipWrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  cursor: help;
}

.tooltipIcon {
  color: var(--text-muted);
  opacity: 0.6;
  transition: opacity 0.15s;
}

.tooltipWrap:hover .tooltipIcon {
  opacity: 1;
}

.tooltipPopover {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
  font-size: 11px;
  color: var(--text-secondary);
  line-height: 1.4;
  white-space: normal;
  width: 240px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
  z-index: 10;
  pointer-events: none;
}

.checkHelpText {
  font-size: 11px;
  color: var(--text-muted);
  margin: -4px 0 8px 0;
  line-height: 1.4;
  font-style: italic;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/__tests__/CreateEvalForm.test.jsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Quality/CreateEvalForm.jsx client/src/components/Quality/CreateEvalForm.module.css client/src/__tests__/CreateEvalForm.test.jsx
git commit -m "feat: add Tooltip component and CSS styles for eval form help text"
```

---

### Task 2: Add Inline Hints and Tooltips to Evidence, Inputs, and LLM Judge Sections

**Files:**
- Modify: `client/src/components/Quality/CreateEvalForm.jsx` (Evidence section ~line 294, Inputs section ~line 299, LLM Judge section ~line 315, EvidenceFields component ~line 33)
- Test: `client/src/__tests__/CreateEvalForm.test.jsx`

- [ ] **Step 1: Write the failing test for section hints**

Add to `client/src/__tests__/CreateEvalForm.test.jsx`:

```jsx
it('shows inline hint text under section titles', () => {
  render(<CreateEvalForm {...defaultProps} />);

  expect(screen.getByText(/how the eval gathers data to check/i)).toBeInTheDocument();
  expect(screen.getByText(/variables passed to your eval at runtime/i)).toBeInTheDocument();
  expect(screen.getByText(/deterministic pass\/fail rules/i)).toBeInTheDocument();
  expect(screen.getByText(/an llm reviews the evidence/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/__tests__/CreateEvalForm.test.jsx`
Expected: FAIL — hint text not found

- [ ] **Step 3: Add inline hints and tooltips to all sections**

In `client/src/components/Quality/CreateEvalForm.jsx`, modify the Evidence section (around line 294-297):

```jsx
<div className={styles.section}>
  <div className={styles.sectionTitle}>Evidence</div>
  <div className={styles.sectionHint}>How the eval gathers data to check. Pick a source and configure how to collect it.</div>
  <EvidenceFields evidence={evidence} onChange={setEvidence} />
</div>
```

Modify the Inputs section (around line 299-302):

```jsx
<div className={styles.section}>
  <div className={styles.sectionTitle}>Inputs</div>
  <div className={styles.sectionHint}>Variables passed to your eval at runtime. Use {'${key}'} in other fields to reference them.</div>
  <InputMapEditor inputMap={inputMap} onChange={setInputMap} />
</div>
```

Modify the Checks section (around line 304-313). Replace the existing `sectionTitleRow` div:

```jsx
<div className={styles.section}>
  <div className={styles.sectionTitleRow}>
    <span className={styles.sectionTitle}>Checks</span>
    <button type="button" className={styles.addBtn} onClick={addCheck}><Plus size={12} /> Add Check</button>
  </div>
  <div className={styles.sectionHint}>Deterministic pass/fail rules applied to the evidence. Each check runs independently.</div>
  {checks.length === 0 && <div className={styles.hint}>No deterministic checks. Add checks or use a judge prompt below.</div>}
  {checks.map((check, i) => (
    <CheckEditor key={i} check={check} onChange={(c) => updateCheck(i, c)} onRemove={() => removeCheck(i)} />
  ))}
</div>
```

Modify the LLM Judge section (around line 315-335):

```jsx
<div className={styles.section}>
  <div className={styles.sectionTitle}>LLM Judge (optional)</div>
  <div className={styles.sectionHint}>An LLM reviews the evidence and decides if the eval passes. Use this for subjective or complex judgments that can't be captured with deterministic checks.</div>
  <div className={styles.field}>
    <label className={styles.label}>
      <span className={styles.labelWithTooltip}>Judge Prompt <Tooltip text="Instructions for the LLM judge. Tell it what to look for in the evidence, what matters, and what should cause a failure." /></span>
    </label>
    <textarea className={styles.textarea} value={judgePrompt} onChange={(e) => setJudgePrompt(e.target.value)} placeholder="Instructions for the LLM judge to evaluate the evidence..." rows={3} />
  </div>
  {judgePrompt.trim() && (
    <>
      <div className={styles.field}>
        <label className={styles.label}>
          <span className={styles.labelWithTooltip}>Expected Outcome * <Tooltip text="Describe what a passing result looks like in plain English. The judge LLM uses this as its success criteria." /></span>
        </label>
        <textarea className={styles.textarea} value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="What does a passing result look like?" rows={2} />
      </div>
      <div className={styles.fieldSmall}>
        <label className={styles.label}>
          <span className={styles.labelWithTooltip}>Judge Model <Tooltip text="Which LLM to use. Default (Sonnet) is a good balance. Fast (Haiku) is cheaper but less capable. Strong (Opus) is the most capable but costs more." /></span>
        </label>
        <select className={styles.select} value={judgeModel} onChange={(e) => setJudgeModel(e.target.value)}>
          {JUDGE_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>
      </div>
    </>
  )}
</div>
```

Now add tooltips inside the `EvidenceFields` component. Update the Max Bytes and Timeout labels (around line 103-112):

```jsx
<div className={styles.fieldRow}>
  <div className={styles.fieldSmall}>
    <label className={styles.label}>
      <span className={styles.labelWithTooltip}>Max Bytes <Tooltip text="The maximum amount of data to read. 50,000 (default) is good for most cases. Increase for large files or logs, decrease if you only need a small snippet." /></span>
    </label>
    <input className={styles.input} type="number" value={evidence.max_bytes || ''} onChange={(e) => update('max_bytes', e.target.value ? parseInt(e.target.value) : undefined)} placeholder="50000" />
  </div>
  <div className={styles.fieldSmall}>
    <label className={styles.label}>
      <span className={styles.labelWithTooltip}>Timeout (ms) <Tooltip text="How long to wait before giving up, in milliseconds. 30,000 (30 seconds) is the default. Increase for slow database queries or large file reads." /></span>
    </label>
    <input className={styles.input} type="number" value={evidence.timeout || ''} onChange={(e) => update('timeout', e.target.value ? parseInt(e.target.value) : undefined)} placeholder="30000" />
  </div>
</div>
```

Also add a tooltip description after the Evidence Type dropdown. After the select element on line 41-44, add a description line that shows when a type is selected. Replace the entire `EvidenceFields` return block starting from line 36 — after the evidence type select (line 44), add:

```jsx
{evidence.type && (
  <div className={styles.checkHelpText}>
    {evidence.type === 'log_query' && 'Searches through logs (session logs, build output, or PR diffs) and optionally filters lines with a regex pattern.'}
    {evidence.type === 'file' && 'Reads the contents of a file at the path you specify.'}
    {evidence.type === 'db_query' && 'Runs a SQL query against your database and returns the results.'}
    {evidence.type === 'sub_agent' && 'Sends a prompt to an LLM to extract or summarize information from a context source.'}
  </div>
)}
```

Insert this right after the closing `</div>` of the `fieldRow` that contains the evidence type select (after line 46), before the type-specific conditional blocks.

Add a tooltip to the Inputs key/value area. In `InputMapEditor`, add after the opening `<div className={styles.subsection}>` (line 198), before the entries map:

```jsx
{entries.length > 0 && (
  <div className={styles.checkHelpText}>The left side is the variable name. The right side is the value — either a literal or a {'${variable}'} reference that gets filled in at runtime.</div>
)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/__tests__/CreateEvalForm.test.jsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Quality/CreateEvalForm.jsx client/src/components/Quality/CreateEvalForm.module.css client/src/__tests__/CreateEvalForm.test.jsx
git commit -m "feat: add inline hints and tooltips to all eval form sections"
```

---

### Task 3: Add Missing Check Types to Dropdown and Config Fields

**Files:**
- Modify: `client/src/components/Quality/CreateEvalForm.jsx:12-19` (CHECK_TYPES array)
- Modify: `client/src/components/Quality/CreateEvalForm.jsx:117-169` (CheckEditor component)
- Test: `client/src/__tests__/CreateEvalForm.test.jsx`

- [ ] **Step 1: Write the failing test for new check types**

Add to `client/src/__tests__/CreateEvalForm.test.jsx`:

```jsx
it('shows all 11 check types in the dropdown', async () => {
  render(<CreateEvalForm {...defaultProps} />);

  fireEvent.click(screen.getByRole('button', { name: /add check/i }));

  await waitFor(() => {
    expect(screen.getByText(/select check type/i)).toBeInTheDocument();
  });

  const checkSelect = screen.getAllByRole('combobox').find(
    el => Array.from(el.options).some(opt => opt.text === 'Not Empty')
  );
  expect(checkSelect).toBeTruthy();

  const optionLabels = Array.from(checkSelect.options).map(o => o.text).filter(t => t !== 'Select check type...');
  expect(optionLabels).toEqual([
    'Not Empty', 'Regex Match', 'JSON Valid', 'JSON Schema', 'HTTP Status', 'Field Exists',
    'Equals', 'Contains', 'Greater Than', 'Less Than', 'Numeric Score',
  ]);
});

it('shows Value and Field Path fields when Equals check is selected', async () => {
  render(<CreateEvalForm {...defaultProps} />);

  fireEvent.click(screen.getByRole('button', { name: /add check/i }));

  await waitFor(() => {
    expect(screen.getByText(/select check type/i)).toBeInTheDocument();
  });

  const checkSelect = screen.getAllByRole('combobox').find(
    el => Array.from(el.options).some(opt => opt.text === 'Not Empty')
  );
  fireEvent.change(checkSelect, { target: { value: 'equals' } });

  await waitFor(() => {
    expect(screen.getByText('Value *')).toBeInTheDocument();
    expect(screen.getByText('Field Path')).toBeInTheDocument();
  });
});

it('shows Min, Max, and Field Path fields when Numeric Score check is selected', async () => {
  render(<CreateEvalForm {...defaultProps} />);

  fireEvent.click(screen.getByRole('button', { name: /add check/i }));

  await waitFor(() => {
    expect(screen.getByText(/select check type/i)).toBeInTheDocument();
  });

  const checkSelect = screen.getAllByRole('combobox').find(
    el => Array.from(el.options).some(opt => opt.text === 'Not Empty')
  );
  fireEvent.change(checkSelect, { target: { value: 'numeric_score' } });

  await waitFor(() => {
    expect(screen.getByText('Min')).toBeInTheDocument();
    expect(screen.getByText('Max')).toBeInTheDocument();
    expect(screen.getByText('Field Path')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/__tests__/CreateEvalForm.test.jsx`
Expected: FAIL — "Equals" not found in options

- [ ] **Step 3: Add the 5 missing check types to the CHECK_TYPES array**

In `client/src/components/Quality/CreateEvalForm.jsx`, replace the CHECK_TYPES constant (lines 12-19):

```jsx
const CHECK_TYPES = [
  { value: 'not_empty', label: 'Not Empty' },
  { value: 'regex_match', label: 'Regex Match' },
  { value: 'json_valid', label: 'JSON Valid' },
  { value: 'json_schema', label: 'JSON Schema' },
  { value: 'http_status', label: 'HTTP Status' },
  { value: 'field_exists', label: 'Field Exists' },
  { value: 'equals', label: 'Equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'greater_than', label: 'Greater Than' },
  { value: 'less_than', label: 'Less Than' },
  { value: 'numeric_score', label: 'Numeric Score' },
];
```

- [ ] **Step 4: Add config field rendering for new check types in CheckEditor**

In the `CheckEditor` component, after the `json_schema` conditional block (after line 166), add:

```jsx
{(check.type === 'equals' || check.type === 'contains' || check.type === 'greater_than' || check.type === 'less_than') && (
  <>
    <div className={styles.fieldRow}>
      <div className={styles.field}>
        <label className={styles.label}>Value *</label>
        <input
          className={styles.input}
          type={check.type === 'greater_than' || check.type === 'less_than' ? 'number' : 'text'}
          value={check.value || ''}
          onChange={(e) => update('value', e.target.value)}
          placeholder={check.type === 'greater_than' || check.type === 'less_than' ? 'e.g. 0.8' : 'expected value'}
        />
      </div>
      <div className={styles.field}>
        <label className={styles.label}>
          <span className={styles.labelWithTooltip}>Field Path <Tooltip text="Optional. If your evidence is JSON, use dot notation to extract a specific value before comparing (e.g. data.score). Leave empty to compare against the full evidence text." /></span>
        </label>
        <input className={styles.input} value={check.field || ''} onChange={(e) => update('field', e.target.value)} placeholder="e.g. data.score" />
      </div>
    </div>
  </>
)}

{check.type === 'numeric_score' && (
  <>
    <div className={styles.fieldRow}>
      <div className={styles.fieldSmall}>
        <label className={styles.label}>Min</label>
        <input className={styles.input} type="number" value={check.min ?? ''} onChange={(e) => update('min', e.target.value === '' ? undefined : parseFloat(e.target.value))} placeholder="e.g. 0" />
      </div>
      <div className={styles.fieldSmall}>
        <label className={styles.label}>Max</label>
        <input className={styles.input} type="number" value={check.max ?? ''} onChange={(e) => update('max', e.target.value === '' ? undefined : parseFloat(e.target.value))} placeholder="e.g. 1" />
      </div>
      <div className={styles.field}>
        <label className={styles.label}>
          <span className={styles.labelWithTooltip}>Field Path <Tooltip text="Optional. If your evidence is JSON, use dot notation to extract a specific value before comparing (e.g. data.score). Leave empty to compare against the full evidence text." /></span>
        </label>
        <input className={styles.input} value={check.field || ''} onChange={(e) => update('field', e.target.value)} placeholder="e.g. data.score" />
      </div>
    </div>
  </>
)}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd client && npx vitest run src/__tests__/CreateEvalForm.test.jsx`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add client/src/components/Quality/CreateEvalForm.jsx client/src/__tests__/CreateEvalForm.test.jsx
git commit -m "feat: add equals, contains, greater_than, less_than, numeric_score check types to eval form"
```

---

### Task 4: Add Per-Check-Type Help Text

**Files:**
- Modify: `client/src/components/Quality/CreateEvalForm.jsx` (CheckEditor component)
- Test: `client/src/__tests__/CreateEvalForm.test.jsx`

- [ ] **Step 1: Write the failing test for check type help text**

Add to `client/src/__tests__/CreateEvalForm.test.jsx`:

```jsx
it('shows help text when a check type is selected', async () => {
  render(<CreateEvalForm {...defaultProps} />);

  fireEvent.click(screen.getByRole('button', { name: /add check/i }));

  const checkSelect = screen.getAllByRole('combobox').find(
    el => Array.from(el.options).some(opt => opt.text === 'Not Empty')
  );
  fireEvent.change(checkSelect, { target: { value: 'not_empty' } });

  await waitFor(() => {
    expect(screen.getByText(/passes if the evidence contains any non-whitespace content/i)).toBeInTheDocument();
  });
});

it('shows grouped help text for comparison check types', async () => {
  render(<CreateEvalForm {...defaultProps} />);

  fireEvent.click(screen.getByRole('button', { name: /add check/i }));

  const checkSelect = screen.getAllByRole('combobox').find(
    el => Array.from(el.options).some(opt => opt.text === 'Not Empty')
  );
  fireEvent.change(checkSelect, { target: { value: 'equals' } });

  await waitFor(() => {
    expect(screen.getByText(/compares the evidence/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd client && npx vitest run src/__tests__/CreateEvalForm.test.jsx`
Expected: FAIL — help text not found

- [ ] **Step 3: Add a CHECK_HELP_TEXT map and render it in CheckEditor**

In `client/src/components/Quality/CreateEvalForm.jsx`, add a constant after the `CHECK_TYPES` array:

```jsx
const CHECK_HELP_TEXT = {
  not_empty: 'Passes if the evidence contains any non-whitespace content.',
  regex_match: 'Passes if the evidence matches the regular expression pattern you provide.',
  json_valid: 'Passes if the evidence is valid JSON.',
  json_schema: 'Passes if the evidence is valid JSON that conforms to the schema file you specify.',
  http_status: 'Passes if the evidence contains the HTTP status code you specify.',
  field_exists: 'Passes if the specified field path exists in the JSON evidence. Use dot notation for nested fields (e.g. data.user.id).',
  equals: 'Compares the evidence (or a field extracted from JSON evidence) against the value you provide. Equals checks for an exact match, Contains checks for a substring, Greater/Less Than compare numerically.',
  contains: 'Compares the evidence (or a field extracted from JSON evidence) against the value you provide. Equals checks for an exact match, Contains checks for a substring, Greater/Less Than compare numerically.',
  greater_than: 'Compares the evidence (or a field extracted from JSON evidence) against the value you provide. Equals checks for an exact match, Contains checks for a substring, Greater/Less Than compare numerically.',
  less_than: 'Compares the evidence (or a field extracted from JSON evidence) against the value you provide. Equals checks for an exact match, Contains checks for a substring, Greater/Less Than compare numerically.',
  numeric_score: 'Checks that a numeric value falls within a range. Set a min, max, or both. Useful for scoring responses on a scale.',
};
```

In the `CheckEditor` component, add the help text right after the `checkHeader` div (after line 128), before the Description field:

```jsx
{check.type && CHECK_HELP_TEXT[check.type] && (
  <div className={styles.checkHelpText}>{CHECK_HELP_TEXT[check.type]}</div>
)}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd client && npx vitest run src/__tests__/CreateEvalForm.test.jsx`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add client/src/components/Quality/CreateEvalForm.jsx client/src/__tests__/CreateEvalForm.test.jsx
git commit -m "feat: add per-check-type help text in eval form"
```

---

### Task 5: Run Full Test Suite and Visual Verification

**Files:**
- No new changes expected — this is a verification task

- [ ] **Step 1: Run the full test suite**

Run: `cd client && npx vitest run`
Expected: All tests PASS

- [ ] **Step 2: Fix any failures**

If any tests fail, fix them before proceeding.

- [ ] **Step 3: Start the dev server and verify visually**

Run: check `.env` for PORT, then start the dev server. Open the app in a browser, navigate to the Quality tab, open a folder, click "Create Eval", and verify:

1. All 11 check types appear in the Checks dropdown
2. Selecting each check type shows its help text and appropriate config fields
3. Inline hints appear under Evidence, Inputs, Checks, and LLM Judge section titles
4. Info icon tooltips appear on hover for Max Bytes, Timeout, Judge Prompt, Expected Outcome, Judge Model, and Field Path fields
5. Evidence type description shows when a type is selected
6. Expected Outcome field appears when Judge Prompt has text
7. Input key/value help text appears when inputs exist
8. The form submits successfully with the new check types

- [ ] **Step 4: Commit any fixes**

If visual testing revealed issues, fix and commit:

```bash
git add -A
git commit -m "fix: polish eval form help text and check type rendering"
```

---

### Task 6: Create Pull Request

- [ ] **Step 1: Push branch and create PR**

```bash
git push -u origin worktree-jaunty-giggling-backus
gh pr create --title "feat: add missing check types and help text to eval form" --body "$(cat <<'EOF'
## Summary
- Adds 5 missing check types to the eval creation form dropdown: Equals, Contains, Greater Than, Less Than, Numeric Score
- Adds explanation text throughout the form — inline hints under section titles and hover tooltips for fields that need more context
- Surfaces the Expected Outcome field in the LLM Judge section (required by backend when judge prompt is provided)

## Test plan
- [ ] All 11 check types appear in dropdown and show correct config fields
- [ ] Inline hints visible under Evidence, Inputs, Checks, and LLM Judge sections
- [ ] Tooltips appear on hover for Max Bytes, Timeout, Judge Prompt, Expected Outcome, Judge Model, Field Path
- [ ] Evidence type description shows when type is selected
- [ ] Expected Outcome field appears/hides based on Judge Prompt content
- [ ] Form submits successfully with new check types
- [ ] All existing tests pass plus new tests

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
