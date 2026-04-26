'use strict';

const FIELDS = ['Question', 'Context', 'Recommendation', 'Reason for escalation'];
const FIELD_KEYS = {
  Question: 'question',
  Context: 'context',
  Recommendation: 'recommendation',
  'Reason for escalation': 'reason',
};

function parseEscalation(text) {
  if (!text || typeof text !== 'string') return null;
  const idx = text.indexOf('ESCALATE');
  if (idx === -1) return null;

  // Allow ESCALATE only at start-of-string or start-of-line.
  const before = text.slice(0, idx);
  if (before.length > 0 && !/\n\s*$/.test(before)) return null;

  const body = text.slice(idx + 'ESCALATE'.length).replace(/^\s*\n/, '');
  const parsed = {};

  for (let i = 0; i < FIELDS.length; i++) {
    const fieldName = FIELDS[i];
    const re = new RegExp(`(^|\\n)\\s*${escapeRe(fieldName)}:\\s*`);
    const match = body.match(re);
    if (!match) return null;
    const start = match.index + match[0].length;
    let end = body.length;
    for (let j = i + 1; j < FIELDS.length; j++) {
      const nextRe = new RegExp(`\\n\\s*${escapeRe(FIELDS[j])}:\\s*`);
      const nm = body.slice(start).match(nextRe);
      if (nm) { end = start + nm.index; break; }
    }
    parsed[FIELD_KEYS[fieldName]] = body.slice(start, end).trim();
  }

  if (!parsed.question || !parsed.recommendation || !parsed.reason) return null;
  return parsed;
}

function escapeRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { parseEscalation };
