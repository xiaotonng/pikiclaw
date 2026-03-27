/**
 * routes/agents.ts — Hono route module for agent, model, and runtime
 * configuration API routes.
 *
 * Ported from dashboard-routes-agent.ts.
 */

import { Hono } from 'hono';
import { spawn } from 'node:child_process';
import { getAgentInstallCommand, getAgentLabel, getAgentPackage } from '../agent-npm.js';
import { loadUserConfig, saveUserConfig, applyUserConfig, type UserConfig } from '../user-config.js';
import { listAgents, listModels, normalizeClaudeModelId, type AgentDetectOptions, type UsageResult } from '../code-agent.js';
import type { Agent } from '../code-agent.js';
import { getDriver } from '../agent-driver.js';
import { DASHBOARD_TIMEOUTS } from '../constants.js';
import { runtime } from '../runtime.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AGENT_STATUS_MODELS_TIMEOUT_MS = DASHBOARD_TIMEOUTS.agentStatusModels;
const AGENT_STATUS_USAGE_TIMEOUT_MS = DASHBOARD_TIMEOUTS.agentStatusUsage;
const AGENT_INSTALL_TIMEOUT_MS = DASHBOARD_TIMEOUTS.agentInstall;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeoutFallback<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise(resolve => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);

    promise
      .then(result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      })
      .catch(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(fallback);
      });
  });
}

function dedupeModels(models: { id: string; alias: string | null }[]): { id: string; alias: string | null }[] {
  const seen = new Set<string>();
  const deduped: { id: string; alias: string | null }[] = [];
  for (const model of models) {
    const id = String(model?.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, alias: model.alias?.trim() || null });
  }
  return deduped;
}

function runCommand(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; error: string | null }> {
  return new Promise(resolve => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, npm_config_yes: 'true' },
    });
    const timeoutMs = Math.max(500, opts.timeoutMs ?? DASHBOARD_TIMEOUTS.runCommand);
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGTERM');
      resolve({ ok: false, stdout, stderr, error: `Timed out after ${Math.round(timeoutMs / 1000)}s` });
    }, timeoutMs);

    child.stdout?.on('data', chunk => { stdout += String(chunk); });
    child.stderr?.on('data', chunk => { stderr += String(chunk); });
    child.on('error', err => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr, error: err.message });
    });
    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout,
        stderr,
        error: code === 0 ? null : (stderr.trim() || stdout.trim() || `Exited with code ${code}`),
      });
    });
  });
}

async function installAgentViaNpm(agent: Agent, log: (msg: string) => void): Promise<void> {
  const pkg = getAgentPackage(agent);
  if (!pkg) throw new Error(`Unsupported agent: ${agent}`);
  log(`Installing ${getAgentLabel(agent)} via npm...`);
  const result = await runCommand('npm', ['install', '-g', `${pkg}@latest`], {
    timeoutMs: AGENT_INSTALL_TIMEOUT_MS,
  });
  if (!result.ok) throw new Error(result.error || `Failed to install ${pkg}`);
  log(`${getAgentLabel(agent)} installation complete.`);
}

// ---------------------------------------------------------------------------
// Agent status builder
// ---------------------------------------------------------------------------

function emptyUsage(agent: Agent, error: string): UsageResult {
  return { ok: false, agent, source: null, capturedAt: null, status: null, windows: [], error };
}

