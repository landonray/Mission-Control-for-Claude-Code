const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../database');
const sessionManager = require('./sessionManager');
const decisionLog = require('./decisionLog');
const { parseEscalation } = require('./escalationParser');

const ESCALATION_HOLDING_RESPONSE = 'This question has been escalated to the project owner. Continue with other work that does not depend on this answer, or call mc_get_session_status periodically to check whether an answer has arrived.';

async function loadProjectContextFiles(projectRoot) {
  const tryPaths = [
    path.join(projectRoot, 'PRODUCT.md'),
    path.join(projectRoot, 'ARCHITECTURE.md'),
  ];
  const sections = [];
  for (const p of tryPaths) {
    try {
      if (fs.existsSync(p)) {
        const content = await fs.promises.readFile(p, 'utf8');
        const name = path.basename(p);
        sections.push(`### ${name}\n\n${content.trim()}`);
      }
    } catch (_) {
      // Best-effort; missing or unreadable files are simply skipped.
    }
  }
  return sections;
}

async function loadExtraContextFiles(projectRoot, contextFiles) {
  if (!Array.isArray(contextFiles) || contextFiles.length === 0) return [];
  const sections = [];
  for (const rel of contextFiles) {
    try {
      const abs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
      if (!abs.startsWith(projectRoot)) continue; // safety: stay within project
      if (!fs.existsSync(abs)) continue;
      const content = await fs.promises.readFile(abs, 'utf8');
      sections.push(`### ${path.relative(projectRoot, abs) || abs}\n\n${content.trim()}`);
    } catch (_) {
      // ignore unreadable files
    }
  }
  return sections;
}

function buildPlanningPrompt({ systemPrompt, task, contextSections }) {
  const parts = [];
  if (systemPrompt) {
    parts.push(systemPrompt.trim());
  } else {
    parts.push(
      'You are a senior product and architecture planning agent for this project. ' +
      'Answer the question below using the project context provided. ' +
      'Be concrete, decisive, and brief.'
    );
  }
  if (contextSections && contextSections.length > 0) {
    parts.push('\n## Project context\n\n' + contextSections.join('\n\n'));
  }

  parts.push(`
## Sub-agent rule

Do not spawn sub-agents, background processes, or parallel tasks on your own. If you need work done in parallel, if a task is too large for a single session, or if you need a different perspective (planning, QA, code review), use the Mission Control MCP tools to start a new session. All work must be visible in Mission Control. Starting your own sub-agents outside of Mission Control is not allowed.


## Escalation rules

After reasoning through the question, assess whether you can answer confidently or whether this needs to be escalated to the project owner.

You CAN answer if:
- The answer is clearly supported by the project's PRODUCT.md or ARCHITECTURE.md
- The answer follows established patterns visible in the codebase
- The question is a straightforward technical decision with a clear best practice
- The decision is easily reversible if the owner disagrees

You MUST escalate if:
- The question requires establishing a new pattern not covered by existing documentation
- The answer would contradict an existing documented pattern or decision
- The question involves strategic or business direction
- The decision involves irreversible or expensive-to-reverse changes (data model migrations, dropping features, switching core dependencies)
- The question has external stakeholder implications
- You genuinely don't have enough context to give a confident answer

If you can answer, respond normally with your answer.

If you must escalate, respond in EXACTLY this format (and nothing else after this block):

ESCALATE
Question: <restate the question clearly>
Context: <what you know about this topic from the project documents>
Recommendation: <what you would answer if you could, and why>
Reason for escalation: <which category above applies>
`);

  parts.push('\n## Question\n\n' + (task || '').trim());
  parts.push(
    '\nIMPORTANT: You are in read-only planning mode. Do not edit, write, or create files. ' +
    'Reading and searching the project is fine. Respond with a clear, direct answer or with the ESCALATE block above.'
  );
  return parts.join('\n');
}

/**
 * Start a planning session.
 *
 * @param {Object} opts
 * @param {string} opts.projectId
 * @param {string} [opts.systemPrompt]
 * @param {string} opts.task
 * @param {string[]} [opts.contextFiles]
 * @param {number} [opts.timeoutSeconds]
 * @param {string} [opts.askingSessionId]
 * @param {string} [opts.workingFiles]
 * @returns {{ sessionId: string, status: string, planningQuestionId: string }}
 */
