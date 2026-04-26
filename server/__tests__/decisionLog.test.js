import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  formatDecisionEntry,
  appendDecision,
  parseDecisions,
  summarizeQuestion,
  resolveDecisionFilePath,
  DEFAULT_DECISIONS_PATH,
} from '../services/decisionLog.js';

describe('decisionLog format', () => {
  it('produces an entry with all required delimiters', () => {
    const entry = formatDecisionEntry({
      timestamp: '2026-04-24T15:00:00Z',
      askingSessionId: 'sess-impl-1',
      planningSessionId: 'sess-plan-1',
      workingFiles: ['src/server.js', 'src/routes/api.js'],
      projectName: 'Mission Control',
      question: 'Should pagination use cursor or offset?',
      answer: 'Cursor — offset performance degrades over large tables.',
    });
    expect(entry).toContain('## Decision: Should pagination use cursor or offset?');
    expect(entry).toContain('- **Timestamp:** 2026-04-24T15:00:00Z');
    expect(entry).toContain('- **Asking session:** sess-impl-1');
    expect(entry).toContain('- **Planning session:** sess-plan-1');
    expect(entry).toContain('- **Working files:** src/server.js, src/routes/api.js');
    expect(entry).toContain('- **Project:** Mission Control');
    expect(entry).toContain('### Question');
    expect(entry).toContain('### Answer');
    expect(entry).toContain('\n---\n');
  });

  it('renders "none" when working files are empty', () => {
    const entry = formatDecisionEntry({
      timestamp: '2026-04-24T15:00:00Z',
      askingSessionId: 'a',
      planningSessionId: 'b',
      workingFiles: [],
      projectName: 'p',
      question: 'q',
      answer: 'a',
    });
    expect(entry).toContain('- **Working files:** none');
  });

  it('truncates long question summaries to a single line', () => {
    const summary = summarizeQuestion('Line one of a very long question that goes on\nLine two ignored');
    expect(summary.startsWith('Line one of a very long question')).toBe(true);
    expect(summary.includes('\n')).toBe(false);
  });

  it('falls back when answer is missing', () => {
    const entry = formatDecisionEntry({
      timestamp: '2026-04-24T15:00:00Z',
      askingSessionId: 'a',
      planningSessionId: 'b',
      workingFiles: 'none',
      projectName: 'p',
      question: 'q',
      answer: '',
    });
    expect(entry).toContain('_(no answer recorded)_');
  });
});

describe('decisionLog round-trip parse', () => {
  it('parses a single entry written by formatDecisionEntry', () => {
    const original = {
      timestamp: '2026-04-24T15:00:00Z',
      askingSessionId: 'sess-impl-1',
      planningSessionId: 'sess-plan-1',
      workingFiles: ['src/foo.js'],
      projectName: 'TestProject',
      question: 'How should we handle race conditions in evictions?',
      answer: 'Use a single-writer lock keyed by tenant ID. Multi-writer caused inconsistencies in load tests.',
    };
    const block = formatDecisionEntry(original);
    const [parsed] = parseDecisions(block);
    expect(parsed.timestamp).toBe(original.timestamp);
    expect(parsed.askingSessionId).toBe(original.askingSessionId);
    expect(parsed.planningSessionId).toBe(original.planningSessionId);
    expect(parsed.workingFiles).toEqual(['src/foo.js']);
    expect(parsed.projectName).toBe('TestProject');
    expect(parsed.question).toBe(original.question);
    expect(parsed.answer).toBe(original.answer);
  });

  it('parses multiple appended entries from one file', () => {
    const e1 = formatDecisionEntry({
      timestamp: '2026-04-24T10:00:00Z', askingSessionId: 'a1', planningSessionId: 'p1',
      workingFiles: [], projectName: 'X', question: 'Q1', answer: 'A1',
    });
    const e2 = formatDecisionEntry({
      timestamp: '2026-04-24T11:00:00Z', askingSessionId: 'a2', planningSessionId: 'p2',
      workingFiles: ['a.js'], projectName: 'X', question: 'Q2', answer: 'A2',
    });
    const file = '# Project Decisions\n\n' + e1 + '\n' + e2;
    const parsed = parseDecisions(file);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].question).toBe('Q1');
    expect(parsed[1].question).toBe('Q2');
    expect(parsed[1].workingFiles).toEqual(['a.js']);
  });
});

describe('decisionLog appendDecision', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates the file with header on first append', async () => {
    const target = path.join(tmpDir, 'docs', 'decisions.md');
    const result = await appendDecision(target, {
      timestamp: '2026-04-24T15:00:00Z',
      askingSessionId: 's1', planningSessionId: 's2',
      workingFiles: [], projectName: 'P',
      question: 'q', answer: 'a',
    });
    expect(result.created).toBe(true);
    const content = fs.readFileSync(target, 'utf8');
    expect(content.startsWith('# Project Decisions')).toBe(true);
    expect(content).toContain('## Decision: q');
  });

  it('appends without reformatting existing entries', async () => {
    const target = path.join(tmpDir, 'decisions.md');
    await appendDecision(target, {
      timestamp: '2026-04-24T10:00:00Z', askingSessionId: 'a1', planningSessionId: 'p1',
      workingFiles: [], projectName: 'P', question: 'Q1', answer: 'A1',
    });
    await appendDecision(target, {
      timestamp: '2026-04-24T11:00:00Z', askingSessionId: 'a2', planningSessionId: 'p2',
      workingFiles: ['a.js'], projectName: 'P', question: 'Q2', answer: 'A2',
    });
    const content = fs.readFileSync(target, 'utf8');
    const parsed = parseDecisions(content);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].timestamp).toBe('2026-04-24T10:00:00Z');
    expect(parsed[1].timestamp).toBe('2026-04-24T11:00:00Z');
  });
});

describe('decisionLog decidedBy', () => {
  it('formats a planning-agent decision with the right label', () => {
    const block = formatDecisionEntry({
      timestamp: '2026-04-25T00:00:00Z',
      askingSessionId: 'a1', planningSessionId: 'p1',
      workingFiles: ['x.js'], projectName: 'Demo',
      question: 'Q?', answer: 'A.',
      decidedBy: 'planning-agent',
    });
    expect(block).toContain('**Decided by:** Planning agent');
  });

  it('formats an owner decision with the right label', () => {
    const block = formatDecisionEntry({
      timestamp: '2026-04-25T00:00:00Z',
      askingSessionId: 'a1', planningSessionId: 'p1',
      workingFiles: ['x.js'], projectName: 'Demo',
      question: 'Q?', answer: 'A.',
      decidedBy: 'owner',
    });
    expect(block).toContain('**Decided by:** Owner');
  });

  it('round-trips decidedBy through parseDecisions', () => {
    const block = formatDecisionEntry({
      timestamp: '2026-04-25T00:00:00Z',
      askingSessionId: 'a1', planningSessionId: 'p1',
      workingFiles: ['x.js'], projectName: 'Demo',
      question: 'Q?', answer: 'A.',
      decidedBy: 'owner',
    });
    const parsed = parseDecisions(block);
    expect(parsed[0].decidedBy).toBe('Owner');
  });
});

describe('resolveDecisionFilePath', () => {
  it('joins relative paths against the project root', () => {
    const p = resolveDecisionFilePath('/tmp/proj', null);
    expect(p).toBe('/tmp/proj/' + DEFAULT_DECISIONS_PATH);
  });

  it('returns absolute paths unchanged', () => {
    const p = resolveDecisionFilePath('/tmp/proj', '/var/log/decisions.md');
    expect(p).toBe('/var/log/decisions.md');
  });
});
