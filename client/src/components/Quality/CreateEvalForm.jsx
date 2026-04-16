import React, { useState } from 'react';
import { ChevronLeft, Plus, Trash2, Info } from 'lucide-react';
import styles from './CreateEvalForm.module.css';

const EVIDENCE_TYPES = [
  { value: 'log_query', label: 'Log Query' },
  { value: 'file', label: 'File' },
  { value: 'db_query', label: 'Database Query' },
  { value: 'sub_agent', label: 'Sub-Agent' },
];

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

const LOG_SOURCES = [
  { value: 'session_log', label: 'Session Log' },
  { value: 'build_output', label: 'Build Output' },
  { value: 'pr_diff', label: 'PR Diff' },
];

const JUDGE_MODELS = [
  { value: '', label: 'Default (Sonnet)' },
  { value: 'fast', label: 'Fast (Haiku)' },
  { value: 'strong', label: 'Strong (Opus)' },
];

let tooltipCounter = 0;
function Tooltip({ text }) {
  const [show, setShow] = useState(false);
  const [id] = useState(() => `tooltip-${++tooltipCounter}`);
  return (
    <span className={styles.tooltipWrap} onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)} aria-describedby={show ? id : undefined}>
      <Info size={13} className={styles.tooltipIcon} />
      {show && <span id={id} className={styles.tooltipPopover} role="tooltip">{text}</span>}
    </span>
  );
}

