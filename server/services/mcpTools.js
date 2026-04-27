const fs = require('fs');
const path = require('path');
const { query } = require('../database');
const orchestrator = require('./planningSessionOrchestrator');
const pipelineRepo = require('./pipelineRepo');
const pipelineRuntime = require('./pipelineRuntime');

/**
 * Tool handlers for the Mission Control MCP server (Phase 1).
 *
 * Tokens are app-wide: every tool call (other than mc_list_projects) requires
 * an explicit project_id arg. Claude Code is expected to call mc_list_projects
 * first to discover available projects.
 */

async function assertProjectExists(projectId) {
  const result = await query('SELECT id FROM projects WHERE id = $1', [projectId]);
  if (result.rows.length === 0) {
    throw new Error(`Project not found: ${projectId}`);
  }
}

function readDescription(rootPath) {
  if (!rootPath) return null;
  // PRODUCT.md is the canonical project context doc (slice 3 will create
  // these). README.md is the next best fallback. CLAUDE.md is intentionally
  // last because it usually leads with user/instruction content rather than
  // a description of the project itself.
  const candidates = ['PRODUCT.md', 'README.md', 'CLAUDE.md'];
  for (const file of candidates) {
    try {
      const abs = path.join(rootPath, file);
      if (!fs.existsSync(abs)) continue;
      const content = fs.readFileSync(abs, 'utf8');
      // First non-heading paragraph, capped at 240 chars.
      const lines = content.split('\n');
      const paragraph = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          if (paragraph.length > 0) break;
          continue;
        }
        if (trimmed.startsWith('#')) continue;
        paragraph.push(trimmed);
      }
      if (paragraph.length === 0) continue;
      const text = paragraph.join(' ').replace(/\s+/g, ' ');
      return text.length > 240 ? text.slice(0, 237).trimEnd() + '…' : text;
    } catch (_) {
      // ignore unreadable files
    }
  }
  return null;
}

async function listProjectsTool(_args, _ctx) {
  const result = await query(
    `SELECT id, name, root_path, github_repo, deployment_url, last_deploy_status
     FROM projects ORDER BY name ASC`
  );
  return {
    projects: result.rows.map((row) => {
      const productMd = row.root_path ? path.join(row.root_path, 'PRODUCT.md') : null;
      const archMd = row.root_path ? path.join(row.root_path, 'ARCHITECTURE.md') : null;
      const decisionsMd = row.root_path ? path.join(row.root_path, 'docs', 'decisions.md') : null;
      return {
        id: row.id,
        name: row.name,
        root_path: row.root_path,
        github_repo: row.github_repo || null,
        deployment_url: row.deployment_url || null,
        last_deploy_status: row.last_deploy_status || null,
        description: readDescription(row.root_path),
        product_md_exists: productMd ? fs.existsSync(productMd) : false,
        architecture_md_exists: archMd ? fs.existsSync(archMd) : false,
        decisions_md_exists: decisionsMd ? fs.existsSync(decisionsMd) : false,
      };
    }),
  };
}

async function startSessionTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required. Call mc_list_projects to discover available projects.');
  }
  await assertProjectExists(args.project_id);

  const sessionType = args.session_type || 'planning';
  if (!['planning', 'extraction', 'eval_gatherer'].includes(sessionType)) {
    throw new Error(`session_type must be one of: planning, extraction, eval_gatherer (got "${sessionType}")`);
  }
  if (!args.task || !String(args.task).trim()) {
    throw new Error('task is required');
  }

  const result = await orchestrator.startPlanningSession({
    projectId: args.project_id,
    systemPrompt: args.system_prompt || null,
    task: args.task,
    contextFiles: args.context_files || [],
    timeoutSeconds: args.timeout_seconds,
    askingSessionId: args.asking_session_id || null,
    workingFiles: args.working_files || null,
  });
  return {
    session_id: result.sessionId,
    status: result.status,
    planning_question_id: result.planningQuestionId,
    session_type: sessionType,
  };
}

