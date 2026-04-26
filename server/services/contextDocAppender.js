'use strict';

const fs = require('fs');
const path = require('path');

const ALLOWED = new Set(['PRODUCT.md', 'ARCHITECTURE.md']);

const FILE_HEADERS = {
  'PRODUCT.md': '# Product\n\nProduct context for this project. Append decisions below — older entries should be rolled up periodically.\n\n',
  'ARCHITECTURE.md': '# Architecture\n\nArchitectural decisions and patterns. Append decisions below — older entries should be rolled up periodically.\n\n',
};

async function appendOwnerDecisionToContextDoc({ projectRoot, doc, question, answer, timestamp }) {
  if (!ALLOWED.has(doc)) {
    throw new Error('doc must be PRODUCT.md or ARCHITECTURE.md');
  }
  const target = path.join(projectRoot, doc);
  const date = (timestamp ? new Date(timestamp) : new Date()).toISOString().slice(0, 10);
  const summary = (question || '').split(/\r?\n/)[0].trim().slice(0, 120) || 'Untitled decision';

  const block = `\n## Decision (${date}): ${summary}\n\n${(answer || '').trim()}\n`;

  if (!fs.existsSync(target)) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.writeFile(target, FILE_HEADERS[doc] + block.trimStart() + '\n', 'utf8');
    return { path: target, created: true };
  }
  const current = await fs.promises.readFile(target, 'utf8');
  const sep = current.endsWith('\n') ? '' : '\n';
  await fs.promises.appendFile(target, sep + block, 'utf8');
  return { path: target, created: false };
}

module.exports = { appendOwnerDecisionToContextDoc };
