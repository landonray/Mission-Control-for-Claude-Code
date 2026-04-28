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
const MCP_INSTRUCTION = `=== Mission Control planning instructions ===

This project is connected to Mission Control's MCP server. Mission Control exposes a planning loop you should use BEFORE asking the user product or architectural questions:

1. Look for PRODUCT.md and ARCHITECTURE.md in the project root. If either exists, consult them first — they describe the product intent and architectural decisions that previous sessions established.

2. If those documents don't exist, or don't answer your question, call the \`mc_start_session\` MCP tool with \`session_type: "planning"\` and ask the planning agent. The planning agent has full project context and is much faster than waiting on the human.

3. Use \`mc_send_message\` for follow-up questions on the same planning session. Use \`mc_get_session_status\` to check whether a long-running planning session has finished.

4. Only escalate to the user if the planning session can't resolve the question.

The user reviews planning decisions asynchronously in the Mission Control dashboard, so do not feel bad about asking — just keep questions concrete and skip ones already answered by the context documents.

=== Mission Control eval tools ===

Mission Control also exposes evals — saved quality checks that verify product behavior (not just code mechanics) and can be re-run automatically. Use them to lock in standards and catch regressions:

1. Before finishing a non-trivial change, call \`mc_run_evals\` to run all currently-armed eval folders. If failures come back, fix them before declaring the work complete.

2. When you observe a quality concern worth checking on every future change — output format, behavior consistency, regression risk — call \`mc_author_eval\` with a plain-English description. Mission Control's authoring agent drafts the structured eval, writes it to disk as a published .yaml, and validates it. Then call \`mc_arm_folder\` to activate the folder it lives in.

3. Use \`mc_list_evals\` first to see what already exists for the project so you don't author duplicates.

4. Use \`mc_edit_eval\` to tighten a rubric or fix a bad evidence source on an existing eval. Use \`mc_delete_eval\` to remove an eval that's redundant or wrong.

Authored evals are immediately live and run on every armed trigger. Be conservative — author evals for genuine product standards, not for one-off code changes that a unit test would cover.

=== end planning instructions ===

`;

function buildInstructionPreamble() {
  return MCP_INSTRUCTION;
}

module.exports = {
  MCP_INSTRUCTION,
  buildInstructionPreamble,
};
