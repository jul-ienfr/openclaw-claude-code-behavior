import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { ServerResponse } from "http";
import * as fs from "fs";
import * as path from "path";
import { loadConfig, getRuntimeConfig, setRuntimeConfig } from "./lib/config.js";
import { Semaphore } from "./lib/semaphore.js";
import { createClaudeCodeTool, formatElapsed, type ProcessInfo, type StreamEvent } from "./lib/tool.js";
import { createClaudeCodeStatusTool } from "./lib/process-tool.js";

// ── In-memory state ──

const processes = new Map<string, ProcessInfo>();
const agentEvents = new Map<string, StreamEvent[]>();
const sseClients = new Map<string, Set<ServerResponse>>();

const MAX_EVENTS = 200;
const PROCESS_TTL_MS = 5 * 60 * 1000;

function pushEvent(agentId: string, event: StreamEvent): void {
  let events = agentEvents.get(agentId);
  if (!events) {
    events = [];
    agentEvents.set(agentId, events);
  }
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);

  const clients = sseClients.get(agentId);
  if (clients) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of clients) {
      try { res.write(data); } catch { clients.delete(res); }
    }
  }
}

function pruneOldProcesses(): void {
  const cutoff = Date.now() - PROCESS_TTL_MS;
  for (const [id, p] of processes) {
    if (p.status !== "running" && p.status !== "queued" && (p.endedAt ?? p.startedAt) < cutoff) {
      processes.delete(id);
    }
  }
}

// ── Guidance for agents ──

const CLAUDE_CODE_GUIDANCE = `# Claude Code Delegation Protocol — MANDATORY

**CRITICAL: You MUST use the \`claude_code\` tool for ANY task that involves code, files, system commands, debugging, or investigation.**

This is NON-NEGOTIABLE. You are a delegation agent. Claude Code is your hands.
You NEVER spawn subagents. You NEVER use sessions_spawn. You delegate EVERYTHING to claude_code.

## What MUST go through claude_code
- Creating, editing, reading, or deleting ANY file
- Running ANY shell command (builds, tests, git, npm, curl, etc.)
- Fixing bugs, building features, refactoring
- Exploring codebases (grep, find, ls, cat)
- Investigating issues, debugging, auditing code
- Multi-step tasks — delegate the ENTIRE task as ONE claude_code call
- Tasks that involve multiple files or repos — ONE claude_code call with a detailed task description
- ANY task the user asks you to do that is not purely conversational

## ABSOLUTELY FORBIDDEN — NEVER do these under ANY circumstance
1. NEVER use \`edit\`, \`write\`, or \`apply_patch\` — delegate to \`claude_code\`
2. NEVER use \`exec\` or \`process\` — delegate to \`claude_code\`
3. **NEVER use \`sessions_spawn\` or \`subagents\` — ALWAYS use \`claude_code\` instead. There is NO valid reason to spawn a subagent. This includes tasks you think are "not code" — use claude_code anyway.**
4. NEVER write code snippets in your replies for the user to copy — delegate to \`claude_code\`
5. You MAY use \`read\` ONLY to show file content to the user (never to prepare an edit)
6. If you are tempted to use ANY tool other than \`claude_code\`, \`claude_code_status\`, or \`read\` — STOP and use \`claude_code\` instead

## Usage

**Short tasks (< 5 min):**
\`\`\`
claude_code({ task: "Fix the display bug in AgentChatPanel.tsx where inter-agent messages show as 'You' instead of the agent name. The file is in /home/jul/code/openclaw-studio-v2/src/features/agents/components/", workdir: "/home/jul/code/openclaw-studio-v2" })
\`\`\`

**Long tasks (background):**
\`\`\`
claude_code({ task: "Refactor the auth module and run tests", workdir: "/home/jul/project", background: true })
\`\`\`
Then poll: \`claude_code_status({ processId: "...", action: "poll" })\`
Get output: \`claude_code_status({ processId: "...", action: "log" })\`

## Non-Blocking Pattern (background mode)
1. Call \`claude_code\` with \`background: true\`
2. Reply to user: "Je lance Claude Code sur cette tâche..."
3. END your turn immediately
4. On next user message, use \`claude_code_status\` to check/retrieve

## Task Description Best Practices
- Be SPECIFIC: include file paths, function names, expected behavior
- Include CONTEXT: what the code does, what's broken, what the fix should do
- For multi-file tasks: describe the full scope in one task description
- Let Claude Code figure out the implementation — don't micro-manage steps

## Session Management
- **Fix/iterate on same code**: use \`continueSession: true\`
- **New task or test/verify**: omit continueSession (fresh session)
- Max 3 retries on failure
`;

