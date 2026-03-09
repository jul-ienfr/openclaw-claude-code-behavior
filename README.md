# Claude Code Bridge for OpenClaw

Delegates coding tasks to the real **Claude Code CLI**, running as a subprocess inside OpenClaw agents. One tool, full autonomy, parallel execution, Studio V2 live view.

## How it works

```
User → OpenClaw Agent (studio-dev / dev-ops)
  → Agent calls claude_code tool
    → Plugin spawns Claude Code CLI as subprocess
    → Claude Code works autonomously (read, edit, bash, git, tests...)
    → Returns structured result (session_id, cost, summary)
  → Agent presents result to user
```

No behavioral injection. No custom tools. Just the real Claude Code.

## Installation

```bash
# Clone
git clone https://github.com/jul-ienfr/openclaw-claude-code-behavior
cd openclaw-claude-code-behavior
npm install

# Link to OpenClaw
openclaw plugins install -l /path/to/openclaw-claude-code-behavior
```

**Requires**: Claude Code CLI installed (VS Code extension or `npm install -g @anthropic-ai/claude-code`)

## Configuration

Edit `config.json`:

```json
{
  "agents": ["studio-dev", "dev-ops"],
  "proxyUrl": "http://127.0.0.1:18080",
  "apiKey": "proxy",
  "model": "sonnet",
  "permissionMode": "auto",
  "maxBudgetUsd": 1.00,
  "timeoutMs": 300000,
  "maxConcurrent": 3,
  "useProxy": true
}
```

| Key | Description |
|-----|-------------|
| `agents` | Agent IDs that get the `claude_code` tool |
| `useProxy` | `true` = route through proxy (multi-account rotation), `false` = Claude Code's own auth |
| `maxConcurrent` | Max parallel Claude Code processes |
| `maxBudgetUsd` | Max spend per task in USD |
| `timeoutMs` | Task timeout (default 5 min) |

## Usage

The agent automatically delegates coding tasks to Claude Code:

```
User: "Fix the auth bug in src/auth.ts"
Agent → claude_code task:"Fix the auth bug in src/auth.ts" cwd:"/project"
Claude Code: reads file, finds bug, edits, runs tests
Agent: "Fixed the null check on line 42. Tests pass."
```

### Background mode (parallel tasks)

```
claude_code task:"Run full test suite" background:true
→ { process_id: "abc123", status: "running" }

claude_code action:"status" process_id:"abc123"
→ { status: "completed", result: "All 47 tests pass", cost: 0.04 }
```

### Session resume (multi-turn)

```
claude_code task:"Refactor auth module" → needs clarification
claude_code task:"Use JWT, not sessions" resume:true session_id:"uuid"
```

## Studio V2 Integration

The plugin exposes HTTP endpoints for a live Claude Code view:

- `GET /plugins/claude-code-bridge/events/:agentId` — SSE stream (real-time events)
- `GET /plugins/claude-code-bridge/status` — Active processes
- `GET /plugins/claude-code-bridge/config` — Current config
- `PATCH /plugins/claude-code-bridge/config` — Toggle proxy, change model

## Architecture

```
openclaw-claude-code-bridge/
├── index.ts                     # 1 tool + 1 hook + 3 HTTP routes
├── lib/config.ts                # Typed config loader
├── tools/claude-code.ts         # Bridge tool (spawn, stream, manage)
├── config.json                  # Runtime config
├── skills/claude-code-behavior/
│   ├── SKILL.md                 # Documentation
│   └── INJECT.md                # Agent delegation instructions
├── openclaw.plugin.json
├── package.json
├── LICENSE
└── README.md
```

## License

MIT
