import { spawn, type ChildProcess } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { BridgeConfig, PluginLogger } from "./config.js";
import type { Semaphore } from "./semaphore.js";

// ── Types ──

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
};

export type ProcessInfo = {
  id: string;
  agent: string;
  status: "running" | "completed" | "error" | "timeout" | "queued";
  task: string;
  startedAt: number;
  endedAt?: number;
  error?: string;
  stdout?: string;
  child?: ChildProcess;
  model?: string;
  usage?: TokenUsage;
  costUsd?: number;
  turnCount?: number;
  filesModified?: string[];
  outputPreview?: string;
  queuedAt?: number;
};

export type StreamEvent = {
  type: string;
  subtype?: string;
  timestamp: number;
  summary: string;
  processId?: string;
  costUsd?: number;
  turnCount?: number;
};

export type ToolDeps = {
  getConfig: () => BridgeConfig;
  agentId: string;
  logger: PluginLogger;
  semaphore: Semaphore;
  processes: Map<string, ProcessInfo>;
  pushEvent: (agentId: string, event: StreamEvent) => void;
};

// ── Schema ──

export const ClaudeCodeSchema = Type.Object(
  {
    task: Type.String({ description: "The coding task to delegate to Claude Code CLI" }),
    workdir: Type.Optional(
      Type.String({ description: "Absolute path to working directory (defaults to agent workspace)" }),
    ),
    maxTurns: Type.Optional(
      Type.Number({ description: "Maximum agent turns (default: 30, use 10-15 for small tasks, 30-50 for features)" }),
    ),
    continueSession: Type.Optional(
      Type.Boolean({ description: "Resume the latest Claude Code session (use for iterating on same code)" }),
    ),
    background: Type.Optional(
      Type.Boolean({ description: "Run in background, return processId immediately. Check status with claude_code_status tool." }),
    ),
  },
  { additionalProperties: false },
);

// ── Constants ──

const MAX_STDOUT_BYTES = 2 * 1024 * 1024; // 2MB

// ── Stream-json parsing helpers ──

function formatToolSummary(name: string, input: Record<string, unknown>): string {
  const p = (key: string) => String(input?.[key] ?? "").slice(0, 80);
  switch (name) {
    case "Read": return `Read ${p("file_path")}`;
    case "Edit": return `Edit ${p("file_path")}`;
    case "Write": return `Write ${p("file_path")}`;
    case "Bash": return `$ ${p("command")}`;
    case "Grep": return `Grep: ${p("pattern")}`;
    case "Glob": return `Glob: ${p("pattern")}`;
    case "Agent": return `Agent: ${p("description")}`;
    case "WebFetch": return `Fetch ${p("url")}`;
    case "WebSearch": return `Search: ${p("query")}`;
    case "TodoWrite": return "Todo update";
    default: return name;
  }
}

type StreamParserDeps = {
  agentId: string;
  processId: string;
  pushEvent: (agentId: string, event: StreamEvent) => void;
};

function createStreamParser(deps: StreamParserDeps) {
  const { agentId, processId, pushEvent } = deps;
  let buffer = "";

  function handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(trimmed); } catch { return; }

    const type = obj.type as string | undefined;

    if (type === "assistant") {
      const msg = obj.message as Record<string, unknown> | undefined;
      const content = msg?.content as Array<Record<string, unknown>> | undefined;
      if (!Array.isArray(content)) return;

      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          pushEvent(agentId, {
            type: "assistant",
            subtype: "text",
            timestamp: Date.now(),
            summary: block.text.slice(0, 200),
            processId,
          });
        } else if (block.type === "tool_use") {
          pushEvent(agentId, {
            type: "tool_use",
            subtype: (block.name as string) ?? "unknown",
            timestamp: Date.now(),
            summary: formatToolSummary((block.name as string) ?? "unknown", (block.input as Record<string, unknown>) ?? {}),
            processId,
          });
        }
      }
    }
    // Skip tool_result events (verbose, not useful for progress display)
  }

  return {
    feed(chunk: string): void {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);
    },
    flush(): void {
      if (buffer.trim()) handleLine(buffer);
      buffer = "";
    },
  };
}

// ── Factory ──

