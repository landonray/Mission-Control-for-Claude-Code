/**
 * Extracts the canonical list of database tables by parsing
 * `server/database.js` for `CREATE TABLE IF NOT EXISTS <name>` statements.
 *
 * Returns one item per table. Used by the context-doc synthesis pass to
 * ground the doc in current code instead of trusting LLM enumeration.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_REL_PATH = 'server/database.js';

function parseTables(content) {
  const tables = [];
  const seen = new Set();
  const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const name = match[1].toLowerCase();
    if (seen.has(name)) continue;
    seen.add(name);
    tables.push({ name, description: '' });
  }
  return tables;
}

async function extract(projectRoot) {
  const filePath = path.join(projectRoot, SOURCE_REL_PATH);
  if (!fs.existsSync(filePath)) {
    return { category: 'Database tables', items: [], notes: `${SOURCE_REL_PATH} not found — skipping` };
  }
  const content = await fs.promises.readFile(filePath, 'utf8');
  const items = parseTables(content);
  return {
    category: 'Database tables',
    items,
    notes: items.length === 0 ? `parsed ${SOURCE_REL_PATH} but found no CREATE TABLE statements` : undefined,
  };
}

module.exports = { extract, parseTables, SOURCE_REL_PATH };
