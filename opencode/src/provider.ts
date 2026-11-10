import { apiKeyFor, providerNameFor, type DiscoveredModel, type LocalServerConfig } from "../../core/config.js";
import type { FoundServer } from "../../core/scan.js";

/** The slice of OpenCode's `provider` config entry this plugin writes (see @opencode-ai/sdk `Config`). */
export interface OpenCodeProvider {
  name: string;
  npm: string;
  options: { baseURL: string; apiKey: string; timeout: false };
  models: Record<string, OpenCodeModel>;
}

export interface OpenCodeModel {
  name: string;
  tool_call: boolean;
  reasoning: boolean;
  attachment: boolean;
  temperature: boolean;
  limit: { context: number; output: number };
  modalities: { input: Array<"text" | "image">; output: Array<"text"> };
  cost: { input: number; output: number };
}

export function toOpenCodeModel(m: DiscoveredModel): OpenCodeModel {
  return {
    name: m.name ?? m.id,
    // Local agents are used for coding: expose tools. Servers that can't do tool calls fail loudly.
    tool_call: true,
    reasoning: m.reasoning,
    attachment: !!m.vision,
    temperature: true,
    limit: { context: m.contextWindow, output: m.maxTokens },
    modalities: { input: m.vision ? ["text", "image"] : ["text"], output: ["text"] },
    cost: { input: 0, output: 0 },
  };
}

export function toOpenCodeProvider(found: FoundServer, config: LocalServerConfig): OpenCodeProvider {
  const { server, models } = found;
  return {
    name: providerNameFor(server),
    npm: "@ai-sdk/openai-compatible",
    options: {
      baseURL: server.baseUrl,
      apiKey: apiKeyFor(server.host, server.port, config),
      // Local prefill of a long prompt can take minutes: don't let the default 5 min timeout cut it.
      timeout: false,
    },
    models: Object.fromEntries(models.map((m) => [m.id, toOpenCodeModel(m)])),
  };
}

// --- OpenCode 2.x -----------------------------------------------------------------------------
// The 2.x plugin API (setup + ctx.provider.transform) takes Provider.Info / Model.Info records.
// Shapes follow @opencode/schema (packages/schema/src/provider.ts and model.ts at v2.2.6); plain
// objects are enough, the branded ids are ordinary strings at runtime.

export interface V2ModelInfo {
  id: string;
  modelID: string;
  providerID: string;
  name: string;
  capabilities: { tools: boolean; input: string[]; output: string[]; temperature: boolean };
  compatibility: { maxTokensField: "max_tokens" };
  variants: never[];
  time: { released: number };
  cost: never[];
  status: "active";
  enabled: boolean;
  limit: { context: number; output: number };
}

export interface V2ProviderInfo {
  id: string;
  name: string;
  activation: "enabled";
  package: string;
  settings: { baseURL: string; apiKey: string; timeout: false };
}

export interface V2ProviderEntry {
  info: V2ProviderInfo;
  models: V2ModelInfo[];
}

export function toV2Entry(found: FoundServer, config: LocalServerConfig): V2ProviderEntry {
  const { server, models, providerId } = found;
  return {
    info: {
      id: providerId,
      name: providerNameFor(server),
      activation: "enabled",
      package: "@opencode/ai/providers/openai-compatible",
      settings: {
        baseURL: server.baseUrl,
        apiKey: apiKeyFor(server.host, server.port, config),
        // Long local prefills must not hit the default request timeout.
        timeout: false,
      },
    },
    models: models.map((m) => ({
      id: m.id,
      modelID: m.id,
      providerID: providerId,
      name: m.name ?? m.id,
      capabilities: {
        tools: true,
        input: m.vision ? ["text", "image"] : ["text"],
        output: ["text"],
        temperature: true,
      },
      compatibility: { maxTokensField: "max_tokens" },
      variants: [],
      time: { released: 0 },
      cost: [],
      status: "active",
      enabled: true,
      limit: { context: m.contextWindow, output: m.maxTokens },
    })),
  };
}