export function createClaudeCodeTool(deps: ToolDeps) {
  const { getConfig, agentId, logger, semaphore, processes, pushEvent } = deps;

  return {
    name: "claude_code",
    label: "Claude Code",
    description:
      "Delegate a coding task to the Claude Code CLI. Use this for ALL code creation, editing, analysis, debugging, testing, and git operations. The tool spawns a real Claude Code agent with full filesystem access.",
    parameters: ClaudeCodeSchema,

    async execute(
      toolCallId: string,
      params: { task: string; workdir?: string; maxTurns?: number; continueSession?: boolean; background?: boolean },
      signal?: AbortSignal,
    ) {
      const cfg = getConfig();
      const processId = toolCallId || `cc-${Date.now()}`;

      // Check abort before acquiring semaphore
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Task cancelled before start." }],
          details: { cancelled: true },
        };
      }

      // Register process as queued
      const proc: ProcessInfo = {
        id: processId,
        agent: agentId,
        status: "queued",
        task: params.task.slice(0, 120),
        startedAt: Date.now(),
        queuedAt: Date.now(),
        model: cfg.model,
      };
      processes.set(processId, proc);

      // Try to acquire a slot
      const release = await semaphore.acquire();

      // Flip to running
      proc.status = "running";
      proc.startedAt = Date.now();

      try {
        // Build env
        const env: Record<string, string | undefined> = { ...process.env };
        if (cfg.useProxy) {
          env.CLAUDE_CONFIG_DIR = cfg.claudeConfigDir || "/home/jul/.openclaw/claude-code-bridge-config";
          env.ANTHROPIC_BASE_URL = cfg.proxyUrl;
          env.ANTHROPIC_API_KEY = cfg.apiKey;
        }
        // Enable Claude Code Agent Teams for internal orchestration
        env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";

        // Remove NODE_OPTIONS debug flags that interfere with child
        if (env.NODE_OPTIONS?.includes("--inspect")) {
          delete env.NODE_OPTIONS;
        }

        // Build args
        const args = ["--print", "--output-format", "stream-json", "--verbose", "--permission-mode", cfg.permissionMode || "bypassPermissions"];
        if (cfg.model) args.push("--model", cfg.model);
        args.push("--max-turns", String(params.maxTurns || 30));
        if (params.continueSession) args.push("--continue");
        args.push(params.task);

        const cwd = params.workdir || process.cwd();
        const binaryPath = cfg.binaryPath || "claude";

        pushEvent(agentId, { type: "system", timestamp: Date.now(), summary: "Starting: claude_code" });
        pushEvent(agentId, { type: "tool_use", subtype: "claude_code", timestamp: Date.now(), summary: params.task.slice(0, 80) });

        // Adaptive timeout: 2 minutes per requested turn, minimum 5 minutes
        // cfg.timeoutMs > 0 acts as hard override; 0 or absent = adaptive
        const requestedTurns = params.maxTurns || 30;
        const adaptiveTimeoutMs = Math.max(300_000, requestedTurns * 120_000);
        const effectiveTimeoutMs = cfg.timeoutMs > 0 ? cfg.timeoutMs : adaptiveTimeoutMs;

        logger.info(`claude-code-bridge: spawning claude_code ${processId} for ${agentId} (timeout: ${Math.round(effectiveTimeoutMs / 1000)}s, turns: ${requestedTurns})`);

        // Background mode: spawn and return immediately
        if (params.background) {
          const { cmd, spawnArgs } = buildSpawnArgs(binaryPath, args);
          const child = spawn(cmd, spawnArgs, { cwd, stdio: ["ignore", "pipe", "pipe"], env });
          proc.child = child;

          let stdout = "";
          let stdoutBytes = 0;
          const bgParser = createStreamParser({ agentId, processId, pushEvent });

          child.stdout?.setEncoding("utf8");
          child.stderr?.setEncoding("utf8");
          child.stdout?.on("data", (chunk: string) => {
            stdoutBytes += Buffer.byteLength(chunk, "utf8");
            if (stdoutBytes <= MAX_STDOUT_BYTES) stdout += chunk;
            bgParser.feed(chunk);
          });
          child.stderr?.on("data", () => { /* discard */ });

          child.once("exit", (code) => {
            bgParser.flush();
            proc.endedAt = Date.now();
            proc.stdout = stdout;
            proc.status = code === 0 ? "completed" : "error";
            if (code !== 0) proc.error = `Exit code ${code}`;
            delete proc.child;
            release();

            // Parse JSON output for enriched data
            const parsed = parseClaudeOutput(stdout, cfg.model);
            proc.usage = parsed.usage;
            proc.costUsd = parsed.costUsd;
            proc.turnCount = parsed.turnCount;
            proc.outputPreview = parsed.outputPreview;
            proc.filesModified = parsed.filesModified;

            const elapsed = formatElapsed(proc.startedAt, proc.endedAt);
            pushEvent(agentId, {
              type: proc.status === "error" ? "tool_result" : "result",
              subtype: "claude_code",
              timestamp: Date.now(),
              summary: proc.status === "error" ? `Error (${elapsed}): exit ${code}` : `Completed (${elapsed}) $${proc.costUsd?.toFixed(2) ?? "?"}`,
              processId,
              costUsd: proc.costUsd,
              turnCount: proc.turnCount,
            });
            logger.info(`claude-code-bridge: background ${processId} ${proc.status} in ${elapsed}`);
          });

          child.once("error", (err) => {
            proc.endedAt = Date.now();
            proc.status = "error";
            proc.error = err.message;
            delete proc.child;
            release();

            pushEvent(agentId, { type: "tool_result", subtype: "claude_code", timestamp: Date.now(), summary: `Error: ${err.message}` });
          });

          return {
            content: [{ type: "text" as const, text: `Background task started. Process ID: ${processId}\nUse claude_code_status to check progress.` }],
            details: { processId, status: "running", background: true },
          };
        }

        // Foreground mode: spawn and wait with streaming events
        const fgParser = createStreamParser({ agentId, processId, pushEvent });
        const result = await runClaude({ binaryPath, args, cwd, env, timeoutMs: effectiveTimeoutMs, maxStdoutBytes: MAX_STDOUT_BYTES, signal, onStdoutChunk: (chunk) => fgParser.feed(chunk) });
        fgParser.flush();

        proc.endedAt = Date.now();
        proc.stdout = result.stdout;

        if (result.timedOut) {
          proc.status = "timeout";
          proc.error = "Timed out";
        } else if (result.exitCode !== 0) {
          proc.status = "error";
          proc.error = result.stderr || `Exit code ${result.exitCode}`;
        } else {
          proc.status = "completed";
        }

        // Parse JSON output for enriched data
        const parsed = parseClaudeOutput(result.stdout, cfg.model);
        proc.usage = parsed.usage;
        proc.costUsd = parsed.costUsd;
        proc.turnCount = parsed.turnCount;
        proc.outputPreview = parsed.outputPreview;
        proc.filesModified = parsed.filesModified;

        const elapsed = formatElapsed(proc.startedAt, proc.endedAt);
        pushEvent(agentId, {
          type: proc.status === "completed" ? "result" : "tool_result",
          subtype: "claude_code",
          timestamp: Date.now(),
          summary: proc.status === "completed" ? `Completed (${elapsed}) $${proc.costUsd?.toFixed(2) ?? "?"}` : `${proc.status} (${elapsed}): ${proc.error?.slice(0, 60) || ""}`,
          processId,
          costUsd: proc.costUsd,
          turnCount: proc.turnCount,
        });

        logger.info(`claude-code-bridge: foreground ${processId} ${proc.status} in ${elapsed}`);

        // Return readable text (not raw JSON) to the agent
        const output = parsed.textContent || result.stderr || "(no output)";
        return {
          content: [{ type: "text" as const, text: output }],
          details: { processId, exitCode: result.exitCode, durationMs: proc.endedAt - proc.startedAt, status: proc.status },
        };
      } finally {
        // Release semaphore for foreground mode (background releases on exit)
        if (!params.background) release();
      }
    },
  };
}

