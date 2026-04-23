#!/usr/bin/env node
"use strict";
/**
 * Refactory CLI
 *
 * Usage:
 *   refactory analyze <file>            — health assessment + function list
 *   refactory plan <file>               — generate decomposition plan (requires LLM key)
 *   refactory decompose <file> [outDir] — full pipeline: analyze → plan → extract → verify
 *   refactory verify <dir>              — verify an already-extracted module directory
 *   refactory providers                 — show which LLM providers are configured
 */

const path = require("node:path");
const fs = require("node:fs");

const { analyze } = require("./tools/analyze");
const { plan } = require("./tools/plan");
const { extract } = require("./tools/extract");
const { verify } = require("./tools/verify");
const { metrics } = require("./tools/metrics");
const { report } = require("./tools/report");
const { decompose } = require("./tools/decompose");
const { analyze: analyzeFunctionBranches } = require("./tools/function-branches");
const { getAvailableProviders, CAPABILITY_SLOTS } = require("./providers/router");
const { listLanguages } = require("./languages");
const { submit: submitCorpus, runCorpus } = require("./test-corpus");

// ─── Output helpers ───────────────────────────────────────────────────────────

const RESET = "\x1b[0m";
const BOLD  = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED   = "\x1b[31m";
const CYAN  = "\x1b[36m";
const DIM   = "\x1b[2m";

function color(str, c) {
  if (!process.stdout.isTTY) return str;
  return `${c}${str}${RESET}`;
}

function die(msg) {
  process.stderr.write(`${color("error:", RED)} ${msg}\n`);
  process.exit(1);
}

function header(title) {
  process.stdout.write(`\n${color(title, BOLD + CYAN)}\n${"─".repeat(title.length)}\n`);
}