function EvidenceFields({ evidence, onChange }) {
  const update = (field, value) => onChange({ ...evidence, [field]: value });

  return (
    <div className={styles.subsection}>
      <div className={styles.fieldRow}>
        <div className={styles.field}>
          <label className={styles.label}>Evidence Type *</label>
          <select className={styles.select} value={evidence.type || ''} onChange={(e) => onChange({ type: e.target.value })}>
            <option value="">Select type...</option>
            {EVIDENCE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
      </div>

      {evidence.type && (
        <div className={styles.checkHelpText}>
          {evidence.type === 'log_query' && 'Searches through logs (session logs, build output, or PR diffs) and optionally filters lines with a regex pattern.'}
          {evidence.type === 'file' && 'Reads the contents of a file at the path you specify.'}
          {evidence.type === 'db_query' && 'Runs a SQL query against your database and returns the results.'}
          {evidence.type === 'sub_agent' && 'Sends a prompt to an LLM to extract or summarize information from a context source.'}
        </div>
      )}

      {evidence.type === 'log_query' && (
        <>
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label}>Source</label>
              <select className={styles.select} value={evidence.source || ''} onChange={(e) => update('source', e.target.value)}>
                <option value="">Custom path...</option>
                {LOG_SOURCES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
              </select>
            </div>
          </div>
          {!LOG_SOURCES.some(s => s.value === evidence.source) && evidence.source !== undefined && (
            <div className={styles.field}>
              <label className={styles.label}>Custom Source Path</label>
              <input className={styles.input} value={evidence.source || ''} onChange={(e) => update('source', e.target.value)} placeholder="path/to/log" />
            </div>
          )}
          <div className={styles.fieldRow}>
            <div className={styles.field}>
              <label className={styles.label}>Filter (regex)</label>
              <input className={styles.input} value={evidence.filter || ''} onChange={(e) => update('filter', e.target.value)} placeholder="e.g. ERROR|WARN" />
            </div>
          </div>
        </>
      )}

      {evidence.type === 'file' && (
        <div className={styles.field}>
          <label className={styles.label}>File Path *</label>
          <input className={styles.input} value={evidence.path || ''} onChange={(e) => update('path', e.target.value)} placeholder="relative/path/to/file" />
        </div>
      )}

      {evidence.type === 'db_query' && (
        <>
          <div className={styles.field}>
            <label className={styles.label}>SQL Query *</label>
            <textarea className={styles.textarea} value={evidence.query || ''} onChange={(e) => update('query', e.target.value)} placeholder="SELECT ... FROM ... WHERE ..." rows={3} />
          </div>
        </>
      )}

      {evidence.type === 'sub_agent' && (
        <>
          <div className={styles.field}>
            <label className={styles.label}>Extraction Prompt *</label>
            <textarea className={styles.textarea} value={evidence.extraction_prompt || ''} onChange={(e) => update('extraction_prompt', e.target.value)} placeholder="Describe what the sub-agent should extract..." rows={3} />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Context Source</label>
            <input className={styles.input} value={evidence.context_source || ''} onChange={(e) => update('context_source', e.target.value)} placeholder="e.g. session_log or path/to/file" />
          </div>
        </>
      )}

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
    </div>
  );
}

function CheckEditor({ check, onChange, onRemove }) {
  const update = (field, value) => onChange({ ...check, [field]: value });

  return (
    <div className={styles.checkCard}>
      <div className={styles.checkHeader}>
        <select className={styles.select} value={check.type || ''} onChange={(e) => onChange({ type: e.target.value })}>
          <option value="">Select check type...</option>
          {CHECK_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        <button className={styles.removeBtn} onClick={onRemove} title="Remove check" type="button"><Trash2 size={14} /></button>
      </div>
      {check.type && CHECK_HELP_TEXT[check.type] && (
        <div className={styles.checkHelpText}>{CHECK_HELP_TEXT[check.type]}</div>
      )}
      <div className={styles.field}>
        <label className={styles.label}>Description</label>
        <input className={styles.input} value={check.description || ''} onChange={(e) => update('description', e.target.value)} placeholder="What does this check verify?" />
      </div>

      {check.type === 'regex_match' && (
        <div className={styles.fieldRow}>
          <div className={styles.field}>
            <label className={styles.label}>Pattern *</label>
            <input className={styles.input} value={check.pattern || ''} onChange={(e) => update('pattern', e.target.value)} placeholder="e.g. status.*200" />
          </div>
          <div className={styles.fieldSmall}>
            <label className={styles.label}>Flags</label>
            <input className={styles.input} value={check.flags || ''} onChange={(e) => update('flags', e.target.value)} placeholder="gm" />
          </div>
        </div>
      )}

      {check.type === 'http_status' && (
        <div className={styles.fieldSmall}>
          <label className={styles.label}>Status Code *</label>
          <input className={styles.input} value={check.status || ''} onChange={(e) => update('status', e.target.value)} placeholder="200" />
        </div>
      )}

      {check.type === 'field_exists' && (
        <div className={styles.field}>
          <label className={styles.label}>Field Path *</label>
          <input className={styles.input} value={check.field || ''} onChange={(e) => update('field', e.target.value)} placeholder="data.user.id" />
        </div>
      )}

      {check.type === 'json_schema' && (
        <div className={styles.field}>
          <label className={styles.label}>Schema Path *</label>
          <input className={styles.input} value={check.schema || ''} onChange={(e) => update('schema', e.target.value)} placeholder="schemas/response.json" />
        </div>
      )}

      {(check.type === 'equals' || check.type === 'contains' || check.type === 'greater_than' || check.type === 'less_than') && (
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
      )}

      {check.type === 'numeric_score' && (
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
      )}
    </div>
  );
}

function InputMapEditor({ inputMap, onChange }) {
  const entries = Object.entries(inputMap);

  const addEntry = () => {
    const key = `key_${entries.length + 1}`;
    onChange({ ...inputMap, [key]: '' });
  };

  const removeEntry = (key) => {
    const next = { ...inputMap };
    delete next[key];
    onChange(next);
  };

  const updateKey = (oldKey, newKey) => {
    const next = {};
    for (const [k, v] of Object.entries(inputMap)) {
      next[k === oldKey ? newKey : k] = v;
    }
    onChange(next);
  };

  const updateValue = (key, value) => {
    onChange({ ...inputMap, [key]: value });
  };

  return (
    <div className={styles.subsection}>
      {entries.length > 0 && (
        <div className={styles.checkHelpText}>The left side is the variable name. The right side is the value — either a literal or a {'${variable}'} reference that gets filled in at runtime.</div>
      )}
      {entries.map(([key, value], i) => (
        <div key={i} className={styles.kvRow}>
          <input className={styles.kvKey} value={key} onChange={(e) => updateKey(key, e.target.value)} placeholder="key" />
          <input className={styles.kvValue} value={value} onChange={(e) => updateValue(key, e.target.value)} placeholder="value or ${variable}" />
          <button className={styles.removeBtn} onClick={() => removeEntry(key)} title="Remove" type="button"><Trash2 size={12} /></button>
        </div>
      ))}
      <button className={styles.addBtn} onClick={addEntry} type="button">
        <Plus size={12} /> Add Input
      </button>
    </div>
  );
}

export default function CreateEvalForm({ folderPath, folderName, onClose, onCreate }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [evidence, setEvidence] = useState({ type: '' });
  const [inputMap, setInputMap] = useState({ key: '' });
  const [checks, setChecks] = useState([]);
  const [judgePrompt, setJudgePrompt] = useState('');
  const [expected, setExpected] = useState('');
  const [judgeModel, setJudgeModel] = useState('');
  const [error, setError] = useState(null);
  const [creating, setCreating] = useState(false);

  const addCheck = () => setChecks([...checks, { type: '' }]);
  const updateCheck = (i, updated) => setChecks(checks.map((c, j) => j === i ? updated : c));
  const removeCheck = (i) => setChecks(checks.filter((_, j) => j !== i));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) return setError('Name is required');
    if (!description.trim()) return setError('Description is required');
    if (!evidence.type) return setError('Evidence type is required');
    if (Object.keys(inputMap).length === 0) return setError('At least one input is required');
    if (checks.length === 0 && !judgePrompt.trim()) return setError('Add at least one check or a judge prompt');
    if (judgePrompt.trim() && !expected.trim()) return setError('Expected outcome is required when using a judge prompt');

    for (const check of checks) {
      if (['equals', 'contains', 'greater_than', 'less_than'].includes(check.type) && !check.value && check.value !== 0) {
        return setError(`Value is required for ${check.type.replace(/_/g, ' ')} checks`);
      }
      if (check.type === 'numeric_score' && (check.min == null || check.min === '') && (check.max == null || check.max === '')) {
        return setError('At least one of Min or Max is required for numeric score checks');
      }
    }

    const cleanInput = {};
    for (const [k, v] of Object.entries(inputMap)) {
      if (k.trim()) cleanInput[k.trim()] = v;
    }
    if (Object.keys(cleanInput).length === 0) return setError('At least one input with a key is required');

    const evalDef = {
      folder_path: folderPath,
      name: name.trim(),
      description: description.trim(),
      evidence: cleanEvidence(evidence),
      input: cleanInput,
    };

    if (checks.length > 0) {
      evalDef.checks = checks.map(cleanCheck).filter(c => c.type);
    }
    if (judgePrompt.trim()) {
      evalDef.judge_prompt = judgePrompt.trim();
      evalDef.expected = expected.trim();
      if (judgeModel) evalDef.judge = { model: judgeModel };
    }

    setCreating(true);
    try {
      await onCreate(evalDef);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to create eval');
    }
    setCreating(false);
  };

  return (
    <div className={styles.container}>
      <button className={styles.backButton} onClick={onClose} type="button">
        <ChevronLeft size={14} />
        Back to folders
      </button>
      <h3 className={styles.heading}>New Eval in <span className={styles.folderRef}>{folderName}</span></h3>

      <form onSubmit={handleSubmit} className={styles.form}>
        <div className={styles.section}>
          <div className={styles.sectionTitle}>Basic Info</div>
          <div className={styles.field}>
            <label className={styles.label}>Name *</label>
            <input className={styles.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. api_response_valid" />
          </div>
          <div className={styles.field}>
            <label className={styles.label}>Description *</label>
            <input className={styles.input} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does this eval check?" />
          </div>
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Evidence</div>
          <div className={styles.sectionHint}>How the eval gathers data to check. Pick a source and configure how to collect it.</div>
          <EvidenceFields evidence={evidence} onChange={setEvidence} />
        </div>

        <div className={styles.section}>
          <div className={styles.sectionTitle}>Inputs</div>
          <div className={styles.sectionHint}>Variables passed to your eval at runtime. Use {'${key}'} in other fields to reference them.</div>
          <InputMapEditor inputMap={inputMap} onChange={setInputMap} />
        </div>

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

        <div className={styles.section}>
          <div className={styles.sectionTitle}>LLM Judge (optional)</div>
          <div className={styles.sectionHint}>An LLM reviews the evidence and decides if the eval passes. Use this for subjective or complex judgments that can't be captured with deterministic checks.</div>
          <div className={styles.field}>
            <label className={styles.label}><span className={styles.labelWithTooltip}>Judge Prompt <Tooltip text="Instructions for the LLM judge. Tell it what to look for in the evidence, what matters, and what should cause a failure." /></span></label>
            <textarea className={styles.textarea} value={judgePrompt} onChange={(e) => setJudgePrompt(e.target.value)} placeholder="Instructions for the LLM judge to evaluate the evidence..." rows={3} />
          </div>
          {judgePrompt.trim() && (
            <>
              <div className={styles.field}>
                <label className={styles.label}><span className={styles.labelWithTooltip}>Expected Outcome * <Tooltip text="Describe what a passing result looks like in plain English. The judge LLM uses this as its success criteria." /></span></label>
                <textarea className={styles.textarea} value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="What does a passing result look like?" rows={2} />
              </div>
              <div className={styles.fieldSmall}>
                <label className={styles.label}><span className={styles.labelWithTooltip}>Judge Model <Tooltip text="Which LLM to use. Default (Sonnet) is a good balance. Fast (Haiku) is cheaper but less capable. Strong (Opus) is the most capable but costs more." /></span></label>
                <select className={styles.select} value={judgeModel} onChange={(e) => setJudgeModel(e.target.value)}>
                  {JUDGE_MODELS.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
              </div>
            </>
          )}
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onClose}>Cancel</button>
          <button type="submit" className={styles.createBtn} disabled={creating}>
            {creating ? 'Creating...' : 'Create Eval'}
          </button>
        </div>
      </form>
    </div>
  );
}

function cleanEvidence(ev) {
  const cleaned = {};
  for (const [k, v] of Object.entries(ev)) {
    if (v !== undefined && v !== '' && v !== null) cleaned[k] = v;
  }
  return cleaned;
}

function cleanCheck(check) {
  const cleaned = {};
  for (const [k, v] of Object.entries(check)) {
    if (v !== undefined && v !== '' && v !== null) cleaned[k] = v;
  }
  return cleaned;
}
