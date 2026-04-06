"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

async function verify(args) {
  const moduleDir = path.resolve(args.moduleDir);
  const results = { modules: [], allClean: true, circularDeps: [], exportMismatch: [] };

  const files = fs.readdirSync(moduleDir).filter((f) => f.endsWith(".js"));

  for (const file of files) {
    const filePath = path.join(moduleDir, file);
    const entry = { file, syntax: false, loads: false, exports: [] };

    // Syntax check
    try {
      execSync(`node --check "${filePath}"`, { stdio: "pipe" });
      entry.syntax = true;
    } catch (e) {
      entry.syntaxError = e.stderr?.toString().split("\n")[0] || "syntax error";
      results.allClean = false;
    }

    // Load check
    if (entry.syntax) {
      try {
        const mod = require(filePath);
        entry.loads = true;
        entry.exports = Object.keys(mod);
      } catch (e) {
        entry.loadError = e.message.split("\n")[0];
        results.allClean = false;
      }
    }

    results.modules.push(entry);
  }

  // Test command
  if (args.testCmd) {
    try {
      const output = execSync(args.testCmd, { stdio: "pipe", cwd: path.resolve("."), timeout: 60000 });
      results.testOutput = output.toString().slice(-500);
      results.testsPassed = true;
    } catch (e) {
      results.testOutput = (e.stdout?.toString() || "").slice(-500);
      results.testsPassed = false;
      results.allClean = false;
    }
  }

  return results;
}

module.exports = { verify };
