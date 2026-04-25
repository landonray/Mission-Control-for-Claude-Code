const fs = require('fs');
const path = require('path');

const DEFAULT_DECISIONS_PATH = 'docs/decisions.md';

const FILE_HEADER = `# Project Decisions

Append-only log of product and architectural decisions captured by Mission Control planning sessions. Each entry follows a strict markdown format so the context-document roll-up can parse it deterministically — please do not reformat existing entries when editing.

`;

function summarizeQuestion(question) {
  if (!question) return 'Untitled decision';
  const firstLine = String(question).trim().split(/\r?\n/)[0] || '';
  const cleaned = firstLine.replace(/[`*_#]/g, '').trim();
  if (cleaned.length === 0) return 'Untitled decision';
  if (cleaned.length <= 100) return cleaned;
  return cleaned.slice(0, 97).trimEnd() + '...';
}

function escapeForBlock(text) {
  if (text == null) return '';
  return String(text).replace(/\r\n/g, '\n').trimEnd();
}

function formatWorkingFiles(files) {
  if (!files) return 'none';
  if (Array.isArray(files)) {
    if (files.length === 0) return 'none';
    return files.map(f => String(f).trim()).filter(Boolean).join(', ') || 'none';
  }
  const trimmed = String(files).trim();
  return trimmed || 'none';
}

function formatDecisionEntry(entry) {
  const summary = summarizeQuestion(entry.summary || entry.question);
  const timestamp = entry.timestamp || new Date().toISOString();
  const askingSession = entry.askingSessionId || 'unknown';
  const planningSession = entry.planningSessionId || 'unknown';
  const workingFiles = formatWorkingFiles(entry.workingFiles);
  const project = entry.projectName || entry.project || 'unknown';
  const question = escapeForBlock(entry.question);
  const answer = escapeForBlock(entry.answer) || '_(no answer recorded)_';

  return [
    `## Decision: ${summary}`,
    '',
    `- **Timestamp:** ${timestamp}`,
    `- **Asking session:** ${askingSession}`,
    `- **Planning session:** ${planningSession}`,
    `- **Working files:** ${workingFiles}`,
    `- **Project:** ${project}`,
    '',
    '### Question',
    '',
    question,
    '',
    '### Answer',
    '',
    answer,
    '',
    '---',
    ''
  ].join('\n');
}

function resolveDecisionFilePath(projectRoot, configuredPath) {
  const rel = configuredPath || DEFAULT_DECISIONS_PATH;
  if (path.isAbsolute(rel)) return rel;
  return path.join(projectRoot, rel);
}

async function appendDecision(filePath, entry) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });

  const exists = fs.existsSync(filePath);
  const block = formatDecisionEntry(entry);

  if (!exists) {
    await fs.promises.writeFile(filePath, FILE_HEADER + block, 'utf8');
    return { created: true, path: filePath };
  }

  const current = await fs.promises.readFile(filePath, 'utf8');
  const separator = current.endsWith('\n') ? '' : '\n';
  await fs.promises.appendFile(filePath, separator + block, 'utf8');
  return { created: false, path: filePath };
}

function parseDecisions(content) {
  if (!content) return [];
  const text = String(content).replace(/\r\n/g, '\n');

  // Split at the "## Decision: " marker. Any content before the first marker
  // (file header, prose) is discarded.
  const parts = text.split(/^## Decision: /m);
  const entries = [];
  for (let i = 1; i < parts.length; i++) {
    const chunk = parts[i];
    const newlineIdx = chunk.indexOf('\n');
    const summary = (newlineIdx === -1 ? chunk : chunk.slice(0, newlineIdx)).trim();
    const body = newlineIdx === -1 ? '' : chunk.slice(newlineIdx + 1);
    entries.push(parseEntryBody(summary, body));
  }
  return entries;
}

function parseEntryBody(summary, rawBody) {
  // Strip the trailing "---" terminator (and any surrounding whitespace)
  // so the answer extraction sees a clean tail.
  const body = rawBody.replace(/\n---\s*\n*$/, '\n').trimEnd();

  const meta = {
    summary,
    timestamp: null,
    askingSessionId: null,
    planningSessionId: null,
    workingFiles: null,
    projectName: null,
    question: '',
    answer: '',
  };

  const metaMatchers = [
    [/-\s+\*\*Timestamp:\*\*\s+(.+)/, 'timestamp'],
    [/-\s+\*\*Asking session:\*\*\s+(.+)/, 'askingSessionId'],
    [/-\s+\*\*Planning session:\*\*\s+(.+)/, 'planningSessionId'],
    [/-\s+\*\*Working files:\*\*\s+(.+)/, 'workingFiles'],
    [/-\s+\*\*Project:\*\*\s+(.+)/, 'projectName'],
  ];
  for (const [pattern, key] of metaMatchers) {
    const m = body.match(pattern);
    if (m) meta[key] = m[1].trim();
  }

  if (meta.workingFiles && meta.workingFiles !== 'none') {
    meta.workingFiles = meta.workingFiles.split(',').map(s => s.trim()).filter(Boolean);
  } else if (meta.workingFiles === 'none') {
    meta.workingFiles = [];
  }

  const questionMatch = body.match(/### Question\n+([\s\S]*?)\n### Answer/);
  if (questionMatch) meta.question = questionMatch[1].trim();

  const answerMatch = body.match(/### Answer\n+([\s\S]*)$/);
  if (answerMatch) meta.answer = answerMatch[1].trim();

  return meta;
}

module.exports = {
  DEFAULT_DECISIONS_PATH,
  FILE_HEADER,
  summarizeQuestion,
  formatDecisionEntry,
  appendDecision,
  parseDecisions,
  resolveDecisionFilePath,
};