// ── Subprocess helpers ──

/** Wrap command in systemd-run --scope to escape gateway cgroup memory limits */
function buildSpawnArgs(binaryPath: string, args: string[]): { cmd: string; spawnArgs: string[] } {
  // Use systemd-run to isolate child process memory from gateway cgroup
  return {
    cmd: "systemd-run",
    spawnArgs: [
      "--user", "--scope",
      "--property=MemoryMax=2G",
      "--quiet",
      "--", binaryPath, ...args,
    ],
  };
}

// ── Subprocess runner ──

function runClaude(params: {
  binaryPath: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  maxStdoutBytes: number;
  signal?: AbortSignal;
  onStdoutChunk?: (chunk: string) => void;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const { cmd, spawnArgs } = buildSpawnArgs(params.binaryPath, params.args);
    const child = spawn(cmd, spawnArgs, {
      cwd: params.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: params.env,
    });

    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let settled = false;
    let timedOut = false;

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > params.maxStdoutBytes) {
        stdout += "\n[OUTPUT TRUNCATED - exceeded 2MB limit]";
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        return;
      }
      stdout += chunk;
      params.onStdoutChunk?.(chunk);
    });

    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 100_000) stderr = stderr.slice(-50_000); // keep tail
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => {
        try { if (!child.killed) child.kill("SIGKILL"); } catch { /* ignore */ }
      }, 5000);
    }, params.timeoutMs);

    if (params.signal) {
      if (params.signal.aborted) {
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
      } else {
        params.signal.addEventListener("abort", () => {
          try { child.kill("SIGTERM"); } catch { /* ignore */ }
        }, { once: true });
      }
    }

    child.once("error", (err) => {
      stderr += `\nSpawn error: ${err.message}`;
      settle(1);
    });

    child.once("exit", (code) => {
      settle(code);
    });
  });
}

