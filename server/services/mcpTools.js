const { query } = require('../database');
const orchestrator = require('./planningSessionOrchestrator');

/**
 * Tool handlers for the Mission Control MCP server (Phase 1).
 *
 * Each handler receives the tool arguments object and a context object
 * containing { projectId, tokenId } from the authenticated request.
 *
 * Handlers may throw to signal an error — the MCP server wraps the
 * thrown message into the tool result with isError: true.
 */

async function resolveProjectId(args, ctx) {
  const explicit = args?.project_id;
  if (explicit) {
    const result = await query('SELECT id FROM projects WHERE id = $1', [explicit]);
    if (result.rows.length === 0) {
      throw new Error(`Project not found: ${explicit}`);
    }
    if (ctx?.projectId && ctx.projectId !== explicit) {
      throw new Error('Token is scoped to a different project. Cross-project session creation is not allowed via MCP.');
    }
    return explicit;
  }
  if (ctx?.projectId) return ctx.projectId;
  throw new Error('project_id is required');
}

async function startSessionTool(args, ctx) {
  const projectId = await resolveProjectId(args, ctx);
  const sessionType = args.session_type || 'planning';
  if (!['planning', 'extraction', 'eval_gatherer'].includes(sessionType)) {
    throw new Error(`session_type must be one of: planning, extraction, eval_gatherer (got "${sessionType}")`);
  }
  if (!args.task || !String(args.task).trim()) {
    throw new Error('task is required');
  }

  const result = await orchestrator.startPlanningSession({
    projectId,
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

async function sendMessageTool(args, ctx) {
  if (!args.session_id) throw new Error('session_id is required');
  if (!args.message || !String(args.message).trim()) throw new Error('message is required');

  // Authorization: tokens scoped to a project may only message sessions
  // belonging to that project.
  if (ctx?.projectId) {
    const sessionRow = (await query('SELECT project_id FROM sessions WHERE id = $1', [args.session_id])).rows[0];
    if (!sessionRow) throw new Error(`Session ${args.session_id} not found`);
    if (sessionRow.project_id && sessionRow.project_id !== ctx.projectId) {
      throw new Error('Token is scoped to a different project than this session.');
    }
  }

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

async function getStatusTool(args, ctx) {
  if (!args.session_id) throw new Error('session_id is required');
  const status = await orchestrator.getStatus(args.session_id);
  if (!status) throw new Error(`Session ${args.session_id} not found`);
  if (ctx?.projectId) {
    const row = (await query('SELECT project_id FROM sessions WHERE id = $1', [args.session_id])).rows[0];
    if (row?.project_id && row.project_id !== ctx.projectId) {
      throw new Error('Token is scoped to a different project than this session.');
    }
  }
  return {
    session_id: status.sessionId,
    status: status.status,
    duration_seconds: Math.round(status.durationSeconds * 100) / 100,
    last_response: status.lastResponse,
    session_type: status.sessionType,
  };
}

const TOOL_DEFINITIONS = [
  {
    name: 'mc_start_session',
    description:
      'Start a new Mission Control session for a project. Use session_type="planning" to escalate a product or architectural question that PRODUCT.md and ARCHITECTURE.md don\'t answer — Mission Control will spin up a read-only planning agent that already has the project\'s context documents loaded. The session appears in the dashboard, gets logged to docs/decisions.md when answered, and the user reviews it asynchronously.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string', description: 'Mission Control project ID. Optional if your auth token is project-scoped.' },
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
        timeout_seconds: { type: 'number', description: 'Override default per-type timeout. Planning defaults to 180s.' },
      },
      required: ['task'],
    },
    handler: startSessionTool,
  },
  {
    name: 'mc_send_message',
    description:
      'Send a follow-up message to an existing planning session and synchronously wait for the response. Use this when the planning agent\'s first answer needs clarification ("you said X — but what about Y?"). Blocks until the session responds or times out (default 180s for planning sessions).',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'The planning session ID returned by mc_start_session.' },
        message: { type: 'string', description: 'The follow-up question or message.' },
        asking_session_id: { type: 'string' },
        working_files: { type: 'array', items: { type: 'string' } },
        timeout_seconds: { type: 'number' },
      },
      required: ['session_id', 'message'],
    },
    handler: sendMessageTool,
  },
  {
    name: 'mc_get_session_status',
    description:
      'Check the status of a Mission Control session — useful when polling a long-running planning session instead of blocking on mc_send_message.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
      },
      required: ['session_id'],
    },
    handler: getStatusTool,
  },
];

module.exports = {
  TOOL_DEFINITIONS,
  startSessionTool,
  sendMessageTool,
  getStatusTool,
  resolveProjectId,
};
