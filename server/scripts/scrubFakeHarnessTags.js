#!/usr/bin/env node
/**
 * One-time scrub of historical assistant messages: strip fake harness tags
 * (<system-reminder>, <command-name>, etc.) the model occasionally hallucinates.
 *
 * Run with:  DATABASE_URL=... node server/scripts/scrubFakeHarnessTags.js
 * Add --dry-run to count affected rows without rewriting them.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { query } = require('../database');
const { sanitizeAssistantText } = require('../utils/sanitizeAssistantText');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');

  const tagOrFilter = [
    '</system-reminder>',
    '</command-name>',
    '</command-message>',
    '</command-args>',
    '</local-command-stdout>',
    '</local-command-stderr>',
  ].map(t => `content LIKE '%${t}%'`).join(' OR ');

  const candidates = (await query(
    `SELECT id, content FROM messages
     WHERE role = 'assistant' AND (${tagOrFilter})
     ORDER BY id ASC`
  )).rows;

  console.log(`Found ${candidates.length} candidate assistant messages.`);

  let updated = 0;
  let unchanged = 0;
  for (const row of candidates) {
    const cleaned = sanitizeAssistantText(row.content);
    if (cleaned === row.content) {
      unchanged++;
      continue;
    }
    if (!dryRun) {
      await query(`UPDATE messages SET content = $1 WHERE id = $2`, [cleaned ?? '', row.id]);
    }
    updated++;
  }

  console.log(`${dryRun ? '[dry-run] ' : ''}Updated: ${updated}, unchanged after sanitize: ${unchanged}`);
  process.exit(0);
}

main().catch(err => {
  console.error('Scrub failed:', err);
  process.exit(1);
});
