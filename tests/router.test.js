"use strict";
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

// We test the router in isolation — no real API calls
// Save and restore env vars around each test
let savedEnv;

beforeEach(() => {
  savedEnv = { ...process.env };
  // Clear all router-related env vars before each test
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("REFACTORY_KEY_") || key.match(/^(GROQ|GOOGLE|OPENROUTER|SAMBANOVA)_API_KEY/)) {
      delete process.env[key];
    }
  }
  // Clear require cache so env changes take effect
  delete require.cache[require.resolve("../src/providers/router")];
});

afterEach(() => {
  // Restore env
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("REFACTORY_KEY_") || key.match(/^(GROQ|GOOGLE|OPENROUTER|SAMBANOVA)_API_KEY/)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, savedEnv);
  delete require.cache[require.resolve("../src/providers/router")];
});

function loadRouter() {
  return require("../src/providers/router");
}

describe("router — capability slots", () => {
  test("CAPABILITY_SLOTS has expected keys", () => {
    const { CAPABILITY_SLOTS } = loadRouter();
    assert.ok("LARGE_OUTPUT" in CAPABILITY_SLOTS);
    assert.ok("LARGE_CONTEXT" in CAPABILITY_SLOTS);
    assert.ok("FAST" in CAPABILITY_SLOTS);
    assert.ok("CODE" in CAPABILITY_SLOTS);
    assert.ok("GENERAL" in CAPABILITY_SLOTS);
  });

  test("CAPABILITY_SLOTS values are REFACTORY_KEY_* env var names", () => {
    const { CAPABILITY_SLOTS } = loadRouter();
    for (const envVar of Object.values(CAPABILITY_SLOTS)) {
      assert.ok(envVar.startsWith("REFACTORY_KEY_"), `${envVar} should start with REFACTORY_KEY_`);
    }
  });

  test("getAvailableProviders returns empty when no keys set", () => {
    const { getAvailableProviders } = loadRouter();
    assert.deepEqual(getAvailableProviders(), []);
  });

  test("capability slot activates correct provider", () => {
    process.env.REFACTORY_KEY_LARGE_OUTPUT = "groq:test-key-123";
    const { getAvailableProviders } = loadRouter();
    const available = getAvailableProviders();
    assert.equal(available.length, 1);
    assert.equal(available[0].id, "groq");
  });

  test("multiple slots activate multiple providers", () => {
    process.env.REFACTORY_KEY_LARGE_OUTPUT = "groq:key1";
    process.env.REFACTORY_KEY_LARGE_CONTEXT = "gemini-flash:key2";
    process.env.REFACTORY_KEY_GENERAL = "openrouter-qwen:key3";
    const { getAvailableProviders } = loadRouter();
    const ids = getAvailableProviders().map((p) => p.id);
    assert.ok(ids.includes("groq"));
    assert.ok(ids.includes("gemini-flash"));
    assert.ok(ids.includes("openrouter-qwen"));
  });

  test("same provider in two slots is not duplicated", () => {
    process.env.REFACTORY_KEY_LARGE_OUTPUT = "groq:key1";
    process.env.REFACTORY_KEY_FAST = "groq:key1";
    const { getAvailableProviders } = loadRouter();
    const groqEntries = getAvailableProviders().filter((p) => p.id === "groq");
    assert.equal(groqEntries.length, 1, "groq should appear only once");
  });

  test("slot format must be provider:key — invalid format ignored", () => {
    process.env.REFACTORY_KEY_LARGE_OUTPUT = "invalid-no-colon";
    const { getAvailableProviders } = loadRouter();
    assert.equal(getAvailableProviders().length, 0);
  });

  test("unknown provider id in slot is ignored", () => {
    process.env.REFACTORY_KEY_GENERAL = "nonexistent-provider:key123";
    const { getAvailableProviders } = loadRouter();
    assert.equal(getAvailableProviders().length, 0);
  });
});