async function startPlanningSession(opts) {
  const {
    projectId, systemPrompt, task, contextFiles,
    askingSessionId, workingFiles,
  } = opts;

  if (!projectId) throw new Error('projectId is required');
  if (!task || !String(task).trim()) throw new Error('task is required');

  const projectResult = await query('SELECT id, name, root_path FROM projects WHERE id = $1', [projectId]);
  const project = projectResult.rows[0];
  if (!project) throw new Error(`Project ${projectId} not found`);

  const productArchSections = await loadProjectContextFiles(project.root_path);
  const extraSections = await loadExtraContextFiles(project.root_path, contextFiles);
  const contextSections = [...productArchSections, ...extraSections];

  const initialPrompt = buildPlanningPrompt({ systemPrompt, task, contextSections });

  const session = await sessionManager.createSession({
    name: `Planning: ${decisionLog.summarizeQuestion(task)}`,
    workingDirectory: project.root_path,
    permissionMode: 'plan',
    model: process.env.MC_PLANNING_MODEL || 'claude-sonnet-4-6',
    sessionType: 'planning',
    askingSessionId: askingSessionId || null,
    projectId,
    initialPrompt,
  });

  const planningQuestionId = uuidv4();
  await query(
    `INSERT INTO planning_questions
       (id, project_id, planning_session_id, asking_session_id, question, working_files, status, asked_at)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())`,
    [
      planningQuestionId,
      projectId,
      session.id,
      askingSessionId || null,
      task,
      formatWorkingFilesField(workingFiles),
    ]
  );

  return { sessionId: session.id, status: 'started', planningQuestionId };
}

function formatWorkingFilesField(workingFiles) {
  if (!workingFiles) return null;
  if (Array.isArray(workingFiles)) return workingFiles.join(',');
  return String(workingFiles);
}

/**
 * Send a message to a session and synchronously await the response.
 * Resolves when the session next transitions to idle (after working) or errors.
 */
async function sendAndAwait(sessionId, message, { timeoutSeconds, askingSessionId, workingFiles } = {}) {
  const sessionRow = (await query(
    'SELECT id, project_id, session_type FROM sessions WHERE id = $1',
    [sessionId]
  )).rows[0];
  if (!sessionRow) throw new Error(`Session ${sessionId} not found`);

  const sessionType = sessionRow.session_type || 'implementation';
  const timeoutMs = timeoutSeconds && timeoutSeconds > 0 ? timeoutSeconds * 1000 : 0;
  const startTime = Date.now();

  // Track the most recent assistant text observed during this turn.
  let lastAssistantContent = '';
  let observedWorking = false;
  let resolved = false;

  // Optional planning_questions row for follow-up turns within the same planning session.
  let planningQuestionId = null;
  if (sessionType === 'planning') {
    const existing = await query(
      `SELECT id FROM planning_questions WHERE planning_session_id = $1 AND status = 'pending' ORDER BY asked_at DESC LIMIT 1`,
      [sessionId]
    );
    if (existing.rows.length === 0) {
      planningQuestionId = uuidv4();
      await query(
        `INSERT INTO planning_questions
           (id, project_id, planning_session_id, asking_session_id, question, working_files, status, asked_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())`,
        [
          planningQuestionId, sessionRow.project_id, sessionId,
          askingSessionId || null, message, formatWorkingFilesField(workingFiles),
        ]
      );
    } else {
      planningQuestionId = existing.rows[0].id;
    }
  }

  let listener;
  const responsePromise = new Promise((resolve) => {
    listener = async (event) => {
      if (resolved) return;
      try {
        if (event.type === 'stream_event' && event.event && event.event.type === 'assistant') {
          const content = extractAssistantText(event.event);
          if (content) lastAssistantContent = content;
        } else if (event.type === 'session_status') {
          if (event.status === 'working') observedWorking = true;
          if (observedWorking && (event.status === 'idle' || event.status === 'ended')) {
            resolved = true;
            const duration = Date.now() - startTime;
            const text = lastAssistantContent || (await fetchLastAssistantText(sessionId));
            const turn = await finalizePlanningTurn({
              sessionId, sessionType, planningQuestionId, message, response: text,
            });
            if (turn && turn.escalated) {
              resolve({
                response: ESCALATION_HOLDING_RESPONSE,
                status: 'escalated',
                durationSeconds: duration / 1000,
              });
            } else {
              resolve({ response: text, status: 'completed', durationSeconds: duration / 1000 });
            }
          }
        } else if (event.type === 'error') {
          resolved = true;
          resolve({ response: '', status: 'error', error: event.error || 'Session error', durationSeconds: (Date.now() - startTime) / 1000 });
        }
      } catch (e) {
        if (!resolved) {
          resolved = true;
          resolve({ response: '', status: 'error', error: e.message, durationSeconds: (Date.now() - startTime) / 1000 });
        }
      }
    };
  });

  const timeoutPromise = timeoutMs > 0 ? new Promise((resolve) => {
    setTimeout(async () => {
      if (resolved) return;
      resolved = true;
      const text = lastAssistantContent || (await fetchLastAssistantText(sessionId));
      resolve({ response: text, status: 'timed_out', durationSeconds: (Date.now() - startTime) / 1000 });
    }, timeoutMs);
  }) : new Promise(() => {}); // never resolves

  // resumeSession handles both cases: if the session is already active, it just
  // attaches the listener and sends the message; if it's cold, it spawns a new
  // CLI process (restoring the worktree and transcript) before sending.
  const session = await sessionManager.resumeSession(sessionId, message, { listener });
  if (!session) {
    throw new Error(`Session ${sessionId} not found or could not be resumed.`);
  }

  const removeListener = () => {
    try {
      if (session && session.listeners) session.listeners.delete(listener);
    } catch (_) { /* noop */ }
  };

  const result = await Promise.race([responsePromise, timeoutPromise]);
  removeListener();
  return result;
}