async function sendMessageTool(args, _ctx) {
  if (!args.session_id) throw new Error('session_id is required');
  if (!args.message || !String(args.message).trim()) throw new Error('message is required');

  const result = await orchestrator.sendAndAwait(args.session_id, args.message, {
    timeoutSeconds: args.timeout_seconds,
    askingSessionId: args.asking_session_id || null,
    workingFiles: args.working_files || null,
  });
  return {
    response: result.response,
    status: result.status,
    duration_seconds: Math.round(result.durationSeconds * 100) / 100,
    error: result.error,
  };
}

async function getStatusTool(args, _ctx) {
  if (!args.session_id) throw new Error('session_id is required');
  const status = await orchestrator.getStatus(args.session_id);
  if (!status) throw new Error(`Session ${args.session_id} not found`);
  return {
    session_id: status.sessionId,
    status: status.status,
    duration_seconds: Math.round(status.durationSeconds * 100) / 100,
    last_response: status.lastResponse,
    session_type: status.sessionType,
  };
}

const CONTEXT_DOCS = {
  product: 'PRODUCT.md',
  architecture: 'ARCHITECTURE.md',
};

function readContextDoc(rootPath, filename) {
  if (!rootPath) {
    return { exists: false, path: null, content: null };
  }
  const abs = path.join(rootPath, filename);
  if (!fs.existsSync(abs)) {
    return { exists: false, path: abs, content: null };
  }
  try {
    return { exists: true, path: abs, content: fs.readFileSync(abs, 'utf8') };
  } catch (err) {
    return { exists: false, path: abs, content: null, error: err.message };
  }
}

async function getProjectContextTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required. Call mc_list_projects to discover available projects.');
  }
  const which = (args.document || 'both').toLowerCase();
  if (!['product', 'architecture', 'both'].includes(which)) {
    throw new Error(`document must be one of: product, architecture, both (got "${args.document}")`);
  }

  const result = await query(
    'SELECT id, name, root_path FROM projects WHERE id = $1',
    [args.project_id]
  );
  if (result.rows.length === 0) {
    throw new Error(`Project not found: ${args.project_id}`);
  }
  const project = result.rows[0];

  const out = {
    project_id: project.id,
    project_name: project.name,
    root_path: project.root_path,
  };
  if (which === 'product' || which === 'both') {
    out.product = readContextDoc(project.root_path, CONTEXT_DOCS.product);
  }
  if (which === 'architecture' || which === 'both') {
    out.architecture = readContextDoc(project.root_path, CONTEXT_DOCS.architecture);
  }
  return out;
}

async function startPipelineTool(args, _ctx) {
  if (!args.project_id) {
    throw new Error('project_id is required. Call mc_list_projects to discover available projects.');
  }
  if (!args.name || !String(args.name).trim()) {
    throw new Error('name is required (a short label for the pipeline).');
  }
  if (!args.spec || !String(args.spec).trim()) {
    throw new Error('spec is required (the raw spec text the pipeline will refine and build).');
  }
  await assertProjectExists(args.project_id);
  const orch = pipelineRuntime.getOrchestrator();
  const pipeline = await orch.createAndStart({
    projectId: args.project_id,
    name: args.name,
    specInput: args.spec,
  });
  return {
    pipeline_id: pipeline.id,
    name: pipeline.name,
    status: pipeline.status,
    current_stage: pipeline.current_stage,
    branch_name: pipeline.branch_name,
  };
}

