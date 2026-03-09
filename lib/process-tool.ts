import { Type } from "@sinclair/typebox";
import type { PluginLogger } from "./config.js";
import type { ProcessInfo, StreamEvent } from "./tool.js";
import { formatElapsed } from "./tool.js";

// ── Schema ──

export const ClaudeCodeStatusSchema = Type.Object(
  {
    processId: Type.String({ description: "The process ID returned by claude_code in background mode" }),
    action: Type.Union(
      [
        Type.Literal("poll", { description: "Check if the process is still running" }),
        Type.Literal("log", { description: "Get the captured output of a completed process" }),
        Type.Literal("cancel", { description: "Cancel a running process" }),
      ],
      { description: "Action to perform: poll (check status), log (get output), cancel (stop process)" },
    ),
  },
  { additionalProperties: false },
);

// ── Types ──

type StatusToolDeps = {
  processes: Map<string, ProcessInfo>;
  pushEvent: (agentId: string, event: StreamEvent) => void;
  agentId: string;
  logger: PluginLogger;
};

// ── Factory ──

export function createClaudeCodeStatusTool(deps: StatusToolDeps) {
  const { processes, pushEvent, agentId, logger } = deps;

  return {
    name: "claude_code_status",
    label: "Claude Code Status",
    description:
      "Check status, get output, or cancel a background Claude Code process. Use after launching claude_code with background: true.",
    parameters: ClaudeCodeStatusSchema,

    async execute(
      _toolCallId: string,
      params: { processId: string; action: "poll" | "log" | "cancel" },
    ) {
      const proc = processes.get(params.processId);

      if (!proc) {
        return {
          content: [{ type: "text" as const, text: `Process ${params.processId} not found. It may have expired (processes are kept for 5 minutes after completion).` }],
          details: { error: "not_found" },
        };
      }

      switch (params.action) {
        case "poll": {
          const elapsed = formatElapsed(proc.startedAt, proc.endedAt);
          const info = {
            processId: proc.id,
            status: proc.status,
            task: proc.task,
            elapsed,
            agent: proc.agent,
            error: proc.error,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
            details: info,
          };
        }

        case "log": {
          if (proc.status === "running") {
            return {
              content: [{ type: "text" as const, text: `Process ${proc.id} is still running (${formatElapsed(proc.startedAt)}). Poll again later.` }],
              details: { status: "running" },
            };
          }
          const output = proc.stdout || proc.error || "(no output captured)";
          return {
            content: [{ type: "text" as const, text: output }],
            details: { status: proc.status, exitCode: proc.error ? 1 : 0 },
          };
        }

        case "cancel": {
          if (proc.status !== "running" || !proc.child) {
            return {
              content: [{ type: "text" as const, text: `Process ${proc.id} is not running (status: ${proc.status}).` }],
              details: { status: proc.status },
            };
          }
          try {
            proc.child.kill("SIGTERM");
            setTimeout(() => {
              try { if (proc.child && !proc.child.killed) proc.child.kill("SIGKILL"); } catch { /* ignore */ }
            }, 5000);
          } catch { /* ignore */ }

          pushEvent(agentId, { type: "system", timestamp: Date.now(), summary: `Cancelled: ${proc.task.slice(0, 60)}` });
          logger.info(`claude-code-bridge: cancelled process ${proc.id}`);

          return {
            content: [{ type: "text" as const, text: `Process ${proc.id} cancelled.` }],
            details: { status: "cancelled" },
          };
        }
      }
    },
  };
}
