#!/usr/bin/env node
/**
 * Delete test-fixture projects (and their dangling sessions) left behind by
 * the test suite. Identifies projects by:
 *   - Known test-suite names ("mcp test project", "orch test project", etc.)
 *   - Single-letter "A"/"B"/"P" rows
 *   - root_path under /tmp/ or /var/folders/ (always test-only paths)
 *
 * The active production projects (Command Center, AI-page-builder, etc.) live
 * under /Users/landonray/coding projects/ and are never matched by these rules.
 *
 * Run with:  DATABASE_URL=... node server/scripts/cleanupTestProjects.js
 * Add --dry-run to print what would be deleted without committing.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { neon } = require('@neondatabase/serverless');

const TEST_NAMES = [
  'mcp test project',
  'orch test project',
  'pipeline test project',
  'recovery test project',
  'routes test project',
  'A', 'B', 'P',
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL not set');
    process.exit(1);
  }
  const dryRun = process.argv.includes('--dry-run');
  const sql = neon(process.env.DATABASE_URL);
  const q = (text, params) => sql.query(text, params || [], { fullResults: true });

  const matchClause = `
    name = ANY($1::text[])
    OR root_path LIKE '/tmp/%'
    OR root_path LIKE '/var/folders/%'
  `;

  const before = await q('SELECT count(*)::int AS c FROM projects');
  const junk = await q(`SELECT id, name FROM projects WHERE ${matchClause}`, [TEST_NAMES]);
  console.log(`Total projects before: ${before.rows[0].c}`);
  console.log(`Junk projects matched: ${junk.rows.length}`);

  if (junk.rows.length === 0) {
    console.log('Nothing to clean up.');
    return;
  }

  const ids = junk.rows.map(r => r.id);
  const blockingSessions = await q(
    'SELECT id, name FROM sessions WHERE project_id = ANY($1::text[])',
    [ids]
  );
  console.log(`Sessions tied to junk projects: ${blockingSessions.rows.length}`);

  if (dryRun) {
    console.log('--dry-run set; no changes made.');
    return;
  }

  // sessions FK is ON DELETE NO ACTION → must clear first.
  await q('DELETE FROM sessions WHERE project_id = ANY($1::text[])', [ids]);
  // eval_armed_folders / eval_batches also NO ACTION (currently 0 rows for junk projects).
  await q('DELETE FROM eval_armed_folders WHERE project_id = ANY($1::text[])', [ids]);
  await q('DELETE FROM eval_batches WHERE project_id = ANY($1::text[])', [ids]);
  // Remaining FK references (mcp_tokens, planning_questions, test_runs, context_doc_runs,
  // context_doc_extractions, pipelines) all CASCADE on project delete.
  const del = await q(`DELETE FROM projects WHERE ${matchClause}`, [TEST_NAMES]);

  const after = await q('SELECT count(*)::int AS c FROM projects');
  console.log(`Deleted ${del.rowCount} projects. Total projects after: ${after.rows[0].c}`);
}

main().catch(e => { console.error(e); process.exit(1); });
