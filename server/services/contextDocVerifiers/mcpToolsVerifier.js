/**
 * Extracts the canonical list of Mission Control MCP tool names from
 * `server/services/mcpTools.js` by parsing the TOOL_DEFINITIONS array.
 *
 * Returns one item per tool with the exact name and a short description
 * pulled from the registration. Used by the context-doc synthesis pass to
 * ground the doc in current code instead of trusting LLM enumeration.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_REL_PATH = 'server/services/mcpTools.js';

/**
 * Pull each tool registration's name and a single-sentence description
 * from the file content. Tolerant to additional fields and multi-line
 * descriptions by anchoring on the `name:` line and looking ahead for
 * the next `description:` field.
 */
function parseTools(content) {
  const tools = [];
  const seen = new Set();
  // Each tool registration starts with `name: '<name>'` (single or double quotes).
  const namePattern = /name:\s*['"]([a-z_][a-z0-9_]*)['"]/gi;
  let match;
  while ((match = namePattern.exec(content)) !== null) {
    const name = match[1];
    if (!name.startsWith('mc_')) continue; // Filter to MCP tools only.
    if (seen.has(name)) continue;
    seen.add(name);

    // Look for a description in the ~800 chars after this name.
    const lookahead = content.slice(match.index, match.index + 800);
    const descMatch = lookahead.match(/description:\s*\n?\s*['"]([^'"]+)['"]/);
    let description = descMatch ? descMatch[1].trim() : '';
    // Keep just the first sentence so canonical lists stay scannable.
    const firstSentenceEnd = description.search(/\.\s|$/);
    if (firstSentenceEnd > 0 && firstSentenceEnd < description.length - 1) {
      description = description.slice(0, firstSentenceEnd + 1);
    }
    if (description.length > 240) description = description.slice(0, 237) + '…';

    tools.push({ name, description });
  }
  return tools;
}

async function extract(projectRoot) {
  const filePath = path.join(projectRoot, SOURCE_REL_PATH);
  if (!fs.existsSync(filePath)) {
    return { category: 'MCP tools', items: [], notes: `${SOURCE_REL_PATH} not found — skipping` };
  }
  const content = await fs.promises.readFile(filePath, 'utf8');
  const items = parseTools(content);
  return {
    category: 'MCP tools',
    items,
    notes: items.length === 0 ? `parsed ${SOURCE_REL_PATH} but found no mc_* tool registrations` : undefined,
  };
}

module.exports = { extract, parseTools, SOURCE_REL_PATH };
