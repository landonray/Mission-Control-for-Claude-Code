/**
 * Decision Chat Service
 *
 * Provides helpers for the LLM thinking-partner interface on escalated decisions.
 * Builds system prompts that contextualize the decision with project docs,
 * sends chat turns, and drafts final answers with reasoning.
 */

import llmGateway from './llmGateway.js';
const { chatCompletion } = llmGateway;

const MAX_DOC_CHARS = 12000;
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 1500;

/**
 * Truncate text to a maximum length, appending a marker if truncated.
 * @param {string} text
 * @param {number} [max] - Maximum characters (default 12000)
 * @returns {string}
 */
function truncate(text, max = MAX_DOC_CHARS) {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + '\n\n[truncated]';
}

/**
 * Build a system prompt for the LLM thinking partner.
 * Includes the escalated question, planning agent's recommendation, context,
 * and relevant project documentation.
 *
 * @param {object} question - Escalated decision question
 * @param {string} question.question - The decision being escalated
 * @param {string} question.escalation_context - Context why it was escalated
 * @param {string} question.escalation_recommendation - Planning agent's recommendation
 * @param {string} question.escalation_reason - Why it was escalated
 * @param {Array<string>} [question.working_files] - Files involved
 * @param {object} docs - Project documentation
 * @param {string} [docs.productMd] - PRODUCT.md content
 * @param {string} [docs.architectureMd] - ARCHITECTURE.md content
 * @param {string} [docs.decisionsMd] - decisions.md content
 * @returns {string} System prompt
 */
export function buildSystemPrompt(question, docs) {
  const wf = (question.working_files || []).join(', ') || '(none)';
  return [
    'You are helping the project owner think through an escalated decision.',
    'Be concise. Push back if their reasoning seems off. Default to recommending what the planning agent recommended unless the owner gives you a reason to deviate.',
    '',
    '## The escalated question',
    question.question,
    '',
    '## Planning agent recommendation',
    question.escalation_recommendation || '(none)',
    '',
    '## Why escalated',
    question.escalation_reason || '(none)',
    '',
    '## Context the planning agent had',
    question.escalation_context || '(none)',
    '',
    '## Working files',
    wf,
    '',
    '## Project PRODUCT.md',
    truncate(docs.productMd),
    '',
    '## Project ARCHITECTURE.md',
    truncate(docs.architectureMd),
    '',
    '## Project decisions.md',
    truncate(docs.decisionsMd),
  ].join('\n');
}

/**
 * Send a single chat turn to the LLM.
 *
 * @param {object} opts
 * @param {object} [opts.llmGateway] - LLM Gateway instance (for testing)
 * @param {string} opts.systemPrompt - System prompt built by buildSystemPrompt
 * @param {Array<object>} opts.messages - Chat history [{role, content}, ...]
 * @param {string} [opts.model] - Model ID (default: claude-sonnet-4-6)
 * @param {number} [opts.maxTokens] - Max output tokens (default: 1500)
 * @returns {Promise<string>} The assistant's response
 */
export async function sendChatTurn({
  llmGateway = { chatCompletion },
  systemPrompt,
  messages,
  model = DEFAULT_MODEL,
  maxTokens = DEFAULT_MAX_TOKENS,
}) {
  return llmGateway.chatCompletion({
    system: systemPrompt,
    messages,
    model,
    max_tokens: maxTokens,
  });
}

/**
 * Draft a final answer to the escalated decision.
 * Asks the LLM to summarize the chat conversation into a final answer and reasoning.
 *
 * @param {object} opts
 * @param {object} [opts.llmGateway] - LLM Gateway instance (for testing)
 * @param {string} opts.systemPrompt - System prompt
 * @param {Array<object>} opts.messages - Full chat history
 * @param {string} [opts.model] - Model ID (default: claude-sonnet-4-6)
 * @returns {Promise<{ answer: string, reasoning_summary: string }>}
 */
export async function draftFinalAnswer({
  llmGateway = { chatCompletion },
  systemPrompt,
  messages,
  model = DEFAULT_MODEL,
}) {
  const draftPrompt = [
    ...messages,
    {
      role: 'user',
      content: 'Based on this conversation, write a final answer for the planning agent in 1-3 sentences. Then on a new line starting with "REASONING:" write a 1-2 sentence summary of why we chose this answer. Do not add any other text.',
    },
  ];

  const raw = await llmGateway.chatCompletion({
    system: systemPrompt,
    messages: draftPrompt,
    model,
    max_tokens: 600,
  });

  const reasoningIdx = raw.indexOf('REASONING:');
  if (reasoningIdx === -1) {
    return { answer: raw.trim(), reasoning_summary: '' };
  }

  return {
    answer: raw.slice(0, reasoningIdx).trim(),
    reasoning_summary: raw.slice(reasoningIdx + 'REASONING:'.length).trim(),
  };
}
