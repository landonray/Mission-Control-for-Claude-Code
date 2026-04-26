const fs = require('fs');
const path = require('path');
const { query } = require('../database');
const orchestrator = require('./planningSessionOrchestrator');

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
];

module.exports = {
  TOOL_DEFINITIONS,
  startSessionTool,
  sendMessageTool,
  getStatusTool,
  listProjectsTool,
  readDescription,
};