/**
 * Send a message to a session and return immediately after delivery.
 * Background listener still runs finalizePlanningTurn so decision logging works.
 */
async function deliverMessage(sessionId, message, { askingSessionId, workingFiles } = {}) {
  const sessionRow = (await query(
    'SELECT id, project_id, session_type FROM sessions WHERE id = $1',
    [sessionId]
  )).rows[0];
  if (!sessionRow) throw new Error(`Session ${sessionId} not found`);

  const sessionType = sessionRow.session_type || 'implementation';
  const startTime = Date.now();

  let lastAssistantContent = '';
  let observedWorking = false;
  let resolved = false;

  let planningQuestionId = null;
  if (sessionType === 'planning') {
    const existing = await query(
      `SELECT id FROM planning_questions WHERE planning_session_id = $1 AND status = 'pending' ORDER BY asked_at DESC LIMIT 1`,
      [sessionId]
    );
    if (existing.rows.length === 0) {
      planningQuestionId = uuidv4();
      await query(
        `INSERT INTO planning_questions
           (id, project_id, planning_session_id, asking_session_id, question, working_files, status, asked_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending', NOW())`,
        [
          planningQuestionId, sessionRow.project_id, sessionId,
          askingSessionId || null, message, formatWorkingFilesField(workingFiles),
        ]
      );
    } else {
      planningQuestionId = existing.rows[0].id;
    }
  }

  let listener;
  const responsePromise = new Promise((resolve) => {
    listener = async (event) => {
      if (resolved) return;
      try {
        if (event.type === 'stream_event' && event.event && event.event.type === 'assistant') {
          const content = extractAssistantText(event.event);
          if (content) lastAssistantContent = content;
        } else if (event.type === 'session_status') {
          if (event.status === 'working') observedWorking = true;
          if (observedWorking && (event.status === 'idle' || event.status === 'ended')) {
            resolved = true;
            const text = lastAssistantContent || (await fetchLastAssistantText(sessionId));
            await finalizePlanningTurn({
              sessionId, sessionType, planningQuestionId, message, response: text,
            });
            resolve();
          }
        } else if (event.type === 'error') {
          resolved = true;
          resolve();
        }
      } catch (_) {
        if (!resolved) { resolved = true; resolve(); }
      }
    };
  });

  const session = await sessionManager.resumeSession(sessionId, message, { listener });
  if (!session) {
    throw new Error(`Session ${sessionId} not found or could not be resumed.`);
  }

  const removeListener = () => {
    try {
      if (session && session.listeners) session.listeners.delete(listener);
    } catch (_) { /* noop */ }
  };

  // Run finalization in background; don't block the caller.
  responsePromise.then(removeListener).catch((err) => {
    console.error('[deliverMessage] background finalization error:', err.message);
    removeListener();
  });

  return { sessionId, planningQuestionId };
}

function extractAssistantText(event) {
  const msg = event.message;
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  if (msg.content && Array.isArray(msg.content)) {
    return msg.content
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text || '')
      .join('\n')
      .trim();
  }
  return '';
}

async function fetchLastAssistantText(sessionId) {
  const result = await query(
    `SELECT content FROM messages
     WHERE session_id = $1 AND role = 'assistant'
     ORDER BY timestamp DESC, id DESC LIMIT 1`,
    [sessionId]
  );
  return result.rows[0]?.content || '';
}

