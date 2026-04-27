const express = require('express');
const router = express.Router();
const { query } = require('../database');

const STAGE_NAMES = {
  1: 'Spec Refinement',
  2: 'QA Design',
  3: 'Implementation Planning',
  4: 'Implementation',
  5: 'QA Execution',
  6: 'Code Review',
  7: 'Fix Cycle',
};

// GET /api/decisions/pending
//
// Returns one normalized list combining:
//   1. Planning escalations (planning_questions where status='escalated')
//   2. Pipeline stages awaiting owner approval (pipelines where status='paused_for_approval')
//
// Each item has the same envelope so the frontend can render them in one list:
//   { id, kind: 'planning' | 'pipeline_stage', project_id, project_name,
//     created_at, planning?: {...}, pipeline_stage?: {...} }
router.get('/pending', async (req, res) => {
  const projectId = req.query.project_id || null;
  try {
    const planningParams = projectId ? [projectId] : [];
    const planningWhere = projectId ? `AND pq.project_id = $1` : '';
    const planningRes = await query(
      `SELECT pq.id, pq.project_id, pq.planning_session_id, pq.asking_session_id, pq.question,
              pq.escalation_recommendation, pq.escalation_reason, pq.escalation_context,
              pq.working_files, pq.status, pq.asked_at,
              p.name AS project_name
         FROM planning_questions pq
         LEFT JOIN projects p ON p.id = pq.project_id
         WHERE pq.status = 'escalated' ${planningWhere}
         ORDER BY pq.asked_at ASC`,
      planningParams
    );

    const pipelineParams = projectId ? [projectId] : [];
    const pipelineWhere = projectId ? `AND pl.project_id = $1` : '';
    const pipelineRes = await query(
      `SELECT pl.id, pl.name AS pipeline_name, pl.project_id, pl.current_stage,
              pl.status, pl.updated_at,
              p.name AS project_name,
              pso.iteration, pso.output_path, pso.created_at AS output_created_at,
              pso.rejection_feedback
         FROM pipelines pl
         LEFT JOIN projects p ON p.id = pl.project_id
         LEFT JOIN LATERAL (
           SELECT iteration, output_path, created_at, rejection_feedback
             FROM pipeline_stage_outputs
            WHERE pipeline_id = pl.id AND stage = pl.current_stage
            ORDER BY iteration DESC LIMIT 1
         ) pso ON TRUE
         WHERE pl.status = 'paused_for_approval' ${pipelineWhere}
         ORDER BY pl.updated_at ASC`,
      pipelineParams
    );

    const planningItems = planningRes.rows.map((r) => ({
      id: `pq_${r.id}`,
      kind: 'planning',
      project_id: r.project_id,
      project_name: r.project_name || 'Unknown',
      created_at: r.asked_at,
      planning: {
        ...r,
        working_files: r.working_files
          ? r.working_files.split(',').map((s) => s.trim()).filter(Boolean)
          : [],
      },
    }));

    const pipelineItems = pipelineRes.rows.map((r) => ({
      id: `ps_${r.id}_${r.current_stage}`,
      kind: 'pipeline_stage',
      project_id: r.project_id,
      project_name: r.project_name || 'Unknown',
      created_at: r.output_created_at || r.updated_at,
      pipeline_stage: {
        pipeline_id: r.id,
        pipeline_name: r.pipeline_name,
        stage: r.current_stage,
        stage_name: STAGE_NAMES[r.current_stage] || `Stage ${r.current_stage}`,
        iteration: r.iteration ?? 1,
        output_path: r.output_path || null,
        rejection_feedback: r.rejection_feedback || null,
      },
    }));

    const items = [...planningItems, ...pipelineItems].sort(
      (a, b) => new Date(a.created_at) - new Date(b.created_at)
    );
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/decisions/pending/count — total across both kinds
router.get('/pending/count', async (req, res) => {
  try {
    const planning = await query(
      `SELECT COUNT(*)::int AS count FROM planning_questions WHERE status = 'escalated'`
    );
    const pipelines = await query(
      `SELECT COUNT(*)::int AS count FROM pipelines WHERE status = 'paused_for_approval'`
    );
    res.json({
      count: (planning.rows[0].count || 0) + (pipelines.rows[0].count || 0),
      planning: planning.rows[0].count || 0,
      pipeline_stage: pipelines.rows[0].count || 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