async function getPipelineStatusTool(args, _ctx) {
  if (!args.pipeline_id) throw new Error('pipeline_id is required');
  const pipeline = await pipelineRepo.getPipeline(args.pipeline_id);
  if (!pipeline) throw new Error(`Pipeline ${args.pipeline_id} not found`);
  const outputs = await pipelineRepo.listStageOutputs(pipeline.id);
  const chunks = await pipelineRepo.listChunks(pipeline.id);
  const escalations = await pipelineRepo.listOpenEscalations(pipeline.id);
  return {
    pipeline_id: pipeline.id,
    name: pipeline.name,
    status: pipeline.status,
    current_stage: pipeline.current_stage,
    fix_cycle_count: pipeline.fix_cycle_count || 0,
    branch_name: pipeline.branch_name,
    completed_at: pipeline.completed_at,
    outputs: outputs.map((o) => ({
      stage: o.stage, iteration: o.iteration, output_path: o.output_path, status: o.status,
    })),
    chunks: chunks.map((c) => ({
      chunk_index: c.chunk_index, name: c.name, status: c.status,
    })),
    escalations: escalations.map((e) => ({ stage: e.stage, summary: e.summary, detail: e.detail })),
  };
}

async function approveStageTool(args, _ctx) {
  if (!args.pipeline_id) throw new Error('pipeline_id is required');
  await pipelineRuntime.approveAndBroadcast(args.pipeline_id);
  const pipeline = await pipelineRepo.getPipeline(args.pipeline_id);
  return { ok: true, current_stage: pipeline.current_stage, status: pipeline.status };
}

async function rejectStageTool(args, _ctx) {
  if (!args.pipeline_id) throw new Error('pipeline_id is required');
  if (!args.feedback || !String(args.feedback).trim()) {
    throw new Error('feedback is required (a concrete description of what to change).');
  }
  await pipelineRuntime.rejectAndBroadcast(args.pipeline_id, args.feedback);
  const pipeline = await pipelineRepo.getPipeline(args.pipeline_id);
  return { ok: true, current_stage: pipeline.current_stage, status: pipeline.status };
}

