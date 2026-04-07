"use strict";
const fs = require("node:fs");
const path = require("node:path");

const { analyze } = require("./analyze");
const { mapDependencies } = require("./depmap");
const { characterize } = require("./characterize");
const { plan } = require("./plan");
const { extract, validateSyntax } = require("./extract");
const { fixImports, generateReexport } = require("./fix-imports");
const { verify } = require("./verify");
const { metrics } = require("./metrics");
const { report } = require("./report");

function log(msg) {
  process.stderr.write(`Refactory: ${msg}\n`);
}

/**
 * Full decomposition pipeline — analyze, plan, extract, verify, report.
 *
 * @param {{ file: string, outputDir?: string, maxLines?: number, projectDir?: string }} args
 * @returns {Promise<object>} Combined result from all steps
 */
async function decompose(args) {
  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const ext = path.extname(filePath);
  const basename = path.basename(filePath, ext);
  const fileDir = path.dirname(filePath);
  const outputDir = args.outputDir
    ? path.resolve(args.outputDir)
    : path.join(fileDir, "lib", basename);
  const maxLines = args.maxLines || 500;
  const projectDir = args.projectDir ? path.resolve(args.projectDir) : fileDir;

  fs.mkdirSync(outputDir, { recursive: true });

  const result = { file: filePath, outputDir, steps: {} };

  // Step 1: Analyze
  let analysisResult;
  try {
    analysisResult = await analyze({ file: filePath });
    result.steps.analyze = analysisResult;
    log(`analyzing ${basename}${ext} (${analysisResult.lines} lines, ${analysisResult.functions} functions)`);
  } catch (err) {
    throw new Error(`Step analyze failed: ${err.message}`);
  }

  // Step 2: Depmap (if projectDir provided)
  if (args.projectDir) {
    try {
      const depResult = mapDependencies({ file: filePath, projectDir });
      result.steps.depmap = depResult;
      log(`depmap: ${depResult.consumers.length} consumers, ${depResult.dependencies.length} deps`);
    } catch (err) {
      throw new Error(`Step depmap failed: ${err.message}`);
    }
  }

  // Step 3: Characterize (golden snapshot)
  try {
    const charResult = characterize({ file: filePath, outputDir });
    result.steps.characterize = charResult;
    log(`characterize: ${charResult.exportCount} exports snapshotted`);
  } catch (err) {
    // Non-fatal — module may not be directly requireable
    log(`characterize: skipped (${err.message})`);
    result.steps.characterize = { skipped: true, reason: err.message };
  }

  // Step 4: Plan (via LLM)
  let planResult;
  try {
    planResult = await plan({ file: filePath, maxLines, maxModules: args.maxModules, maxFunctionsPerModule: args.maxFunctionsPerModule });
    result.steps.plan = planResult;
    const moduleCount = planResult.modules?.length || 0;
    const provider = planResult._meta?.provider || "unknown";
    log(`planning decomposition... ${moduleCount} modules via ${provider}`);
  } catch (err) {
    throw new Error(`Step plan failed: ${err.message}`);
  }

  const modules = planResult.modules || [];
  if (modules.length === 0) throw new Error("Plan produced zero modules — nothing to extract");

  // Step 5: Extract ALL modules (with auto-retry + split on failure)
  const extractResults = [];
  for (let i = 0; i < modules.length; i++) {
    const mod = modules[i];
    const funcs = mod.functions || [];

    // Attempt 1: extract full module
    let extResult;
    try {
      extResult = await extract({ file: filePath, module: mod.name, functions: funcs, outputDir });
    } catch (err) {
      extractResults.push({ module: mod.name, error: err.message });
      log(`extracting [${i + 1}/${modules.length}] ${mod.name}... FAILED: ${err.message}`);
      continue;
    }

    if (extResult.syntaxValid) {
      log(`extracting [${i + 1}/${modules.length}] ${mod.name}... ${extResult.lines}L OK via ${extResult.provider}`);
      extractResults.push(extResult);
      continue;
    }

    // Attempt 2: retry (provider fallback may pick a different model)
    log(`extracting [${i + 1}/${modules.length}] ${mod.name}... ${extResult.lines}L SYNTAX_ERR via ${extResult.provider} — retrying`);
    try {
      extResult = await extract({ file: filePath, module: mod.name, functions: funcs, outputDir });
    } catch (err) { /* fall through to split */ }

    if (extResult && extResult.syntaxValid) {
      log(`extracting [${i + 1}/${modules.length}] ${mod.name}... ${extResult.lines}L OK via ${extResult.provider} (retry)`);
      extractResults.push(extResult);
      continue;
    }

    // Attempt 3: split into two halves and combine
    if (funcs.length >= 4) {
      const mid = Math.ceil(funcs.length / 2);
      const partA = mod.name.replace(".js", "-a.js");
      const partB = mod.name.replace(".js", "-b.js");
      log(`extracting [${i + 1}/${modules.length}] ${mod.name}... splitting into ${partA} + ${partB}`);

      let combined = "";
      let splitOk = true;
      for (const [partName, partFuncs] of [[partA, funcs.slice(0, mid)], [partB, funcs.slice(mid)]]) {
        try {
          const partResult = await extract({ file: filePath, module: partName, functions: partFuncs, outputDir });
          if (partResult.syntaxValid) {
            const partCode = fs.readFileSync(path.join(outputDir, partName), "utf8");
            combined += partCode + "\n";
            fs.unlinkSync(path.join(outputDir, partName)); // clean up part files
          } else {
            splitOk = false;
          }
        } catch { splitOk = false; }
      }

      if (splitOk && combined) {
        const combinedPath = path.join(outputDir, mod.name);
        fs.writeFileSync(combinedPath, combined, "utf8");
        const syntax = validateSyntax(combinedPath);
        extResult = { module: mod.name, outputPath: combinedPath, lines: combined.split("\n").length, provider: "split", syntaxValid: syntax.valid, syntaxError: syntax.error };
        log(`extracting [${i + 1}/${modules.length}] ${mod.name}... ${extResult.lines}L ${syntax.valid ? "OK" : "SYNTAX_ERR"} (split+combine)`);
      } else {
        log(`extracting [${i + 1}/${modules.length}] ${mod.name}... split failed — keeping truncated version`);
      }
    } else {
      log(`extracting [${i + 1}/${modules.length}] ${mod.name}... too few functions to split — keeping truncated version`);
    }
    extractResults.push(extResult);
  }
  result.steps.extract = extractResults;

  const failed = extractResults.filter((r) => r.error);
  if (failed.length === modules.length) {
    throw new Error(`All ${modules.length} extractions failed`);
  }

  // Step 6: Fix imports
  try {
    const fixResult = fixImports({ moduleDir: outputDir, projectDir });
    result.steps.fixImports = fixResult;
    if (fixResult.fixed.length > 0) log(`fix-imports: ${fixResult.fixed.length} paths corrected`);
  } catch (err) {
    log(`fix-imports: skipped (${err.message})`);
    result.steps.fixImports = { skipped: true, reason: err.message };
  }

  // Step 7: Verify all modules
  let verifyResult;
  try {
    verifyResult = await verify({ moduleDir: outputDir });
    result.steps.verify = verifyResult;
    const clean = verifyResult.modules.filter((m) => m.syntax && m.loads).length;
    const total = verifyResult.modules.length;
    log(`verifying ${total} modules... ${clean}/${total} clean`);
  } catch (err) {
    throw new Error(`Step verify failed: ${err.message}`);
  }

  // Step 8: Metrics
  let metricsResult;
  try {
    metricsResult = await metrics({ original: filePath, moduleDir: outputDir });
    result.steps.metrics = metricsResult;
  } catch (err) {
    throw new Error(`Step metrics failed: ${err.message}`);
  }

  // Step 9: Generate thin re-export for original file
  try {
    const reexport = generateReexport({ originalFile: filePath, moduleDir: outputDir });
    result.steps.reexport = reexport;
    if (reexport.content) {
      const reexportPath = path.join(outputDir, "index.js");
      // Write as index.js in outputDir — don't overwrite original yet
      if (!fs.existsSync(reexportPath)) {
        fs.writeFileSync(reexportPath, reexport.content, "utf8");
      }
    }
  } catch (err) {
    log(`re-export: skipped (${err.message})`);
    result.steps.reexport = { skipped: true, reason: err.message };
  }

  // Step 10: Write reports (markdown + HTML)
  const metricsPath = path.join(outputDir, "refactory-metrics.json");
  const reportPath = path.join(outputDir, "REPORT.md");
  const htmlReportPath = path.join(outputDir, "REPORT.html");
  try {
    fs.writeFileSync(metricsPath, JSON.stringify(metricsResult, null, 2), "utf8");
    const reportResult = await report({ metricsFile: metricsPath, format: "markdown", outputPath: reportPath });
    result.steps.report = reportResult;
    // Also generate HTML report
    await report({ metricsFile: metricsPath, format: "html", outputPath: htmlReportPath });
    log(`reports: ${path.basename(reportPath)} + ${path.basename(htmlReportPath)}`);
  } catch (err) {
    throw new Error(`Step report failed: ${err.message}`);
  }

  // Summary line
  const cleanCount = verifyResult.modules.filter((m) => m.syntax && m.loads).length;
  const totalCount = verifyResult.modules.length;
  const cleanPct = totalCount > 0 ? Math.round((cleanCount / totalCount) * 100) : 0;
  const relReport = path.relative(fileDir, reportPath);
  log(`Score ${metricsResult.refactoryScore} | ${totalCount} modules | ${cleanPct}% clean | report: ${relReport}`);

  // Suggest next steps based on results
  const failedModules = verifyResult.modules.filter((m) => !m.syntax || !m.loads);
  const suggestions = [];
  suggestions.push("");
  suggestions.push("Copy-paste prompts for your next step (works in any AI tool):");
  suggestions.push("─".repeat(60));
  if (failedModules.length > 0) {
    suggestions.push("");
    suggestions.push(`Fix ${failedModules.length} broken module(s):`);
    for (const m of failedModules.slice(0, 3)) {
      suggestions.push(`  "${path.join(outputDir, m.file)} has a syntax error from truncated extraction. Read the original source at ${filePath}, find the functions that belong in this module, and rewrite the file completely."`);
    }
  }
  suggestions.push("");
  suggestions.push("Review:");
  suggestions.push(`  "Read ${relReport} — do the module boundaries make sense? Are related functions grouped together?"`);
  suggestions.push("");
  suggestions.push("Verify behavior:");
  suggestions.push(`  "Compare the exports of the new modules against the original ${path.basename(filePath)}. Make sure nothing was lost or renamed."`);
  suggestions.push("");
  suggestions.push("Ship it:");
  suggestions.push(`  "Replace ${path.basename(filePath)} with a thin re-export: const mod = require('./${path.relative(fileDir, outputDir)}/index'); module.exports = mod; — then run the test suite."`);
  suggestions.push("─".repeat(60));
  for (const line of suggestions) process.stderr.write(`${line}\n`);

  result.score = metricsResult.refactoryScore;
  result.moduleCount = totalCount;
  result.cleanRate = cleanPct;
  result.reportPath = reportPath;
  result.suggestions = suggestions.filter(Boolean);

  return result;
}

module.exports = { decompose };
