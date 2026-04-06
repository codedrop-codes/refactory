"use strict";
/**
 * Integration tests — full pipeline: analyze → plan → extract → verify → metrics → report
 *
 * Requires at least one LLM API key to run. Tagged @slow — skipped in CI without keys.
 * Run with: GROQ_API_KEY=sk-xxx node --test tests/integration.test.js
 *
 * Uses tests/fixtures/monolith.js as the input monolith.
 */
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { getAvailableProviders } = require("../src/providers/router");
const { analyze } = require("../src/tools/analyze");
const { plan } = require("../src/tools/plan");
const { extract } = require("../src/tools/extract");
const { verify } = require("../src/tools/verify");
const { metrics } = require("../src/tools/metrics");
const { report } = require("../src/tools/report");

const FIXTURE = path.join(__dirname, "fixtures", "monolith.js");
const hasKeys = getAvailableProviders().length > 0;

// Returns true and marks test skipped if no keys — caller must `return` on true
function skipIfNoKeys(t) {
  if (!hasKeys) {
    t.skip("No LLM API keys configured — set REFACTORY_KEY_* or GROQ_API_KEY to run");
    return true;
  }
  return false;
}

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "refactory-test-"));
});

after(() => {
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe("integration — analyze (no keys needed)", () => {
  test("analyze produces valid result on fixture", async () => {
    const result = await analyze({ file: FIXTURE });
    assert.equal(result.analysisMode, "ast");
    assert.ok(result.functions >= 20, `expected >= 20 functions, got ${result.functions}`);
    assert.ok(result.lines >= 190);
    assert.ok(result.health.overall > 0);
    assert.ok(["ok", "consider_decompose", "decompose"].includes(result.recommendation));
  });
});

describe("integration — plan @slow", () => {
  test("plan generates valid JSON structure", async (t) => {
    if (skipIfNoKeys(t)) return;
    const result = await plan({ file: FIXTURE, maxLines: 100, style: "functional" });

    assert.ok(Array.isArray(result.modules), "modules should be array");
    assert.ok(result.modules.length >= 2, "should plan at least 2 modules");

    for (const mod of result.modules) {
      assert.ok(typeof mod.name === "string" && mod.name.endsWith(".js"), `module name should be *.js, got: ${mod.name}`);
      assert.ok(Array.isArray(mod.functions), "module.functions should be array");
      assert.ok(typeof mod.description === "string", "module.description should be string");
      assert.ok(typeof mod.estimatedLines === "number", "module.estimatedLines should be number");
    }

    assert.ok(result._meta?.provider, "result should include provider metadata");
  });
});

describe("integration — extract @slow", () => {
  test("extract writes a loadable JS file", async (t) => {
    if (skipIfNoKeys(t)) return;
    const outputDir = path.join(tmpDir, "extract-test");

    const result = await extract({
      file: FIXTURE,
      module: "db-helpers.js",
      functions: ["dbConnect", "dbQuery", "dbClose"],
      outputDir,
    });

    assert.ok(fs.existsSync(result.outputPath), "output file should exist");
    assert.ok(result.lines > 0, "extracted file should have lines");
    assert.ok(result.provider, "should report which provider was used");

    // Must pass syntax check
    const { execSync } = require("node:child_process");
    assert.doesNotThrow(
      () => execSync(`node --check "${result.outputPath}"`, { stdio: "pipe" }),
      "extracted file should have valid syntax"
    );
  });

  test("extract strips markdown fences from output", async (t) => {
    if (skipIfNoKeys(t)) return;
    const outputDir = path.join(tmpDir, "fence-test");

    const result = await extract({
      file: FIXTURE,
      module: "utils.js",
      functions: ["paginate", "formatCurrency"],
      outputDir,
    });

    const content = fs.readFileSync(result.outputPath, "utf8");
    assert.ok(!content.includes("```"), "output should not contain markdown fences");
  });
});

describe("integration — full pipeline @slow", () => {
  test("analyze → plan → extract × 2 → verify → metrics → report", async (t) => {
    if (skipIfNoKeys(t)) return;
    const outputDir = path.join(tmpDir, "pipeline-test");
    fs.mkdirSync(outputDir, { recursive: true });

    // Step 1: Analyze
    const analysisResult = await analyze({ file: FIXTURE });
    assert.ok(analysisResult.functions > 0);

    // Step 2: Plan — ask for small modules to exercise extraction
    const planResult = await plan({ file: FIXTURE, maxLines: 80, style: "functional" });
    assert.ok(planResult.modules.length >= 2);

    // Step 3: Extract first 2 modules only (keep test fast)
    const extracted = [];
    for (const mod of planResult.modules.slice(0, 2)) {
      const extractResult = await extract({
        file: FIXTURE,
        module: mod.name,
        functions: mod.functions,
        outputDir,
      });
      extracted.push(extractResult);
    }
    assert.equal(extracted.length, 2);

    // Step 4: Verify
    const verifyResult = await verify({ moduleDir: outputDir });
    assert.ok(Array.isArray(verifyResult.modules));
    // At least the extracted modules should exist in the dir
    assert.ok(verifyResult.modules.length >= 2);

    // Step 5: Metrics
    const metricsResult = await metrics({ original: FIXTURE, moduleDir: outputDir });
    assert.ok(typeof metricsResult.refactoryScore === "number");
    assert.ok(metricsResult.refactoryScore >= 0 && metricsResult.refactoryScore <= 1);
    assert.ok(metricsResult.decomposed.moduleCount >= 2);

    // Step 6: Report
    const metricsPath = path.join(outputDir, "metrics.json");
    fs.writeFileSync(metricsPath, JSON.stringify(metricsResult, null, 2));
    const reportResult = await report({
      metricsFile: metricsPath,
      format: "markdown",
      outputPath: path.join(outputDir, "REPORT.md"),
    });

    assert.equal(reportResult.format, "markdown");
    assert.ok(reportResult.content.includes("Refactory Score"));
    assert.ok(fs.existsSync(path.join(outputDir, "REPORT.md")));
  });
});