async function buildAgentStatusResponse(config = loadUserConfig(), agentOptions: AgentDetectOptions = {}) {
  const setupState = runtime.getSetupState(config, { includeVersion: true, ...agentOptions });
  const workdir = runtime.getRuntimeWorkdir(config);
  const defaultAgent = runtime.getRuntimeDefaultAgent(config);
  const agents = await Promise.all(setupState.agents.map(async (agentState) => {
    const agentId = runtime.isAgent(agentState.agent) ? agentState.agent : null;
    if (!agentId) {
      return {
        ...agentState,
        selectedModel: null,
        selectedEffort: null,
        isDefault: false,
        models: [],
        usage: null,
      };
    }

    const selectedModel = runtime.getRuntimeModel(agentId, config);
    const selectedEffort = runtime.getRuntimeEffort(agentId, config);
    let models: { id: string; alias: string | null }[] = [];
    let usage: UsageResult = emptyUsage(agentId, 'Agent not installed.');

    if (agentState.installed) {
      const modelFallback = selectedModel ? [{ id: selectedModel, alias: null }] : [];
      try {
        const driver = getDriver(agentId);
        const cachedUsage = driver.getUsage({ agent: agentId, model: selectedModel });
        const [resolvedModels, resolvedUsage] = await Promise.all([
          withTimeoutFallback(
            listModels(agentId, { workdir, currentModel: selectedModel }).then(result => dedupeModels([
              ...modelFallback,
              ...result.models,
            ])),
            AGENT_STATUS_MODELS_TIMEOUT_MS,
            modelFallback,
          ),
          driver.getUsageLive
            ? withTimeoutFallback(
              driver.getUsageLive({ agent: agentId, model: selectedModel }),
              AGENT_STATUS_USAGE_TIMEOUT_MS,
              cachedUsage,
            )
            : Promise.resolve(cachedUsage),
        ]);
        models = resolvedModels;
        usage = resolvedUsage;
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        usage = emptyUsage(agentId, detail || 'Usage query failed.');
      }
    }

    return {
      ...agentState,
      selectedModel,
      selectedEffort,
      isDefault: agentId === defaultAgent,
      models,
      usage,
    };
  }));

  return { defaultAgent, workdir, agents };
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const app = new Hono();

// Agent status (full agent/model/usage data)
app.get('/api/agent-status', async (c) => {
  return c.json(await buildAgentStatusResponse());
});

// Agent install via npm
app.post('/api/agent-install', async (c) => {
  const body = await c.req.json();
  const agent = String(body?.agent || '').trim();
  if (!runtime.isAgent(agent)) return c.json({ ok: false, error: 'Invalid agent' }, 400);
  runtime.log(`[agents] install requested agent=${agent} command="${getAgentInstallCommand(agent) || '(unknown)'}"`);
  try {
    await installAgentViaNpm(agent, msg => runtime.log(`[agents] ${msg}`));
    return c.json({ ok: true, ...(await buildAgentStatusResponse(loadUserConfig(), { refresh: true })) });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    runtime.log(`[agents] install failed agent=${agent} error=${detail}`);
    return c.json({ ok: false, error: detail }, 500);
  }
});

// Agent list (lightweight)
app.get('/api/agents', (c) => {
  return c.json({ agents: runtime.getSetupState(loadUserConfig(), { includeVersion: true }).agents });
});

// Runtime agent/model/effort configuration
app.post('/api/runtime-agent', async (c) => {
  const body = await c.req.json();
  const config = loadUserConfig();
  const nextConfig: Partial<UserConfig> = { ...config };
  const defaultAgent = body?.defaultAgent;
  const targetAgent = body?.agent;
  const model = typeof body?.model === 'string' ? body.model.trim() : '';
  const effort = typeof body?.effort === 'string' ? body.effort.trim().toLowerCase() : '';
  const botRef = runtime.getBotRef();

  if (defaultAgent != null) {
    if (!runtime.isAgent(defaultAgent)) return c.json({ ok: false, error: 'Invalid defaultAgent' }, 400);
    runtime.runtimePrefs.defaultAgent = defaultAgent;
    process.env.DEFAULT_AGENT = defaultAgent;
    nextConfig.defaultAgent = defaultAgent;
    if (botRef) botRef.setDefaultAgent(defaultAgent);
  }

  if (model || effort) {
    if (!runtime.isAgent(targetAgent)) return c.json({ ok: false, error: 'Invalid agent' }, 400);
    if (model) {
      runtime.runtimePrefs.models[targetAgent] = model;
      runtime.setModelEnv(targetAgent, model);
      if (targetAgent === 'claude') nextConfig.claudeModel = model;
      if (targetAgent === 'codex') nextConfig.codexModel = model;
      if (targetAgent === 'gemini') nextConfig.geminiModel = model;
      if (botRef) botRef.setModelForAgent(targetAgent, model);
    }
    if (effort && targetAgent !== 'gemini') {
      runtime.runtimePrefs.efforts[targetAgent] = effort;
      runtime.setEffortEnv(targetAgent, effort);
      if (targetAgent === 'claude') nextConfig.claudeReasoningEffort = effort;
      if (targetAgent === 'codex') nextConfig.codexReasoningEffort = effort;
      if (botRef) botRef.setEffortForAgent(targetAgent, effort);
    }
  }

  saveUserConfig(nextConfig);
  applyUserConfig(nextConfig);
  return c.json({ ok: true, ...(await buildAgentStatusResponse(nextConfig)) });
});

export default app;