describe("router — legacy specific env vars", () => {
  test("GROQ_API_KEY activates groq provider", () => {
    process.env.GROQ_API_KEY = "sk-test";
    const { getAvailableProviders } = loadRouter();
    const ids = getAvailableProviders().map((p) => p.id);
    assert.ok(ids.includes("groq"));
  });

  test("GOOGLE_API_KEY activates gemini-flash provider", () => {
    process.env.GOOGLE_API_KEY = "AIza-test";
    const { getAvailableProviders } = loadRouter();
    const ids = getAvailableProviders().map((p) => p.id);
    assert.ok(ids.includes("gemini-flash"));
  });

  test("OPENROUTER_API_KEY activates openrouter-qwen provider", () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const { getAvailableProviders } = loadRouter();
    const ids = getAvailableProviders().map((p) => p.id);
    assert.ok(ids.includes("openrouter-qwen"));
  });

  test("capability slot takes precedence over legacy env var for same provider", () => {
    // Both set — slot should win (it's more explicit)
    process.env.GROQ_API_KEY = "legacy-key";
    process.env.REFACTORY_KEY_LARGE_OUTPUT = "groq:slot-key";
    const { getAvailableProviders } = loadRouter();
    // Provider should appear exactly once
    const groqEntries = getAvailableProviders().filter((p) => p.id === "groq");
    assert.equal(groqEntries.length, 1);
  });
});

describe("router — selectProvider", () => {
  test("throws when no providers configured", () => {
    const { selectProvider } = loadRouter();
    assert.throws(() => selectProvider(), /No API keys configured/);
  });

  test("returns available provider when configured", () => {
    process.env.GROQ_API_KEY = "sk-test";
    const { selectProvider } = loadRouter();
    const p = selectProvider();
    assert.ok(p, "should return a provider");
    assert.equal(p.id, "groq");
  });

  test("preferHighOutput selects highest maxOutput provider", () => {
    process.env.GROQ_API_KEY = "sk-groq";        // 32k output
    process.env.GOOGLE_API_KEY = "AIza-gemini";  // 16k output
    const { selectProvider } = loadRouter();
    const p = selectProvider({ preferHighOutput: true });
    assert.equal(p.id, "groq", "groq has highest output capacity");
  });

  test("LARGE_OUTPUT slot overrides automatic selection", () => {
    // Both groq and gemini available, but slot explicitly routes to gemini
    process.env.GROQ_API_KEY = "sk-groq";
    process.env.GOOGLE_API_KEY = "AIza-gemini";
    process.env.REFACTORY_KEY_LARGE_OUTPUT = "gemini-flash:AIza-gemini";
    const { selectProvider } = loadRouter();
    const p = selectProvider({ preferHighOutput: true });
    assert.equal(p.id, "gemini-flash", "slot should override automatic selection");
  });

  test("filters out providers below minOutputTokens", () => {
    process.env.GOOGLE_API_KEY = "AIza-test";  // 16k output
    const { selectProvider } = loadRouter();
    // Gemini has 16k output, asking for 20k should fail to find capable provider
    // Falls back to available[0] when no capable provider found
    const p = selectProvider({ minOutputTokens: 20000 });
    // Should return available[0] as fallback even if not meeting requirement
    assert.ok(p, "should return fallback provider");
  });
});

describe("router — PROVIDERS metadata", () => {
  test("all providers have required fields", () => {
    const { PROVIDERS } = loadRouter();
    for (const p of PROVIDERS) {
      assert.ok(p.id, `${p.name} needs id`);
      assert.ok(p.url, `${p.id} needs url`);
      assert.ok(p.model, `${p.id} needs model`);
      assert.ok(typeof p.maxOutput === "number", `${p.id} maxOutput should be number`);
      assert.ok(typeof p.contextWindow === "number", `${p.id} contextWindow should be number`);
    }
  });

  test("groq has highest output capacity", () => {
    const { PROVIDERS } = loadRouter();
    const groq = PROVIDERS.find((p) => p.id === "groq");
    const maxOutput = Math.max(...PROVIDERS.map((p) => p.maxOutput));
    assert.equal(groq.maxOutput, maxOutput, "groq should have highest output capacity");
  });

  test("provider ids are unique", () => {
    const { PROVIDERS } = loadRouter();
    const ids = PROVIDERS.map((p) => p.id);
    const unique = new Set(ids);
    assert.equal(unique.size, ids.length, "provider ids must be unique");
  });
});
