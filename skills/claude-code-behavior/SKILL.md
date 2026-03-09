---
name: claude-code-behavior
description: "Delegate coding tasks to Claude Code CLI via claude_code tool. Use when: building features, reviewing PRs, refactoring codebases, iterative coding. NOT for: simple one-liner fixes, reading code, non-coding questions."
metadata: {"openclaw":{"emoji":"🔧","requires":{"bins":["claude"]}}}
---

# Claude Code Delegation

Delegate coding tasks to **Claude Code CLI** via the `claude_code` tool.

## When to Delegate

- Building new features or apps
- Bug fixes requiring file exploration
- Refactoring large codebases
- Running tests and builds
- PR reviews (in temp dir)
- Git operations (commits, branches, PRs)

## When NOT to Delegate

- Simple one-liner fixes (use edit tool directly)
- Just reading code (use read tool)
- Non-coding questions (answer directly)

---

## Quick Reference

```
# Short task (foreground)
claude_code({ task: "Fix the typo in README.md line 42", workdir: "/home/jul/project" })

# Standard task (background)
claude_code({ task: "Add error handling to all API endpoints", workdir: "/home/jul/project", background: true })

# Check status
claude_code_status({ processId: "...", action: "poll" })

# Get output
claude_code_status({ processId: "...", action: "log" })

# Cancel
claude_code_status({ processId: "...", action: "cancel" })
```

## Tool Parameters

### claude_code

| Parameter | Type | Description |
|-----------|------|-------------|
| `task` | string (required) | The coding task to delegate |
| `workdir` | string (optional) | Absolute path to working directory |
| `maxTurns` | number (optional) | Max agent turns (default: 30) |
| `continueSession` | boolean (optional) | Resume latest session |
| `background` | boolean (optional) | Run in background, return processId |

### claude_code_status

| Parameter | Type | Description |
|-----------|------|-------------|
| `processId` | string (required) | Process ID from background launch |
| `action` | string (required) | `poll`, `log`, or `cancel` |

---

## Non-Blocking Pattern (background mode)

1. Call `claude_code` with `background: true`
2. Reply to user: "Je lance Claude Code sur cette tâche..."
3. END your turn
4. On next user message, use `claude_code_status` to check

---

## Session Management

| Scenario | Use `continueSession`? |
|----------|----------------------|
| Fix/iterate on code just written | true |
| Test/verify code just written | false (fresh session) |
| New task | false (fresh session) |

---

## Smart Retry Strategy

| Failure Type | Retry Strategy |
|---|---|
| Context overflow | Narrow scope: "Focus only on files X, Y, Z" |
| Wrong direction | Correct intent: "Stop. The user wanted X, not Y" |
| Missing info | Add context: "Auth uses JWT, see src/auth/jwt.ts" |
| CI/test failure | Attach error log: "Fix these failures: ..." |

**Max 3 retries.** After that, report the errors to the user.

---

## Safety Rules

1. Always use `maxTurns` to prevent infinite loops (10-15 for small tasks, 30-50 for features)
2. Never run in `~/.openclaw/` workspace
3. Use `background: true` for anything that might take > 2 minutes
4. Never block the user — always reply immediately after launching