function scoreBar(score, width = 20) {
  const filled = Math.round(score * width);
  const bar = "█".repeat(filled) + "░".repeat(width - filled);
  const c = score >= 0.8 ? GREEN : score >= 0.5 ? YELLOW : RED;
  return color(bar, c) + color(` ${(score * 100).toFixed(0)}%`, BOLD);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

async function cmdAnalyze(args) {
  const file = args[0];
  if (!file) die("Usage: refactory analyze <file>");

  process.stdout.write(`Analyzing ${color(path.resolve(file), BOLD)}...\n`);
  const result = await analyze({ file });

  header("File Health");
  process.stdout.write(`  Lines:      ${color(String(result.lines), BOLD)} ${result.lines > 1000 ? color("(large)", YELLOW) : ""}\n`);
  process.stdout.write(`  Functions:  ${color(String(result.functions), BOLD)}\n`);
  process.stdout.write(`  Requires:   ${color(String(result.requires), BOLD)}\n`);
  process.stdout.write(`  Analysis:   ${color(result.analysisMode === "ast" ? "AST (ast-grep)" : "regex (fallback)", DIM)}\n`);

  header("Health Score");
  process.stdout.write(`  Overall:    ${scoreBar(result.health.overall)}\n`);
  process.stdout.write(`  Lines:      ${scoreBar(result.health.linesScore)}\n`);
  process.stdout.write(`  Functions:  ${scoreBar(result.health.fnCountScore)}\n`);
  process.stdout.write(`  Fn size:    ${scoreBar(result.health.fnSizeScore)}\n`);
  process.stdout.write(`  Coupling:   ${scoreBar(result.health.couplingScore)}\n`);
  if (result.health.functionsOver100Lines > 0) {
    process.stdout.write(`  ${color(`⚠  ${result.health.functionsOver100Lines} function(s) over 100 lines`, YELLOW)}\n`);
  }

  header("Functions");
  for (const fn of result.functionList) {
    const size = fn.endLine - fn.startLine + 1;
    const sizeStr = size > 100 ? color(`${size}L`, RED) : size > 50 ? color(`${size}L`, YELLOW) : color(`${size}L`, DIM);
    const kindStr = fn.kind.includes("async") ? color("async", CYAN) : "";
    process.stdout.write(`  ${color(fn.name.padEnd(30), BOLD)} line ${String(fn.startLine).padStart(4)}  ${sizeStr}  ${kindStr}\n`);
  }

  if (result.internalRequires.length > 0) {
    header("Internal Dependencies");
    for (const r of result.internalRequires) {
      process.stdout.write(`  ${color(r, DIM)}\n`);
    }
  }

  if (result.externalRequires.length > 0) {
    header("External Dependencies");
    for (const r of result.externalRequires) {
      process.stdout.write(`  ${r}\n`);
    }
  }

  header("Recommendation");
  const rec = result.recommendation;
  const recColor = rec === "ok" ? GREEN : rec === "consider_decompose" ? YELLOW : RED;
  process.stdout.write(`  ${color(rec.toUpperCase().replace(/_/g, " "), recColor + BOLD)}\n\n`);

  return result;
}

async function cmdAnalyzeFn(args) {
  const file = args[0];
  if (!file) die("Usage: refactory analyze-fn <file> --fn <fn-name> [--min-branch-lines N]");
  const fnName = parseFlag(args, "--fn", null);
  if (!fnName) die("Missing --fn <fn-name>");
  const minBranchLines = parseInt(parseFlag(args, "--min-branch-lines", "5"), 10);

  const result = analyzeFunctionBranches(file, fnName, { minBranchLines });

  header(`Function Branch Analysis — ${result.fn.name}`);
  process.stdout.write(`  Function:   ${color(result.fn.name, BOLD)} (lines ${result.fn.startLine}-${result.fn.endLine}, ${result.fn.lineCount}L)\n`);
  process.stdout.write(`  Candidates: ${color(String(result.candidates.length), BOLD)} (dropped ${result.dropped} below ${result.minBranchLines}L threshold)\n\n`);

  if (result.candidates.length === 0) {
    process.stdout.write(`  ${color("No extractable branches found at this threshold.", DIM)}\n`);
    process.stdout.write(`  Try --min-branch-lines 3 for a finer breakdown.\n\n`);
    return result;
  }

  for (const c of result.candidates) {
    const sizeColor = c.lineCount > 50 ? RED : c.lineCount > 20 ? YELLOW : GREEN;
    const retTag = c.endsInReturn ? color(" → return", CYAN) : "";
    process.stdout.write(`  ${color(`[${c.kind}]`, BOLD)} lines ${c.startLine}-${c.endLine}  ${color(`${c.lineCount}L`, sizeColor)}${retTag}\n`);
    process.stdout.write(`    ${color(c.preview, DIM)}\n`);
    const freeShort = c.freeVariables.slice(0, 12);
    const freeMore = c.freeVariables.length > 12 ? ` +${c.freeVariables.length - 12} more` : "";
    process.stdout.write(`    ${color(`free-vars (${c.freeVariables.length}):`, DIM)} ${freeShort.join(", ")}${freeMore}\n\n`);
  }

  const totalBranchLines = result.candidates.reduce((s, c) => s + c.lineCount, 0);
  const residual = result.fn.lineCount - totalBranchLines;
  process.stdout.write(`  ${color("If all branches extracted:", BOLD)} function body ≈ ${residual}L + ${result.candidates.length} helper(s)\n\n`);

  return result;
}

async function cmdPlan(args) {
  const file = args[0];
  if (!file) die("Usage: refactory plan <file> [--max-lines N] [--style functional|domain|layer]");

  const maxLines = parseFlag(args, "--max-lines", 500);
  const style = parseFlag(args, "--style", "functional");

  process.stdout.write(`Generating decomposition plan for ${color(path.resolve(file), BOLD)}...\n`);
  const result = await plan({ file, maxLines, style });

  header("Decomposition Plan");
  process.stdout.write(`  Provider: ${color(result._meta?.provider || "unknown", DIM)}\n`);
  process.stdout.write(`  Modules:  ${color(String(result.modules?.length || 0), BOLD)}\n\n`);

  for (const mod of result.modules || []) {
    process.stdout.write(`  ${color(mod.name, BOLD + CYAN)}  ~${mod.estimatedLines}L\n`);
    process.stdout.write(`    ${color(mod.description, DIM)}\n`);
    process.stdout.write(`    Functions: ${mod.functions.join(", ")}\n`);
    if (mod.dependencies?.length > 0) {
      process.stdout.write(`    Depends on: ${color(mod.dependencies.join(", "), DIM)}\n`);
    }
    process.stdout.write("\n");
  }

  if (result.sharedHelpers?.length > 0) {
    process.stdout.write(`  ${color("Shared helpers:", YELLOW)} ${result.sharedHelpers.join(", ")}\n`);
  }

  // Write plan to file
  const planPath = file.replace(/\.js$/, ".refactory-plan.json");
  fs.writeFileSync(planPath, JSON.stringify(result, null, 2), "utf8");
  process.stdout.write(`\n  ${color("Plan saved:", DIM)} ${planPath}\n\n`);

  return result;
}

async function cmdDecompose(args) {
  const file = args[0];
  if (!file) die("Usage: refactory decompose <file> [--output-dir dir] [--max-lines N] [--project-dir dir]");

  const outputDir = parseFlag(args, "--output-dir", null);
  const maxLines = parseFlag(args, "--max-lines", null);
  const maxModules = parseFlag(args, "--max-modules", null);
  const maxFunctionsPerModule = parseFlag(args, "--max-functions-per-module", null);
  const projectDir = parseFlag(args, "--project-dir", null);

  const opts = { file };
  if (outputDir) opts.outputDir = outputDir;
  if (maxLines) opts.maxLines = Number(maxLines);
  if (maxModules) opts.maxModules = Number(maxModules);
  if (maxFunctionsPerModule) opts.maxFunctionsPerModule = Number(maxFunctionsPerModule);
  if (projectDir) opts.projectDir = projectDir;

  header("Refactory Decompose");
  process.stdout.write(`  File: ${color(path.resolve(file), BOLD)}\n`);
  if (outputDir) process.stdout.write(`  Output: ${color(path.resolve(outputDir), DIM)}\n`);
  process.stdout.write("\n");

  const result = await decompose(opts);

  header("Result");
  process.stdout.write(`  Output:  ${color(result.outputDir, BOLD)}\n`);
  process.stdout.write(`  Report:  ${color(result.reportPath, BOLD)}\n`);
  process.stdout.write(`  Modules: ${color(String(result.moduleCount), BOLD)}\n`);
  process.stdout.write(`  Clean:   ${color(result.cleanRate + "%", result.cleanRate === 100 ? GREEN : YELLOW)}\n`);
  if (result.score !== undefined) {
    process.stdout.write(`  Score:   ${scoreBar(result.score)}\n`);
  }
  process.stdout.write("\n");
}

async function cmdVerify(args) {
  const dir = args[0];
  if (!dir) die("Usage: refactory verify <moduleDir> [--test 'npm test']");
  const testCmd = parseFlag(args, "--test", null);

  process.stdout.write(`Verifying ${color(path.resolve(dir), BOLD)}...\n`);
  const result = await verify({ moduleDir: dir, testCmd });

  header("Module Checks");
  for (const mod of result.modules) {
    const syntaxMark = mod.syntax ? color("✓ syntax", GREEN) : color("✗ syntax", RED);
    const loadMark = mod.loads ? color("✓ loads", GREEN) : color("✗ loads", RED);
    process.stdout.write(`  ${mod.file.padEnd(35)} ${syntaxMark}  ${loadMark}\n`);
    if (mod.syntaxError) process.stdout.write(`    ${color(mod.syntaxError, RED)}\n`);
    if (mod.loadError) process.stdout.write(`    ${color(mod.loadError, RED)}\n`);
    if (mod.exports?.length > 0) process.stdout.write(`    exports: ${color(mod.exports.join(", "), DIM)}\n`);
  }

  if (result.testOutput) {
    header("Test Output");
    process.stdout.write(result.testOutput + "\n");
  }

  header("Summary");
  const status = result.allClean ? color("ALL CLEAN", GREEN + BOLD) : color("ISSUES FOUND", RED + BOLD);
  process.stdout.write(`  ${status}\n\n`);
}

async function cmdProviders() {
  const available = getAvailableProviders();

  header("Capability Slots");
  const slotDescriptions = {
    LARGE_OUTPUT:  "32k+ output — large module extraction",
    LARGE_CONTEXT: "1M+ context — huge file planning",
    FAST:          "Fastest response — small tasks",
    CODE:          "Code-specialized models",
    GENERAL:       "General fallback",
  };
  let anySlot = false;
  for (const [slot, envVar] of Object.entries(CAPABILITY_SLOTS)) {
    const val = process.env[envVar];
    if (val) {
      const provider = val.split(":")[0];
      process.stdout.write(`  ${color("✓", GREEN)} ${envVar.padEnd(30)} ${color(provider, BOLD)}  ${color(slotDescriptions[slot], DIM)}\n`);
      anySlot = true;
    } else {
      process.stdout.write(`  ${color("·", DIM)} ${color(envVar.padEnd(30), DIM)} ${color("not set", DIM)}\n`);
    }
  }
  if (!anySlot) {
    process.stdout.write(`\n  ${color("Tip:", YELLOW)} Set capability slots for provider-agnostic config:\n`);
    process.stdout.write(`  ${color("  REFACTORY_KEY_LARGE_OUTPUT=groq:sk-xxx", DIM)}\n`);
    process.stdout.write(`  ${color("  REFACTORY_KEY_LARGE_CONTEXT=gemini:AIza-xxx", DIM)}\n`);
  }

  header("Active Providers");
  if (available.length === 0) {
    process.stdout.write(`  ${color("No providers configured.", RED)}\n`);
    process.stdout.write(`  Set capability slots above, or: GROQ_API_KEY, GOOGLE_API_KEY, OPENROUTER_API_KEY\n\n`);
    return;
  }
  for (const p of available) {
    process.stdout.write(`  ${color("✓", GREEN)} ${p.name.padEnd(30)} ${color(`${p.maxOutput / 1000}k output`, DIM)}\n`);
  }
  process.stdout.write("\n");
}

async function cmdLanguages() {
  header("Supported Languages");
  const langs = listLanguages();
  for (const lang of langs) {
    process.stdout.write(`  ${color("✓", GREEN)} ${color(lang.name.padEnd(30), BOLD)} ${color(lang.extensions.join(", "), DIM)}\n`);
  }
  process.stdout.write(`\n  ${color("Languages with a preprocessor use mechanical extraction (zero LLM tokens).", DIM)}\n`);
  process.stdout.write(`  ${color("Other languages fall back to LLM extraction with compression.", DIM)}\n\n`);
}

async function cmdTestSubmit(args) {
  const file = args[0];
  if (!file) die("Usage: refactory test submit <file> [--description 'what breaks']");

  const description = parseFlag(args, "--description", null) || parseFlag(args, "-d", null);

  header("Test Corpus Submission");
  const result = submitCorpus(file, description);
  process.stdout.write(`  ${color("Submitted:", GREEN)} ${path.basename(file)}\n`);
  process.stdout.write(`  Language:  ${color(result.language, BOLD)}\n`);
  process.stdout.write(`  Stored:    ${color(result.corpusPath, DIM)}\n`);
  process.stdout.write(`  Secrets:   ${color("stripped automatically", DIM)}\n\n`);
  process.stdout.write(`  ${color("Thank you!", BOLD)} This file is now a permanent test case.\n`);
  process.stdout.write(`  Run ${color("refactory test run", CYAN)} to validate all preprocessors against the corpus.\n\n`);
}

async function cmdTestRun() {
  header("Test Corpus");
  const results = runCorpus();

  if (results.total === 0) {
    process.stdout.write(`  ${color("No test corpus files found.", DIM)}\n`);
    process.stdout.write(`  Submit files with: ${color("refactory test submit <file>", CYAN)}\n\n`);
    return;
  }

  for (const r of results.results) {
    const icon = r.status === "pass" ? color("✓", GREEN)
      : r.status === "fail" ? color("✗", RED)
      : r.status === "error" ? color("!", RED)
      : color("·", DIM);
    const detail = r.status === "pass" ? `${r.functions} funcs, ${r.extracted} extracted`
      : r.status === "fail" ? r.error
      : r.status === "error" ? r.error
      : r.reason;
    process.stdout.write(`  ${icon} ${r.file.padEnd(45)} ${color(detail, r.status === "pass" ? DIM : RED)}\n`);
  }

  process.stdout.write(`\n  ${color("Results:", BOLD)} ${color(String(results.passed), GREEN)} passed, ${color(String(results.failed), results.failed > 0 ? RED : DIM)} failed, ${color(String(results.skipped), DIM)} skipped\n\n`);
}

// ─── Arg parsing helpers ──────────────────────────────────────────────────────

function parseFlag(args, flag, defaultVal) {
  const idx = args.indexOf(flag);
  if (idx === -1) return defaultVal;
  return args[idx + 1] || defaultVal;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const USAGE = `
${color("refactory", BOLD)} — mechanical code decomposition

${color("Commands:", BOLD)}
  analyze <file>              Health check: functions, dependencies, health score
  analyze-fn <file> --fn NAME Report extractable branches inside a function (non-destructive)
  plan <file>                 Generate decomposition plan (requires LLM key)
  decompose <file>            Full pipeline: analyze → plan → extract all → verify → report
  verify <dir>                Verify an extracted module directory
  providers                   Show configured LLM providers
  languages                   Show supported languages + preprocessor status

${color("Test Corpus:", BOLD)}
  test submit <file>          Submit a file that breaks extraction (secrets auto-stripped)
  test run                    Run all preprocessors against the test corpus

${color("Options:", BOLD)}
  --max-lines N               Max lines per module (plan/decompose, default: 500)
  --max-modules N             Target max number of output modules (default: 25)
  --max-functions-per-module N  Max functions per module before splitting (default: 30)
  --style functional|domain   Grouping strategy (plan, default: functional)
  --output-dir <dir>          Output directory (decompose, default: <dir>/lib/<basename>/)
  --project-dir <dir>         Project root for dependency mapping (decompose)
  --test 'npm test'           Test command to run after extraction (verify)
  --force                     Decompose even healthy files
  --force-llm                 Skip mechanical extraction, use LLM only

${color("Examples:", BOLD)}
  refactory analyze src/app.js
  refactory plan src/app.js --style domain
  refactory decompose myfile.js
  refactory decompose myfile.js --output-dir ./lib/mymodules
  refactory test submit broken-file.js -d "arrow functions with defaults"
  refactory test run
`;

async function main() {
  const [, , cmd, ...args] = process.argv;

  if (!cmd || cmd === "--help" || cmd === "-h") {
    process.stdout.write(USAGE + "\n");
    return;
  }

  try {
    switch (cmd) {
      case "analyze":    await cmdAnalyze(args); break;
      case "analyze-fn": await cmdAnalyzeFn(args); break;
      case "plan":       await cmdPlan(args); break;
      case "decompose":  await cmdDecompose(args); break;
      case "verify":     await cmdVerify(args); break;
      case "providers":  await cmdProviders(); break;
      case "languages":  await cmdLanguages(); break;
      case "test":
        if (args[0] === "submit") await cmdTestSubmit(args.slice(1));
        else if (args[0] === "run") await cmdTestRun();
        else die("Usage: refactory test submit <file> | refactory test run");
        break;
      default:
        die(`Unknown command: ${cmd}\nRun 'refactory --help' for usage.`);
    }
  } catch (err) {
    die(err.message);
  }
}

main();
