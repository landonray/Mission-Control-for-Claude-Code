# About Me
I am a product leader, not a developer. I understand architecture and product deeply but do not read code. Always communicate with me accordingly.

# Communication Style
- Explain what you are doing and why in plain conversational English as you work
- Avoid technical jargon, bash command narration, and developer-speak
- Talk to me like a smart colleague explaining their work, not a developer logging their terminal session
- When you hit a problem, explain what the problem is and how you plan to solve it in plain English before diving in
- Never show me code in your explanations unless I specifically ask for it

# Project Setup
- Database: Neon Postgres via DATABASE_URL environment variable — never create a local or alternative database.
- Auth: Google OAuth via environment variables — never implement a different auth system
- All secrets come from environment variables — never hardcode credentials
- For any LLM calls, you'll use my LLM Gateway which has an API key in the env and docs are in a file in the repo.

# How to Start a Session
- Read this CLAUDE.md fully before doing anything
- Understand the current state of the codebase before making any changes
- Ask me what I want to work on if it isn't clear

# How to Work
- Before starting any significant task, briefly explain your plan in plain English and confirm I'm aligned
- Work autonomously once I've confirmed — don't check in constantly for small decisions
- If you hit something unexpected that changes the plan significantly, stop and tell me in plain English before proceeding

---

# Server and Port Management

**CRITICAL: Never kill servers belonging to other projects. This machine runs multiple projects simultaneously.**

You MAY stop and restart the dev server for the project you are currently working on. That includes killing and restarting the process on this project's port — even if you didn't start it in this session. If I ask you to restart the server, or if you made backend changes that require a restart, just do it.

You MUST NOT kill or interfere with any process running on a port that does not belong to this project. Other servers on this machine are other projects and must not be touched.

When starting a dev server:
1. Check if there is a PORT value already set in .env — if so, use that port (it's this project's port)
2. If no PORT is set, pick a random port between 4100–4999
3. Check that the port is free before using it (lsof -i :PORT)
4. If the port is occupied and it is NOT this project's server, pick a different port
5. Write the chosen port to .env as PORT=XXXX so it stays consistent across sessions
6. Report the full running URL to me (e.g., http://localhost:4237) — never say just "the server is running"

How to tell if a process belongs to this project: check the command/path shown by `lsof -i :PORT` — if it's running from this project's directory, it's yours to manage. If it's running from a different directory, leave it alone.

**CRITICAL: Do NOT send false "server exited" alarms after restarting the server.** When you kill an old server process and start a new one, you will receive a delayed background notification that a process exited. That is the OLD process you just killed — not the new server crashing. Do NOT react to this notification by telling the user the server died. If you receive a process-exit notification after a restart, silently verify the server is still running (e.g., check the port) before saying anything. Never send a panicked message like "the server process exited" without first confirming there is actually a problem.

---

# Testing Requirements

## Unit Tests
- Every new module, utility function, or service must have unit tests written alongside it
- When modifying existing code, check if tests exist — if they do, update them; if they don't, add them
- Run all unit tests after every task and fix any failures before reporting done
- Use the testing framework already established in the project (check package.json or requirements). If none exists, set up a standard one (Vitest for JS/TS, pytest for Python) and document it

## Frontend / Integration Tests
- Every new page, component, or user-facing feature must have at least basic integration tests
- Tests should verify that the feature renders, responds to user interaction, and handles error states
- Use the integration testing framework already in the project. If none exists, set up Playwright and document it

## Test Quality Rules
- Tests must actually assert meaningful behavior — not just "it renders without crashing"
- Tests must cover the happy path AND at least one error/edge case
- Never delete or skip existing tests to make a task pass. If a test is failing because of your changes, fix the code or update the test to match the new correct behavior — and explain what changed
- If a task is complex enough to have a spec, review the spec line by line and make sure there is a test for each requirement

---

# Links and URLs

Every URL you share with me must be complete and clickable:
- Server URLs: full address with port (e.g., http://localhost:4237 — never just "the server is running")
- GitHub URLs: full https link (e.g., https://github.com/landonray/project-name/pull/12 — never just "I created a PR")
- File paths: full path from project root
- Database URLs: full connection string reference (e.g., "the Neon database at the DATABASE_URL in your .env")
- Deployed URLs: full address (e.g., https://my-app.vercel.app)

If you reference something that has a URL, give me the URL. No exceptions.

---

# Keeping Me in the Loop

I can't see what you're doing behind the scenes. If something happened that I need to know about — or that requires action from me — you must tell me explicitly. Never say "nothing for you to do" or "you're all set" without checking this list first.

After completing work, always check whether any of these apply and tell me:

- **Commits:** Did you commit? If not, tell me I need to commit (and what the message should be). If you did commit, say so.
- **Push/Pull:** Did you push? Do I need to push? Do I need to pull on another machine?
- **Branches and merging:** What branch are you on? Does it need to be merged? Is there a PR I need to review?
- **PR created:** Give me the full URL and tell me what to do with it (review, merge, etc.)
- **Server restarts:** Do I need to restart the dev server for changes to take effect? 
- **Environment changes:** Did you add or change any environment variables? Tell me exactly what to add to .env.
- **Dependency installs:** Did you add new packages? Tell me if I need to run npm install or pip install.
- **Deployments:** Does anything need to be deployed? Tell me how.
- **External service actions:** Does anything need to happen outside the codebase (DNS, dashboard settings, third-party config)?

Format these as a clear **"What you need to know / do"** section at the end of your completion summary. If you genuinely handled everything and there's nothing for me, say that — but check carefully first.

---

# Quality Checks — Run After Every Task
- Review the code you wrote for quality, bugs, and security issues
- Check that your changes integrate cleanly with the existing architecture
- Run all unit and integration tests and fix any failures before telling me you're done
- Confirm that nothing you changed broke something that was already working
- **CRITICAL: After ANY backend change (server/, shared/schema.ts, or anything that affects the server), you MUST restart the dev server to pick up the changes. The tsx runtime does NOT auto-reload. Kill the existing server process on this project's port and restart it — do not wait for me to do this manually.**
- Report what you found in plain English before marking the task complete

# Definition of Done
A task is not done until:
- All features in the spec are implemented — review the original request line by line
- All new code has tests (unit and integration where applicable)
- Quality checks above are complete
- No known bugs or broken tests
- You have told me what you built, what you checked, and anything I should know
- You have completed the "What you need to know / do" checklist (see Keeping Me in the Loop)

# Git
- Always make sure .env and .env.* are in .gitignore before committing anything
- Never commit secrets or credentials
- Write clear commit messages in plain English describing what changed and why
- Always work on a feature branch — never commit directly to main
- When a task is complete, create a PR with a clear description and give me the full GitHub URL

# Worktree Safety
When working in a git worktree (any directory under .claude/worktrees/), ALL file reads, edits, writes, and glob/grep operations MUST use paths within the worktree directory — never the main repo at /Users/landonray/Coding Projects/[current_project].
Before editing any file, verify your working directory is the worktree, not main. If you detect you've edited a file in the main repo while a worktree is active, stop immediately and report the error.
When dispatching subagents, always include the full absolute worktree path in the prompt and explicitly instruct the subagent to work only within that path.

# What I'm Building
[Claude to descript the app here — what it does, who uses it, what problem it solves]

# Architecture
[Claude will fill this in after exploring the codebase]

# Key Files and Structure
[Claude will fill this in after exploring the codebase]

# How to Run the App
[Claude will fill this in after exploring the codebase — must include full URLs with ports]

# Known Issues and Trade-offs
[Claude to keep a list of known issues, technical debt, and intentional trade-offs]
