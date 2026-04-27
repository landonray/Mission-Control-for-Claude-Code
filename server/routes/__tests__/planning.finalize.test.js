import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { initializeDb, query } from '../../database.js';

vi.mock('../../services/llmGateway.js', () => ({
  default: { chatCompletion: vi.fn().mockResolvedValue('Stripe.\nREASONING: Wider support and team familiarity.') },
  chatCompletion: vi.fn().mockResolvedValue('Stripe.\nREASONING: Wider support and team familiarity.'),
}));

const QID = 'test-finalize-q';
const PID = 'test-finalize-proj';
const SID = 'test-finalize-session';

describe('decision finalize endpoints', () => {
  let app;

  beforeAll(async () => {
    await initializeDb();
    const planningRouter = (await import('../planning.js')).default;
    app = express();
    app.use(express.json());
    app.use('/api/planning', planningRouter);

    await query(`INSERT INTO projects (id, name, root_path, created_at) VALUES ($1, 'P', '/tmp/test-finalize-proj', NOW()) ON CONFLICT (id) DO NOTHING`, [PID]);
    await query(`INSERT INTO sessions (id, name, project_id, created_at) VALUES ($1, 'test-finalize-session', $2, NOW()) ON CONFLICT (id) DO NOTHING`, [SID, PID]);
    await query(`DELETE FROM planning_questions WHERE id = $1`, [QID]);
    await query(
      `INSERT INTO planning_questions (id, project_id, planning_session_id, question, status, asked_at, escalation_recommendation)
       VALUES ($1, $2, $3, 'q?', 'escalated', NOW(), 'rec')`,
      [QID, PID, SID]
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM decision_chats WHERE question_id = $1`, [QID]);
    await query(`DELETE FROM planning_questions WHERE id = $1`, [QID]);
  });

  it('POST draft-answer returns answer and reasoning_summary', async () => {
    const res = await request(app)
      .post(`/api/planning/escalations/${QID}/draft-answer`);
    expect(res.status).toBe(200);
    expect(res.body.answer).toBe('Stripe.');
    expect(res.body.reasoning_summary).toBe('Wider support and team familiarity.');
  });

  it('POST finalize stores owner_answer and reasoning summary, marks answered', async () => {
    const res = await request(app)
      .post(`/api/planning/escalations/${QID}/finalize`)
      .send({ answer: 'Use Stripe.', reasoning_summary: 'Familiarity.', addToContextDoc: 'neither' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('answered');
    const row = await query(`SELECT status, owner_answer FROM planning_questions WHERE id = $1`, [QID]);
    expect(row.rows[0].status).toBe('answered');
    expect(row.rows[0].owner_answer).toBe('Use Stripe.');
  });

  it('POST finalize rejects when not in escalated state', async () => {
    const res = await request(app)
      .post(`/api/planning/escalations/${QID}/finalize`)
      .send({ answer: 'x', reasoning_summary: 'y', addToContextDoc: 'neither' });
    expect(res.status).toBe(409);
  });
});
