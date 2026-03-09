import * as fs from "fs";
import * as path from "path";

export interface BridgeConfig {
  agents: string[];
  binaryPath?: string;
  proxyUrl: string;
  apiKey: string;
  model: string;
  permissionMode: string;
  maxBudgetUsd: number;
  timeoutMs: number;
  maxConcurrent: number;
  sessionPersistence: boolean;
  useProxy: boolean;
  claudeConfigDir?: string;
}

const DEFAULTS: BridgeConfig = {
  agents: [],
  proxyUrl: "http://127.0.0.1:18080",
  apiKey: "proxy",
  model: "sonnet",
  permissionMode: "auto",
  maxBudgetUsd: 1.0,
  timeoutMs: 300_000,
  maxConcurrent: 3,
  sessionPersistence: true,
  useProxy: true,
};

export interface PluginLogger {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
}

// ── Runtime config (mutable for Studio toggle) ──

let runtimeConfig: BridgeConfig;

export function setRuntimeConfig(config: BridgeConfig): void {
  runtimeConfig = config;
}

export function getRuntimeConfig(): BridgeConfig {
  return runtimeConfig;
}

export function loadConfig(pluginDir: string, logger: PluginLogger): BridgeConfig {
  const configPath = path.join(pluginDir, "config.json");
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const cfg: BridgeConfig = { ...DEFAULTS };

    if (Array.isArray(raw.agents)) cfg.agents = raw.agents;
    if (typeof raw.binaryPath === "string") cfg.binaryPath = raw.binaryPath;
    if (typeof raw.proxyUrl === "string") cfg.proxyUrl = raw.proxyUrl;
    if (typeof raw.apiKey === "string") cfg.apiKey = raw.apiKey;
    if (typeof raw.model === "string") cfg.model = raw.model;
    if (typeof raw.permissionMode === "string") cfg.permissionMode = raw.permissionMode;
    if (typeof raw.maxBudgetUsd === "number") cfg.maxBudgetUsd = raw.maxBudgetUsd;
    if (typeof raw.timeoutMs === "number") cfg.timeoutMs = raw.timeoutMs;
    if (typeof raw.maxConcurrent === "number") cfg.maxConcurrent = raw.maxConcurrent;
    if (typeof raw.sessionPersistence === "boolean") cfg.sessionPersistence = raw.sessionPersistence;
    if (typeof raw.useProxy === "boolean") cfg.useProxy = raw.useProxy;
    if (typeof raw.claudeConfigDir === "string") cfg.claudeConfigDir = raw.claudeConfigDir;

    logger.info(`claude-code-bridge: config loaded — agents: [${cfg.agents.join(", ")}], proxy: ${cfg.useProxy ? cfg.proxyUrl : "OFF"}`);
    return cfg;
  } catch {
    logger.warn(`claude-code-bridge: no config.json at ${configPath}, using defaults`);
    return { ...DEFAULTS };
  }
}
