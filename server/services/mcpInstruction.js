/**
 * Instruction prepended to the FIRST user message of an implementation session
 * (when the project is registered with Mission Control). Tells Claude Code how
 * and when to escalate product/architecture questions through the Mission
 * Control MCP server instead of asking the user.
 *
 * Degrades gracefully when PRODUCT.md / ARCHITECTURE.md don't exist yet — the
 * instruction simply says "if those files don't answer your question, use
 * mc_start_session", which is exactly the ferry-loop fix for projects that
 * have no context documents.
 */
const MCP_INSTRUCTION = `--- Mission Control planning instructions ---

This project is connected to Mission Control's MCP server. Mission Control exposes a planning loop you should use BEFORE asking the user product or architectural questions:

1. Look for PRODUCT.md and ARCHITECTURE.md in the project root. If either exists, consult them first — they describe the product intent and architectural decisions that previous sessions established.

2. If those documents don't exist, or don't answer your question, call the \`mc_start_session\` MCP tool with \`session_type: "planning"\` and ask the planning agent. The planning agent has full project context and is much faster than waiting on the human.

3. Use \`mc_send_message\` for follow-up questions on the same planning session. Use \`mc_get_session_status\` to check whether a long-running planning session has finished.

4. Only escalate to the user if the planning session can't resolve the question.

The user reviews planning decisions asynchronously in the Mission Control dashboard, so do not feel bad about asking — just keep questions concrete and skip ones already answered by the context documents.

--- end planning instructions ---

`;

function buildInstructionPreamble() {
  return MCP_INSTRUCTION;
}

module.exports = {
  MCP_INSTRUCTION,
  buildInstructionPreamble,
};
