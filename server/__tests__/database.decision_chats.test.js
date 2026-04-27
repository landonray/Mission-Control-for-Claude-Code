import { describe, it, expect, beforeAll } from 'vitest';
import { query, initializeDb } from '../database.js';

describe('decision_chats table', () => {
  beforeAll(async () => {
    await initializeDb();
  });

  it('exists with the expected columns', async () => {
    const result = await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'decision_chats' ORDER BY column_name`
    );
    const cols = result.rows.map((r) => r.column_name).sort();
    expect(cols).toEqual(['content', 'created_at', 'id', 'question_id', 'role'].sort());
  });

  it('rejects rows with invalid role', async () => {
    await expect(
      query(
        `INSERT INTO decision_chats (id, question_id, role, content, created_at)
         VALUES ('test-bad-role', 'nonexistent', 'banana', 'x', NOW())`
      )
    ).rejects.toThrow();
  });
});