const TOOL_DEFINITIONS = [
  {
    name: 'mc_list_projects',
    description:
      'List all projects known to Mission Control so you can pick the right one before starting a session. Each project includes its name, repo path, GitHub repo (if linked), latest deployment status, a short description pulled from CLAUDE.md or README.md, and flags showing whether PRODUCT.md, ARCHITECTURE.md, and docs/decisions.md exist. Always call this first before mc_start_session.',
    inputSchema: { type: 'object', properties: {} },
    handler: listProjectsTool,
  },
  {
    name: 'mc_start_session',
    description:
      'Start a new Mission Control session in a specific project. Use session_type="planning" to escalate a product or architectural question that PRODUCT.md and ARCHITECTURE.md don\'t answer — Mission Control will spin up a read-only planning agent that already has the project\'s context documents loaded. The session appears in the dashboard, gets logged to docs/decisions.md when answered, and the user reviews it asynchronously. Call mc_list_projects first if you don\'t know which project_id to use.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required. Get this from mc_list_projects.' },
        session_type: {
          type: 'string',
          enum: ['planning', 'extraction', 'eval_gatherer'],
          description: 'Session type. Defaults to "planning".',
        },
        system_prompt: { type: 'string', description: 'Optional override for the planning agent\'s system prompt.' },
        task: { type: 'string', description: 'The question or task to give the planning agent. Required.' },
        context_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of project-relative file paths to load into the session\'s context. PRODUCT.md and ARCHITECTURE.md are auto-loaded — only specify additional files here.',
        },
        asking_session_id: { type: 'string', description: 'The ID of the implementation session asking this question (for decision-log linking).' },
        working_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files the asking session is currently working on. Logged into docs/decisions.md so reviewers can see what code prompted the question.',
        },
        timeout_seconds: { type: 'number', description: 'Optional cap on how long to wait for the session to respond. Omit (or 0) to wait indefinitely (recommended).' },
      },
      required: ['project_id', 'task'],
    },
    handler: startSessionTool,
  },
  {
    name: 'mc_send_message',
    description:
      'Send a follow-up message to an existing planning session and synchronously wait for the response. Use this when the planning agent\'s first answer needs clarification ("you said X — but what about Y?"). Blocks until the session responds. Use mc_get_session_status to poll instead if you don\'t want to block.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The planning session ID returned by mc_start_session.' },
        message: { type: 'string', description: 'The follow-up question or message.' },
        asking_session_id: { type: 'string' },
        working_files: { type: 'array', items: { type: 'string' } },
        timeout_seconds: { type: 'number', description: 'Optional cap on how long to wait. Omit (or 0) to wait indefinitely (recommended).' },
      },
      required: ['session_id', 'message'],
    },
    handler: sendMessageTool,
  },
  {
    name: 'mc_get_session_status',
    description:
      'Check the status of a Mission Control session. For planning sessions, status="waiting_for_owner" means the planning agent escalated the question to the project owner — keep polling. status="completed" with last_response set means an answer is available (either from the planning agent or, in the case of an escalation, from the owner). status="dismissed" means the owner closed the escalation without answering.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
      },
      required: ['session_id'],
    },
    handler: getStatusTool,
  },
  {
    name: 'mc_get_project_context',
    description:
      "Fetch a project's context documents (PRODUCT.md and/or ARCHITECTURE.md) without starting a session. Use this when you need raw project context — e.g., a CI check, a webhook handler, or a quick lookup before deciding whether to escalate. For most product/architecture questions during a coding session, prefer mc_start_session with session_type='planning' so the question is logged as a decision.",
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required. Get this from mc_list_projects.' },
        document: {
          type: 'string',
          enum: ['product', 'architecture', 'both'],
          description: 'Which document to return. Defaults to "both".',
        },
      },
      required: ['project_id'],
    },
    handler: getProjectContextTool,
  },
  {
    name: 'mc_start_pipeline',
    description:
      'Create and start a Mission Control pipeline that will take a raw spec through spec refinement, QA design, implementation planning, implementation, QA execution, code review, and (if needed) fix cycles. Stages 1-3 are user-gated; stages 4-7 run autonomously. Returns the pipeline_id; use mc_get_pipeline_status to track progress and mc_approve_stage / mc_reject_stage to act on gated stages.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Required. Call mc_list_projects to discover available projects.' },
        name: { type: 'string', description: 'Short label for the pipeline (e.g. "Add pagination support"). Required.' },
        spec: { type: 'string', description: 'Raw spec text the pipeline will refine and build. Required.' },
      },
      required: ['project_id', 'name', 'spec'],
    },
    handler: startPipelineTool,
  },
  {
    name: 'mc_get_pipeline_status',
    description:
      'Get the current state of a pipeline: status, current stage, stage outputs produced so far, chunk progress for stage 4, fix cycle count, and any open escalations the project owner needs to resolve. Status values: draft, running, paused_for_approval (gated stage waiting for the owner), paused_for_failure (output never produced), paused_for_escalation (fix cycle cap exceeded), completed, failed.',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string', description: 'Pipeline ID returned by mc_start_pipeline.' },
      },
      required: ['pipeline_id'],
    },
    handler: getPipelineStatusTool,
  },
  {
    name: 'mc_approve_stage',
    description:
      'Approve the current paused stage of a pipeline so it advances to the next stage. Only works when the pipeline is paused_for_approval. After mc_approve_stage on stage 3, the pipeline parses the build plan and starts the autonomous implementation phase.',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string' },
      },
      required: ['pipeline_id'],
    },
    handler: approveStageTool,
  },
  {
    name: 'mc_reject_stage',
    description:
      'Reject the current paused stage of a pipeline and re-run it with the supplied feedback added to the prompt. Only works when the pipeline is paused_for_approval. Use this when the stage output has the wrong shape or scope and you want the same stage to try again.',
    inputSchema: {
      type: 'object',
      properties: {
        pipeline_id: { type: 'string' },
        feedback: { type: 'string', description: 'What to change. Be specific so the next attempt addresses it.' },
      },
      required: ['pipeline_id', 'feedback'],
    },
    handler: rejectStageTool,
  },
];

module.exports = {
  TOOL_DEFINITIONS,
  startSessionTool,
  sendMessageTool,
  getStatusTool,
  listProjectsTool,
  getProjectContextTool,
  readDescription,
  startPipelineTool,
  getPipelineStatusTool,
  approveStageTool,
  rejectStageTool,
};
