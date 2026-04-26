import { describe, it, expect } from 'vitest';
import { MCP_INSTRUCTION, buildInstructionPreamble } from '../services/mcpInstruction.js';

describe('mcpInstruction preamble', () => {
  // The Claude CLI argument parser interprets any positional argument that
  // starts with "--" as an unknown option flag and exits with an error.
  // The preamble is prepended to the FIRST user message of every implementation
  // session, so if it starts with "--" the very first message of every new
  // session crashes the CLI before Claude can respond. The user has to resend
  // to get past it (the second send is a continuation, no preamble).
  it('does not start with -- (would be parsed as a CLI flag and crash the first message)', () => {
    expect(MCP_INSTRUCTION.startsWith('--')).toBe(false);
    expect(buildInstructionPreamble().startsWith('--')).toBe(false);
  });
});
