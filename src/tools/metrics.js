"use strict";
const fs = require("node:fs");
const path = require("node:path");

async function metrics(args) {
  const originalPath = path.resolve(args.original);
  const moduleDir = path.resolve(args.moduleDir);

  const originalSource = fs.readFileSync(originalPath, "utf8");
  const originalLines = originalSource.split("\n").length;
  const originalFunctions = (originalSource.match(/^(?:async\s+)?function\s+\w+/gm) || []).length;

  const moduleFiles = fs.readdirSync(moduleDir).filter((f) => f.endsWith(".js"));
  let totalModuleLines = 0;
  let maxModuleLines = 0;
  let modulesClean = 0;
  const moduleStats = [];

  for (const file of moduleFiles) {
    const content = fs.readFileSync(path.join(moduleDir, file), "utf8");
    const lines = content.split("\n").length;
    totalModuleLines += lines;
    maxModuleLines = Math.max(maxModuleLines, lines);

    let clean = false;
    try { require(path.join(moduleDir, file)); clean = true; modulesClean++; } catch {}

    moduleStats.push({ file, lines, clean });
  }

  const cleanRate = moduleFiles.length > 0 ? modulesClean / moduleFiles.length : 0;
  const sizeReduction = maxModuleLines < originalLines ? 1 : originalLines / maxModuleLines;
  const score = cleanRate * Math.min(sizeReduction, 1.0);

  return {
    original: {
      file: originalPath,
      lines: originalLines,
      functions: originalFunctions,
    },
    decomposed: {
      moduleCount: moduleFiles.length,
      totalLines: totalModuleLines,
      maxModuleLines,
      avgModuleLines: Math.round(totalModuleLines / Math.max(moduleFiles.length, 1)),
      modulesClean,
      cleanRate: Math.round(cleanRate * 100),
      modules: moduleStats,
    },
    refactoryScore: Math.round(score * 100) / 100,
    timestamp: new Date().toISOString(),
  };
}

module.exports = { metrics };