// ── Claude JSON output parser ──

const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  sonnet: { input: 3, output: 15 },
  opus: { input: 5, output: 25 },
  haiku: { input: 1, output: 5 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

type ClaudeJsonOutput = {
  type?: string;
  subtype?: string;
  result?: string;
  is_error?: boolean;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
  modelUsage?: Record<string, {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    costUSD?: number;
  }>;
};

function parseClaudeOutput(raw: string, model: string): {
  usage?: TokenUsage;
  costUsd?: number;
  turnCount?: number;
  outputPreview?: string;
  filesModified?: string[];
  textContent?: string;
} {
  if (!raw) return {};
  let parsed: ClaudeJsonOutput | undefined;

  // Try single JSON first (--output-format json)
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Stream-json format (NDJSON): find the last "result" line
    const lines = raw.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "result") {
          parsed = {
            type: obj.type,
            subtype: obj.subtype,
            result: obj.result,
            is_error: obj.is_error,
            num_turns: obj.num_turns,
            total_cost_usd: obj.total_cost_usd,
            usage: obj.usage,
            modelUsage: obj.modelUsage,
          };
          break;
        }
      } catch { continue; }
    }
  }

  if (!parsed) {
    return { outputPreview: raw.slice(0, 500), textContent: raw };
  }

  const turnCount = parsed.num_turns ?? 0;

  // Get usage from modelUsage (aggregated) or fallback to top-level usage
  const modelUsageEntry = parsed.modelUsage ? Object.values(parsed.modelUsage)[0] : undefined;
  const usage: TokenUsage = modelUsageEntry ? {
    inputTokens: modelUsageEntry.inputTokens ?? 0,
    outputTokens: modelUsageEntry.outputTokens ?? 0,
    cacheCreationTokens: modelUsageEntry.cacheCreationInputTokens ?? 0,
    cacheReadTokens: modelUsageEntry.cacheReadInputTokens ?? 0,
  } : {
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
    cacheCreationTokens: parsed.usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: parsed.usage?.cache_read_input_tokens ?? 0,
  };

  // Use total_cost_usd from CLI if available, otherwise compute
  let costUsd = parsed.total_cost_usd;
  if (costUsd == null) {
    const pricing = MODEL_PRICING[model] ?? MODEL_PRICING["sonnet"];
    costUsd =
      (usage.inputTokens * pricing.input) / 1_000_000 +
      (usage.outputTokens * pricing.output) / 1_000_000 +
      (usage.cacheReadTokens * pricing.input * 0.1) / 1_000_000 +
      (usage.cacheCreationTokens * pricing.input * 0.25) / 1_000_000;
  }

  // Text is in the "result" field (string), not content[] array
  const fullText = parsed.result ?? "";

  const filePattern = /(?:Created|Modified|Edited|Wrote|Updated|Deleted|created|wrote)\s+[`"']?([/\w._-]+\.\w{1,10})[`"']?/g;
  const filesSet = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = filePattern.exec(fullText)) !== null) {
    filesSet.add(match[1]);
  }

  return {
    usage,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    turnCount,
    outputPreview: fullText.slice(0, 500),
    filesModified: filesSet.size > 0 ? [...filesSet] : undefined,
    textContent: fullText,
  };
}

// ── Helpers ──

function formatElapsed(startMs: number, endMs?: number): string {
  const ms = (endMs ?? Date.now()) - startMs;
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

export { formatElapsed };
