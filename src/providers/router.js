"use strict";
const logger = require("../logger");
/**
 * Model Router — routes requests to the cheapest capable free LLM API.
 *
 * Key configuration (pick whichever providers you have keys for):
 *
 *   Capability slots (recommended — provider-agnostic):
 *     REFACTORY_KEY_LARGE_OUTPUT=groq:sk-xxx      32k+ output, large module extraction
 *     REFACTORY_KEY_LARGE_CONTEXT=gemini:AIza-xxx 1M+ context, huge file planning
 *     REFACTORY_KEY_FAST=groq:sk-xxx              Fast responses, small tasks
 *     REFACTORY_KEY_CODE=deepseek:sk-xxx          Code-specialized models
 *     REFACTORY_KEY_GENERAL=openrouter:sk-xxx     General fallback
 *
 *   Provider-specific (also supported, for users who already have these set):
 *     GROQ_API_KEY, GOOGLE_API_KEY, OPENROUTER_API_KEY, SAMBANOVA_API_KEY
 *
 * When a new free provider appears, point the relevant slot at it — no new var names.
 * Falls back through all configured providers on rate limit or failure.
 */

const https = require("node:https");
const http = require("node:http");

const PROVIDERS = [
  {
    id: "groq",
    name: "Groq Llama 3.3 70B",
    envKey: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    maxOutput: 32000,
    contextWindow: 128000,
    cost: 0,
  },
  {
    id: "groq-2",
    name: "Groq Llama 3.3 70B (key 2)",
    envKey: "GROQ_API_KEY_2",
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: "llama-3.3-70b-versatile",
    maxOutput: 32000,
    contextWindow: 128000,
    cost: 0,
  },
  {
    id: "gemini-flash",
    name: "Gemini 2.5 Flash",
    envKey: "GOOGLE_API_KEY",
    url: "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    model: "gemini-2.5-flash",
    maxOutput: 16000,
    contextWindow: 1000000,
    cost: 0,
    isGemini: true,
  },
  {
    id: "openrouter-qwen",
    name: "Qwen 3.6 Plus (OpenRouter)",
    envKey: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: "qwen/qwen3.6-plus:free",
    maxOutput: 16000,
    contextWindow: 1000000,
    cost: 0,
  },
  {
    id: "sambanova",
    name: "SambaNova MiniMax",
    envKey: "SAMBANOVA_API_KEY",
    url: "https://api.sambanova.ai/v1/chat/completions",
    model: "MiniMax-M2.5",
    maxOutput: 16384,
    contextWindow: 163840,
    cost: 0,
  },
];

/**
 * Capability slots — named by what the task needs, not which provider does it.
 * Value format: "provider-id:api-key", e.g. "groq:sk-xxx" or "gemini:AIza-xxx"
 *
 * When a better provider exists for a slot, just update the value — no code changes needed.
 */
const CAPABILITY_SLOTS = {
  LARGE_OUTPUT:  "REFACTORY_KEY_LARGE_OUTPUT",  // 32k+ output: large module extraction
  LARGE_CONTEXT: "REFACTORY_KEY_LARGE_CONTEXT", // 1M+ context: huge file planning/analysis
  FAST:          "REFACTORY_KEY_FAST",          // Fastest response: small tasks, iteration
  CODE:          "REFACTORY_KEY_CODE",          // Code-specialized: future DeepSeek etc.
  GENERAL:       "REFACTORY_KEY_GENERAL",       // General fallback
};

/** Parse a capability slot value "provider-id:api-key" → { id, key } or null. */
function parseSlot(envVar) {
  const val = process.env[envVar];
  if (!val || !val.trim()) return null;
  const sep = val.indexOf(":");
  if (sep === -1) return null;
  const id = val.slice(0, sep).trim().toLowerCase();
  const key = val.slice(sep + 1).trim();
  return (id && key) ? { id, key } : null;
}

/**
 * Build a map of providerId → apiKey from all configured sources.
 * Capability slots take precedence over legacy specific env vars.
 */
function buildKeyMap() {
  const keys = {};

  // 1. Legacy specific env vars (lowest precedence — for users who have these system-wide)
  for (const p of PROVIDERS) {
    const k = process.env[p.envKey];
    if (k && k.trim()) keys[p.id] = k.trim();
  }

  // 2. Capability slots (higher precedence — explicit user intent)
  for (const envVar of Object.values(CAPABILITY_SLOTS)) {
    const slot = parseSlot(envVar);
    if (slot) keys[slot.id] = slot.key;
  }

  return keys;
}

function getAvailableProviders() {
  const keyMap = buildKeyMap();
  return PROVIDERS.filter((p) => keyMap[p.id]);
}

/** Resolve the API key for a provider from all configured sources. */
function resolveKey(provider) {
  return buildKeyMap()[provider.id] || null;
}

/**
 * Get the preferred provider for a capability need, or null if no slot is configured.
 * Used by callWithFallback to check capability slots before falling back to priority order.
 */
function getSlotProvider(slotName) {
  const slot = parseSlot(CAPABILITY_SLOTS[slotName]);
  if (!slot) return null;
  return PROVIDERS.find((p) => p.id === slot.id) || null;
}

