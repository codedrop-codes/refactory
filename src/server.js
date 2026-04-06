#!/usr/bin/env node
"use strict";
/**
 * Refactory MCP Server
 *
 * Exposes decomposition tools via Model Context Protocol.
 * Works with Claude Code, Cursor, Windsurf, VS Code Copilot — any MCP client.
 *
 * Tools:
 *   refactory_analyze    — health assessment + dependency graph
 *   refactory_plan       — generate module boundaries from monolith
 *   refactory_extract    — extract one module (routes to free LLM APIs)
 *   refactory_verify     — check module loads, exports match, tests pass
 *   refactory_metrics    — before/after comparison + Refactory Score
 *   refactory_report     — generate Markdown/HTML report
 */

const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const { analyze } = require("./tools/analyze");
const { plan } = require("./tools/plan");
const { extract } = require("./tools/extract");
const { verify } = require("./tools/verify");
const { metrics } = require("./tools/metrics");
const { report } = require("./tools/report");
const { mapDependencies, detectCircular, diffDependencies } = require("./tools/depmap");
const { characterize, verifyExports } = require("./tools/characterize");
const { fixImports, scanBrokenRequires, generateReexport } = require("./tools/fix-imports");
const { decompose } = require("./tools/decompose");

const TOOLS = [
  {
    name: "refactory_analyze",
    description: "Analyze a source file for decomposition. Returns health score, function count, dependency graph, and recommended split points.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the monolith file to analyze" },
        language: { type: "string", description: "Language (js, ts, py). Auto-detected if omitted." },
      },
      required: ["file"],
    },
  },
  {
    name: "refactory_plan",
    description: "Generate a decomposition plan — module boundaries, function assignments, dependency order. Uses AST analysis + LLM reasoning.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the monolith file" },
        modules: { type: "number", description: "Target number of modules (auto if omitted)" },
        maxLines: { type: "number", description: "Max lines per module (default: 500)" },
        style: { type: "string", description: "Grouping style: 'functional' | 'domain' | 'layer'" },
      },
      required: ["file"],
    },
  },
  {
    name: "refactory_extract",
    description: "Extract one module from the monolith according to the plan. Routes to the cheapest capable free LLM API.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the monolith file" },
        module: { type: "string", description: "Module name to extract (from the plan)" },
        functions: { type: "array", items: { type: "string" }, description: "Function names to include" },
        outputDir: { type: "string", description: "Output directory for extracted module" },
        plan: { type: "string", description: "Path to the decomposition plan JSON" },
      },
      required: ["file", "module"],
    },
  },
  {
    name: "refactory_verify",
    description: "Verify a decomposed module: loads without errors, exports match plan, no circular deps, tests pass.",
    inputSchema: {
      type: "object",
      properties: {
        moduleDir: { type: "string", description: "Directory containing extracted modules" },
        original: { type: "string", description: "Path to the original monolith (for export comparison)" },
        testCmd: { type: "string", description: "Test command to run (e.g., 'npm test')" },
      },
      required: ["moduleDir"],
    },
  },
  {
    name: "refactory_metrics",
    description: "Calculate before/after metrics and the Refactory Score (0-1). Measures health improvement, module quality, test preservation.",
    inputSchema: {
      type: "object",
      properties: {
        original: { type: "string", description: "Path to the original monolith" },
        moduleDir: { type: "string", description: "Directory containing extracted modules" },
        testResults: { type: "string", description: "Path to test results JSON (before/after)" },
      },
      required: ["original", "moduleDir"],
    },
  },
  {
    name: "refactory_report",
    description: "Generate a decomposition report with metrics, dependency graphs, and Refactory Score. Outputs Markdown or HTML.",
    inputSchema: {
      type: "object",
      properties: {
        metricsFile: { type: "string", description: "Path to metrics JSON from refactory_metrics" },
        format: { type: "string", description: "'markdown' (default) or 'html'" },
        outputPath: { type: "string", description: "Where to write the report" },
      },
      required: ["metricsFile"],
    },
  },
  {
    name: "refactory_depmap",
    description: "Map dependencies for a file — who requires it (consumers), what it requires (dependencies), detect circular deps.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the file to map" },
        projectDir: { type: "string", description: "Project root directory" },
      },
      required: ["file"],
    },
  },
  {
    name: "refactory_characterize",
    description: "Generate characterization tests and golden export snapshot BEFORE decomposition. Captures behavioral contract.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the module to characterize" },
        outputDir: { type: "string", description: "Where to write test + golden files" },
      },
      required: ["file"],
    },
  },
  {
    name: "refactory_verify_exports",
    description: "Compare post-decomposition module against golden export snapshot. Reports missing, added, or type-changed exports.",
    inputSchema: {
      type: "object",
      properties: {
        goldenFile: { type: "string", description: "Path to .golden-exports.json from characterize" },
        newFile: { type: "string", description: "Path to the new re-export module" },
      },
      required: ["goldenFile", "newFile"],
    },
  },
  {
    name: "refactory_fix_imports",
    description: "Mechanically fix broken require() paths after module extraction. No LLM needed — pure path resolution.",
    inputSchema: {
      type: "object",
      properties: {
        moduleDir: { type: "string", description: "Directory containing extracted modules" },
        projectDir: { type: "string", description: "Project root to scan for consumers" },
        dryRun: { type: "boolean", description: "Report changes without writing (default: false)" },
      },
      required: ["moduleDir"],
    },
  },
  {
    name: "refactory_decompose",
    description: "Full decomposition pipeline in one call: analyze, depmap, characterize, plan, extract ALL modules, fix-imports, verify, metrics, re-export, report. The 'just do it' tool.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the monolith file to decompose" },
        outputDir: { type: "string", description: "Output directory (default: <dir>/lib/<basename>/ next to source)" },
        maxLines: { type: "number", description: "Max lines per module (default: 500)" },
        projectDir: { type: "string", description: "Project root for dependency mapping (optional)" },
      },
      required: ["file"],
    },
  },
];

async function main() {
  const server = new Server(
    { name: "refactory", version: "0.2.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      let result;
      switch (name) {
        case "refactory_analyze": result = await analyze(args); break;
        case "refactory_plan": result = await plan(args); break;
        case "refactory_extract": result = await extract(args); break;
        case "refactory_verify": result = await verify(args); break;
        case "refactory_metrics": result = await metrics(args); break;
        case "refactory_report": result = await report(args); break;
        case "refactory_depmap": {
          const deps = mapDependencies(args);
          const circular = detectCircular(deps.graph);
          result = { ...deps, ...circular };
          break;
        }
        case "refactory_characterize": result = await characterize(args); break;
        case "refactory_verify_exports": result = verifyExports(args); break;
        case "refactory_fix_imports": result = fixImports(args); break;
        case "refactory_decompose": result = await decompose(args); break;
        default:
          return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
      }
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  process.stderr.write(`Refactory MCP server error: ${error.message}\n`);
  process.exit(1);
});