// ── Plugin registration ──

export default function register(api: OpenClawPluginApi): void {
  const pluginDir = path.dirname(new URL(import.meta.url).pathname);

  // ── Config ──
  const config = loadConfig(pluginDir, api.logger);
  const targetAgents = config.agents.length > 0 ? new Set(config.agents) : null;
  setRuntimeConfig(config);

  // ── Semaphore ──
  const semaphore = new Semaphore(config.maxConcurrent);

  // ── Tool: claude_code ──
  api.registerTool((ctx) => {
    const agentId = ctx.agentId ?? "unknown";
    if (targetAgents && !targetAgents.has(agentId)) return null;

    return createClaudeCodeTool({
      getConfig: getRuntimeConfig,
      agentId,
      logger: api.logger,
      semaphore,
      processes,
      pushEvent,
    });
  }, { name: "claude_code" });

  // ── Tool: claude_code_status ──
  api.registerTool((ctx) => {
    const agentId = ctx.agentId ?? "unknown";
    if (targetAgents && !targetAgents.has(agentId)) return null;

    return createClaudeCodeStatusTool({
      processes,
      pushEvent,
      agentId,
      logger: api.logger,
    });
  }, { name: "claude_code_status" });

  // ── Hook: inject guidance for target agents ──
  api.on("before_prompt_build", async (_event, ctx) => {
    const agentId = ctx.agentId ?? "default";
    if (targetAgents && !targetAgents.has(agentId)) return;

    return { prependSystemContext: CLAUDE_CODE_GUIDANCE };
  });

  // ── Hook: capture LLM output for SSE streaming ──
  api.on("llm_output", async (event, ctx) => {
    const agentId = ctx.agentId ?? "unknown";
    if (targetAgents && !targetAgents.has(agentId)) return;
    if (!sseClients.get(agentId)?.size) return;

    const text = (event.assistantTexts ?? []).join("").slice(0, 120);
    if (!text) return;

    pushEvent(agentId, { type: "assistant", timestamp: Date.now(), summary: text });
  });

  // ── HTTP: config GET/PATCH ──
  api.registerHttpRoute({
    path: "/plugins/claude-code-bridge/config",
    match: "exact",
    auth: "gateway",
    handler: async (req, res) => {
      if (req.method === "GET") {
        const cfg = getRuntimeConfig();
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ useProxy: cfg.useProxy, proxyUrl: cfg.proxyUrl, model: cfg.model, maxConcurrent: cfg.maxConcurrent, agents: cfg.agents }));
        return true;
      }

      if (req.method === "PATCH" || req.method === "POST") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString());

        const cfg = getRuntimeConfig();
        if (typeof body.useProxy === "boolean") cfg.useProxy = body.useProxy;
        if (typeof body.model === "string") cfg.model = body.model;
        if (typeof body.maxConcurrent === "number") cfg.maxConcurrent = body.maxConcurrent;
        setRuntimeConfig(cfg);

        try {
          const configPath = path.join(pluginDir, "config.json");
          const disk = JSON.parse(fs.readFileSync(configPath, "utf-8"));
          disk.useProxy = cfg.useProxy;
          disk.model = cfg.model;
          disk.maxConcurrent = cfg.maxConcurrent;
          fs.writeFileSync(configPath, JSON.stringify(disk, null, 2) + "\n");
        } catch (e) {
          api.logger.warn(`claude-code-bridge: failed to persist config: ${e}`);
        }

        api.logger.info(`claude-code-bridge: config updated & saved — proxy: ${cfg.useProxy}, model: ${cfg.model}`);
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ useProxy: cfg.useProxy, proxyUrl: cfg.proxyUrl, model: cfg.model, maxConcurrent: cfg.maxConcurrent, agents: cfg.agents }));
        return true;
      }

      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, PATCH, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" });
        res.end();
        return true;
      }

      res.writeHead(405);
      res.end("Method not allowed");
      return true;
    },
  });

  // ── HTTP: status GET ──
  api.registerHttpRoute({
    path: "/plugins/claude-code-bridge/status",
    match: "exact",
    auth: "gateway",
    handler: async (req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" });
        res.end();
        return true;
      }

      pruneOldProcesses();
      const cfg = getRuntimeConfig();
      const list = [...processes.values()].map((p) => ({
        id: p.id,
        agent: p.agent,
        status: p.status,
        task: p.task,
        startedAt: p.startedAt,
        endedAt: p.endedAt,
        elapsed: formatElapsed(p.startedAt, p.endedAt),
        error: p.error,
        model: p.model,
        usage: p.usage,
        costUsd: p.costUsd,
        turnCount: p.turnCount,
        filesModified: p.filesModified,
        outputPreview: p.outputPreview,
        queuedAt: p.queuedAt,
      }));

      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        processes: list,
        queue: {
          running: semaphore.running,
          available: semaphore.available,
          waiting: semaphore.queueLength,
          max: cfg.maxConcurrent,
        },
      }));
      return true;
    },
  });

  // ── HTTP: cancel POST ──
  api.registerHttpRoute({
    path: "/plugins/claude-code-bridge/cancel",
    match: "exact",
    auth: "gateway",
    handler: async (req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" });
        res.end();
        return true;
      }
      if (req.method !== "POST") { res.writeHead(405); res.end(); return true; }

      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const { processId } = JSON.parse(Buffer.concat(chunks).toString());

      const proc = processes.get(processId);
      if (!proc) {
        res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "not_found" }));
        return true;
      }
      if (proc.status !== "running" || !proc.child) {
        res.writeHead(400, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "not_running", status: proc.status }));
        return true;
      }
      try { proc.child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { try { if (proc.child && !proc.child.killed) proc.child.kill("SIGKILL"); } catch { /* ignore */ } }, 5000);

      pushEvent(proc.agent, { type: "system", timestamp: Date.now(), summary: `Cancelled: ${proc.task.slice(0, 60)}`, processId });
      api.logger.info(`claude-code-bridge: cancelled process ${processId} via HTTP`);

      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({ ok: true }));
      return true;
    },
  });

  // ── HTTP: output GET ──
  api.registerHttpRoute({
    path: "/plugins/claude-code-bridge/output",
    match: "exact",
    auth: "gateway",
    handler: async (req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" });
        res.end();
        return true;
      }

      const url = new URL(req.url ?? "", "http://localhost");
      const processId = url.searchParams.get("id");
      const proc = processId ? processes.get(processId) : undefined;
      if (!proc) {
        res.writeHead(404, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ error: "not_found" }));
        return true;
      }

      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(JSON.stringify({
        id: proc.id,
        status: proc.status,
        output: proc.outputPreview ?? proc.stdout ?? "(no output)",
        filesModified: proc.filesModified ?? [],
        usage: proc.usage,
        costUsd: proc.costUsd,
        turnCount: proc.turnCount,
      }));
      return true;
    },
  });

  // ── HTTP: events SSE ──
  api.registerHttpRoute({
    path: "/plugins/claude-code-bridge/events",
    match: "prefix",
    auth: "gateway",
    handler: async (req, res) => {
      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" });
        res.end();
        return true;
      }

      const url = new URL(req.url ?? "", "http://localhost");
      const parts = url.pathname.split("/");
      const agentId = parts[parts.length - 1] || "studio-dev";

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" });

      const recent = agentEvents.get(agentId) ?? [];
      for (const ev of recent.slice(-20)) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }

      let clients = sseClients.get(agentId);
      if (!clients) {
        clients = new Set();
        sseClients.set(agentId, clients);
      }
      clients.add(res);

      const keepalive = setInterval(() => {
        try { res.write(":keepalive\n\n"); } catch { /* closed */ }
      }, 15000);

      req.on("close", () => {
        clearInterval(keepalive);
        clients!.delete(res);
      });

      return true;
    },
  });

  // ── Startup log ──
  const scope = targetAgents ? `agents: [${[...targetAgents].join(", ")}]` : "all agents";
  api.logger.info(`claude-code-bridge: loaded — 2 tools + 5 HTTP routes (${scope})`);
}
