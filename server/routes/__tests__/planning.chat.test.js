import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { initializeDb, query } from '../../database.js';

vi.mock('../../services/llmGateway.js', () => ({
  default: { chatCompletion: vi.fn().mockResolvedValue('mocked LLM reply') },
  chatCompletion: vi.fn().mockResolvedValue('mocked LLM reply'),
}));

const TEST_QID = 'test-chat-q-1';
const TEST_PID = 'test-chat-proj';
const TEST_SID = 'test-chat-session';

describe('decision chat endpoints', () => {
  let app;

  beforeAll(async () => {
    await initializeDb();
    const planningRouter = (await import('../planning.js')).default;
    app = express();
    app.use(express.json());
    app.use('/api/planning', planningRouter);

    await query(`INSERT INTO projects (id, name, root_path, created_at) VALUES ($1, 'P', '/tmp/test-chat-proj', NOW()) ON CONFLICT (id) DO NOTHING`, [TEST_PID]);
    await query(`INSERT INTO sessions (id, name, project_id, created_at) VALUES ($1, 'test-chat-session', $2, NOW()) ON CONFLICT (id) DO NOTHING`, [TEST_SID, TEST_PID]);
    await query(`DELETE FROM decision_chats WHERE question_id = $1`, [TEST_QID]);
    await query(`DELETE FROM planning_questions WHERE id = $1`, [TEST_QID]);
    await query(
      `INSERT INTO planning_questions (id, project_id, planning_session_id, question, status, asked_at, escalation_recommendation)
       VALUES ($1, $2, $3, 'q?', 'escalated', NOW(), 'rec')`,
      [TEST_QID, TEST_PID, TEST_SID]
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM decision_chats WHERE question_id = $1`, [TEST_QID]);
    await query(`DELETE FROM planning_questions WHERE id = $1`, [TEST_QID]);
  });

  it('GET chat returns empty list initially', async () => {
    const res = await request(app).get(`/api/planning/escalations/${TEST_QID}/chat`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('POST chat appends user + assistant messages', async () => {
    const res = await request(app)
      .post(`/api/planning/escalations/${TEST_QID}/chat`)
      .send({ message: 'why this rec?' });
    expect(res.status).toBe(200);
    expect(res.body.assistant.role).toBe('assistant');
    expect(res.body.assistant.content).toBe('mocked LLM reply');

    const after = await request(app).get(`/api/planning/escalations/${TEST_QID}/chat`);
    expect(after.body.length).toBe(2);
    expect(after.body[0].role).toBe('user');
    expect(after.body[1].role).toBe('assistant');
  });

  it('POST chat rejects empty message', async () => {
    const res = await request(app)
      .post(`/api/planning/escalations/${TEST_QID}/chat`)
      .send({ message: '   ' });
    expect(res.status).toBe(400);
  });

  it('POST chat rejects when question is not escalated', async () => {
    await query(`UPDATE planning_questions SET status = 'answered' WHERE id = $1`, [TEST_QID]);
    const res = await request(app)
      .post(`/api/planning/escalations/${TEST_QID}/chat`)
      .send({ message: 'hi' });
    expect(res.status).toBe(409);
    await query(`UPDATE planning_questions SET status = 'escalated' WHERE id = $1`, [TEST_QID]);
  });
});
