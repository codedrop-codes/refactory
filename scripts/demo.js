#!/usr/bin/env node
"use strict";
/**
 * Refactory Demo — runs a local analysis on the sample monolith.
 * No API keys required. Shows what the full pipeline would produce.
 */

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

const ROOT = path.resolve(__dirname, "..");
const SAMPLE = path.join(ROOT, "examples", "sample-monolith.js");
const EXPECTED_REPORT = path.join(ROOT, "examples", "expected-output", "REPORT.md");
const EXPECTED_README = path.join(ROOT, "examples", "expected-output", "README.md");

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const YELLOW = "\x1b[33m";

function c(str, code) {
  if (!process.stdout.isTTY) return str;
  return `${code}${str}${RESET}`;
}

function scoreBar(score, width = 20) {
  const filled = Math.round(score * width);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(width - filled);
  return c(bar, GREEN) + c(` ${(score * 100).toFixed(0)}%`, BOLD);
}

async function main() {
  console.log(`\n${c("Refactory Demo", BOLD + CYAN)}`);
  console.log(`${"=".repeat(50)}\n`);

  // Step 1: Copy sample to temp dir
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "refactory-demo-"));
  const tmpFile = path.join(tmpDir, "sample-monolith.js");
  fs.copyFileSync(SAMPLE, tmpFile);
  console.log(`${c("1.", BOLD)} Copied sample monolith to temp dir`);
  console.log(`   ${c(tmpFile, DIM)}\n`);

  // Step 2: Run local analysis (no API key needed)
  console.log(`${c("2.", BOLD)} Running local analysis (no API key needed)...\n`);

  let analyze;
  try {
    ({ analyze } = require(path.join(ROOT, "src", "tools", "analyze")));
  } catch (e) {
    console.log(`   ${c("Could not load analyzer — run 'npm install' first.", YELLOW)}`);
    console.log(`   Error: ${e.message}\n`);
    printDecomposePlan();
    cleanup(tmpDir);
    return;
  }

  try {
    const result = await analyze({ file: tmpFile });

    console.log(`   ${c("File Health", BOLD + CYAN)}`);
    console.log(`   ${"─".repeat(30)}`);
    console.log(`   Lines:      ${c(String(result.lines), BOLD)}`);
    console.log(`   Functions:  ${c(String(result.functions), BOLD)}`);
    console.log(`   Requires:   ${c(String(result.requires), BOLD)}`);
    console.log(`   Analysis:   ${c(result.analysisMode === "ast" ? "AST (ast-grep)" : "regex (fallback)", DIM)}`);
    console.log();
    console.log(`   ${c("Health Score", BOLD + CYAN)}`);
    console.log(`   ${"─".repeat(30)}`);
    console.log(`   Overall:    ${scoreBar(result.health.overall)}`);
    console.log(`   Lines:      ${scoreBar(result.health.linesScore)}`);
    console.log(`   Functions:  ${scoreBar(result.health.fnCountScore)}`);
    console.log(`   Fn size:    ${scoreBar(result.health.fnSizeScore)}`);
    console.log(`   Coupling:   ${scoreBar(result.health.couplingScore)}`);
    console.log();

    if (result.recommendation) {
      console.log(`   Recommendation: ${c(result.recommendation, BOLD + YELLOW)}`);
      console.log();
    }
  } catch (e) {
    console.log(`   ${c("Analysis error:", YELLOW)} ${e.message}\n`);
  }

  // Step 3: Show what decompose would produce
  printDecomposePlan();

  // Cleanup
  cleanup(tmpDir);

  // Step 4: How to run the real thing
  console.log(`${c("To run the full pipeline:", BOLD + GREEN)}`);
  console.log(`   export GROQ_API_KEY=... && refactory decompose examples/sample-monolith.js\n`);
}

function printDecomposePlan() {
  console.log(`${c("3.", BOLD)} Decomposition plan (from expected output):\n`);

  if (fs.existsSync(EXPECTED_README)) {
    const readme = fs.readFileSync(EXPECTED_README, "utf8");
    // Print the file list from expected output
    const lines = readme.split("\n");
    for (const line of lines) {
      if (line.startsWith("- **") || line.startsWith("## Files")) {
        console.log(`   ${line}`);
      }
    }
    console.log();
  }

  if (fs.existsSync(EXPECTED_REPORT)) {
    const report = fs.readFileSync(EXPECTED_REPORT, "utf8");

    // Extract and print the summary table
    const summaryMatch = report.match(/## Summary\n\n([\s\S]*?)(?=\n---)/);
    if (summaryMatch) {
      console.log(`   ${c("Expected Results", BOLD + CYAN)}`);
      console.log(`   ${"─".repeat(30)}`);
      for (const line of summaryMatch[1].trim().split("\n")) {
        console.log(`   ${line}`);
      }
      console.log();
    }

    // Extract and print module status table
    const moduleMatch = report.match(/## Module Status\n\n([\s\S]*?)(?=\n---)/);
    if (moduleMatch) {
      console.log(`   ${c("Module Status", BOLD + CYAN)}`);
      console.log(`   ${"─".repeat(30)}`);
      for (const line of moduleMatch[1].trim().split("\n")) {
        console.log(`   ${line}`);
      }
      console.log();
    }
  }
}

function cleanup(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

main().catch((e) => {
  console.error(`Demo failed: ${e.message}`);
  process.exit(1);
});
