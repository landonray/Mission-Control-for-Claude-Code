# Command Center

## Worktree Safety

When working in a git worktree (any directory under `.claude/worktrees/`), ALL file reads, edits, writes, and glob/grep operations MUST use paths within the worktree directory — never the main repo at `/Users/landonray/Coding Projects/Command Center/`.

Before editing any file, verify your working directory is the worktree, not main. If you detect you've edited a file in the main repo while a worktree is active, stop immediately and report the error.

When dispatching subagents, always include the full absolute worktree path in the prompt and explicitly instruct the subagent to work only within that path.