async function finalizePlanningTurn({ sessionId, sessionType, planningQuestionId, message, response }) {
  if (sessionType !== 'planning' || !planningQuestionId) return { escalated: false };
  if (!response) return { escalated: false };

  const escalation = parseEscalation(response);
  if (escalation) {
    await query(
      `UPDATE planning_questions
         SET status = 'escalated',
             escalation_recommendation = $1,
             escalation_reason = $2,
             escalation_context = $3
       WHERE id = $4`,
      [escalation.recommendation, escalation.reason, escalation.context || null, planningQuestionId]
    );
    try {
      const websocket = require('../websocket');
      websocket.broadcastToAll({ type: 'decisions_changed', source: 'planning', questionId: planningQuestionId });
    } catch { /* websocket may not be initialized in tests */ }
    return { escalated: true };
  }

  await query(
    `UPDATE planning_questions
       SET answer = $1, status = 'answered', answered_at = NOW(), decided_by = 'planning-agent'
     WHERE id = $2`,
    [response, planningQuestionId]
  );

  // Append to the project's docs/decisions.md.
  try {
    const sessionRow = (await query(
      'SELECT s.project_id, p.name AS project_name, p.root_path, s.asking_session_id FROM sessions s JOIN projects p ON s.project_id = p.id WHERE s.id = $1',
      [sessionId]
    )).rows[0];
    if (!sessionRow) return { escalated: false };

    const planningQuestion = (await query(
      'SELECT working_files, asking_session_id FROM planning_questions WHERE id = $1',
      [planningQuestionId]
    )).rows[0];

    const filePath = decisionLog.resolveDecisionFilePath(sessionRow.root_path);
    await decisionLog.appendDecision(filePath, {
      timestamp: new Date().toISOString(),
      askingSessionId: planningQuestion?.asking_session_id || sessionRow.asking_session_id || 'unknown',
      planningSessionId: sessionId,
      workingFiles: planningQuestion?.working_files
        ? planningQuestion.working_files.split(',').map((s) => s.trim()).filter(Boolean)
        : [],
      projectName: sessionRow.project_name,
      question: message,
      answer: response,
      decidedBy: 'planning-agent',
    });
    await query(
      'UPDATE planning_questions SET logged_to_file = 1 WHERE id = $1',
      [planningQuestionId]
    );
  } catch (e) {
    console.error('[planningSessionOrchestrator] Failed to append decision log:', e.message);
  }
  return { escalated: false };
}

async function getStatus(sessionId) {
  const sessionRow = (await query(
    'SELECT id, status, session_type, created_at, ended_at FROM sessions WHERE id = $1',
    [sessionId]
  )).rows[0];
  if (!sessionRow) return null;

  // For planning sessions, the most recent planning_question can override
  // the CLI session's status: an open escalation means the session is
  // really waiting on the owner, and an owner-answered escalation means
  // the answer Claude Code should see is the owner's text, not the
  // planning agent's last assistant message.
  let escalationOverride = null;
  if (sessionRow.session_type === 'planning') {
    const pq = (await query(
      `SELECT id, status, owner_answer, decided_by
       FROM planning_questions
       WHERE planning_session_id = $1
       ORDER BY asked_at DESC
       LIMIT 1`,
      [sessionId]
    )).rows[0];
    if (pq) {
      if (pq.status === 'escalated') {
        escalationOverride = { status: 'waiting_for_owner', lastResponse: null };
      } else if (pq.status === 'answered' && pq.decided_by === 'owner' && pq.owner_answer) {
        escalationOverride = { status: 'completed', lastResponse: pq.owner_answer };
      } else if (pq.status === 'dismissed') {
        escalationOverride = { status: 'dismissed', lastResponse: 'This escalation was dismissed by the project owner.' };
      }
    }
  }

  const lastResponse = escalationOverride
    ? escalationOverride.lastResponse
    : await fetchLastAssistantText(sessionId);
  const startedAt = sessionRow.created_at ? new Date(sessionRow.created_at).getTime() : Date.now();
  const endTime = sessionRow.ended_at ? new Date(sessionRow.ended_at).getTime() : Date.now();
  return {
    sessionId,
    status: escalationOverride ? escalationOverride.status : mapSessionStatus(sessionRow.status),
    durationSeconds: Math.max(0, (endTime - startedAt) / 1000),
    lastResponse,
    sessionType: sessionRow.session_type || 'implementation',
  };
}

function mapSessionStatus(rawStatus) {
  switch (rawStatus) {
    case 'working':
    case 'reviewing':
    case 'waiting':
    case 'paused':
      return 'running';
    case 'idle':
      return 'completed';
    case 'ended':
      return 'completed';
    case 'error':
      return 'error';
    default:
      return rawStatus || 'unknown';
  }
}

module.exports = {
  startPlanningSession,
  sendAndAwait,
  deliverMessage,
  getStatus,
  buildPlanningPrompt,
  loadProjectContextFiles,
  loadExtraContextFiles,
};