function selectProvider(options = {}) {
  const available = getAvailableProviders();
  if (available.length === 0) {
    throw new Error(
      "No API keys configured. Set a capability slot (e.g. REFACTORY_KEY_LARGE_OUTPUT=groq:sk-xxx) " +
      "or a provider-specific key (GROQ_API_KEY, GOOGLE_API_KEY, OPENROUTER_API_KEY)."
    );
  }

  const minOutput = options.minOutputTokens || 4000;
  const minContext = options.minContextTokens || 0;
  const estimatedInput = options.estimatedInputTokens || 0;

  // Check capability slots first — explicit user preference beats automatic selection
  if (options.preferHighOutput || (options.minOutputTokens && options.minOutputTokens >= 16000)) {
    const slotProvider = getSlotProvider("LARGE_OUTPUT");
    if (slotProvider && available.find((p) => p.id === slotProvider.id)) return slotProvider;
  }
  if (options.minContextTokens && options.minContextTokens >= 500000) {
    const slotProvider = getSlotProvider("LARGE_CONTEXT");
    if (slotProvider && available.find((p) => p.id === slotProvider.id)) return slotProvider;
  }

  // Filter by minimum capability requirements (input + output)
  const minContextNeeded = Math.max(minContext, Math.ceil(estimatedInput * 1.5));
  const capable = available.filter((p) =>
    p.maxOutput >= minOutput && p.contextWindow >= minContextNeeded
  );

  if (options.preferHighOutput) {
    capable.sort((a, b) => b.maxOutput - a.maxOutput);
  }

  return capable[0] || available[0];
}

async function callProvider(provider, prompt, options = {}) {
  const apiKey = resolveKey(provider);
  if (!apiKey) throw new Error(`No API key for ${provider.id}`);

  const maxTokens = Math.min(options.maxTokens || provider.maxOutput, provider.maxOutput);
  const temperature = options.temperature || 0.2;

  if (provider.isGemini) {
    return callGemini(provider, apiKey, prompt, maxTokens, temperature);
  }
  return callOpenAICompatible(provider, apiKey, prompt, maxTokens, temperature);
}

async function callOpenAICompatible(provider, apiKey, prompt, maxTokens, temperature) {
  const body = JSON.stringify({
    model: provider.model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    temperature,
  });

  const url = new URL(provider.url);
  const options = {
    hostname: url.hostname,
    path: url.pathname,
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode === 429 || res.statusCode === 413) {
          reject(new Error(`RATE_LIMITED:${provider.id}:${res.statusCode}`));
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`${provider.id} HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const result = JSON.parse(data);
          resolve(result.choices[0].message.content);
        } catch (e) {
          reject(new Error(`${provider.id} parse error: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(options.timeout || 120000, () => { req.destroy(); reject(new Error(`${provider.id} timeout`)); });
    req.write(body);
    req.end();
  });
}

async function callGemini(provider, apiKey, prompt, maxTokens, temperature) {
  const url = `${provider.url}?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: maxTokens, temperature },
  });

  const parsedUrl = new URL(url);
  const options = {
    hostname: parsedUrl.hostname,
    path: parsedUrl.pathname + parsedUrl.search,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        if (res.statusCode !== 200) {
          reject(new Error(`gemini HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
          return;
        }
        try {
          const result = JSON.parse(data);
          resolve(result.candidates[0].content.parts[0].text);
        } catch (e) {
          reject(new Error(`gemini parse error: ${e.message}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(120000, () => { req.destroy(); reject(new Error("gemini timeout")); });
    req.write(body);
    req.end();
  });
}

/**
 * Call with automatic fallback through providers on failure.
 */
async function callWithFallback(prompt, options = {}) {
  const available = getAvailableProviders();
  const errors = [];

  for (const provider of available) {
    if (options.minOutputTokens && provider.maxOutput < options.minOutputTokens) continue;
    logger.debug(`Trying provider ${provider.id} (max_output=${provider.maxOutput}, context=${provider.contextWindow})`);
    try {
      const callStart = Date.now();
      const result = await callProvider(provider, prompt, options);
      const callMs = Date.now() - callStart;
      logger.debug(`Provider ${provider.id} responded in ${callMs}ms`);
      return { provider: provider.id, content: result };
    } catch (error) {
      logger.debug(`Provider ${provider.id} failed: ${error.message}`);
      errors.push({ provider: provider.id, error: error.message });
      // Continue to next provider on rate limits, timeouts, and provider-specific
      // access errors (403/401) — those may succeed against another provider.
      // Break only on prompt/usage errors (400 with validation) or no-more-providers.
      const isRecoverable =
        error.message.startsWith("RATE_LIMITED") ||
        error.message.includes("timeout") ||
        error.message.includes("HTTP 403") ||
        error.message.includes("HTTP 401") ||
        error.message.includes("HTTP 5");
      if (!isRecoverable) break;
    }
  }

  throw new Error(`All providers failed: ${errors.map((e) => `${e.provider}: ${e.error}`).join("; ")}`);
}

module.exports = {
  PROVIDERS,
  CAPABILITY_SLOTS,
  getAvailableProviders,
  selectProvider,
  callProvider,
  callWithFallback,
};
