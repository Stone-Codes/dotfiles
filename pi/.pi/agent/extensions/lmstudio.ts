import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_URL = "http://192.168.178.83:1234/v1";
const MODELS_URL = `${BASE_URL}/models`;
const REQUEST_TIMEOUT_MS = 3000;

type LMStudioModel = {
  id?: unknown;
  name?: unknown;
  context_length?: unknown;
  max_tokens?: unknown;
};

type LMStudioModelsResponse = {
  data?: unknown;
};

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

async function discoverModels(signal?: AbortSignal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();

  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", forwardAbort);
    }
  }

  try {
    const response = await fetch(MODELS_URL, { signal: controller.signal });
    if (!response.ok) {
      return [];
    }

    const payload = (await response.json()) as LMStudioModelsResponse;
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.data)) {
      return [];
    }

    return payload.data.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }

      const item = entry as LMStudioModel;
      if (typeof item.id !== "string" || item.id.length === 0) {
        return [];
      }

      const id = item.id;
      return [
        {
          id,
          name: typeof item.name === "string" && item.name.trim() ? item.name : id,
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: positiveInteger(item.context_length, 128000),
          maxTokens: positiveInteger(item.max_tokens, 16384),
        },
      ];
    });
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", forwardAbort);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("lmstudio", {
    name: "LM Studio",
    baseUrl: BASE_URL,
    apiKey: "lm-studio",
    api: "openai-completions",
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
    async refreshModels({ signal }) {
      return discoverModels(signal);
    },
  });
}
