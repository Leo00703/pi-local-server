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
