"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { callWithFallback } = require("../providers/router");
const logger = require("../logger");

/**
 * Extract a function map from source — names, signatures, line ranges.
 * Much cheaper to send to LLM than full source (~10x token reduction).
 */
function extractFunctionMap(source) {
  const lines = source.split("\n");
  const functions = [];
  const requires = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    // Named function declarations (any indent level — handles IIFEs)
    const fnMatch = trimmed.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
    if (fnMatch) {
      functions.push({ name: fnMatch[1], params: fnMatch[2].trim(), line: i + 1 });
    }
    // var/const/let name = function( or arrow
    if (!fnMatch) {
      const exprMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:function\s*)?\(([^)]*)\)/);
      if (exprMatch) {
        functions.push({ name: exprMatch[1], params: exprMatch[2].trim(), line: i + 1 });
      }
    }
    const reqMatch = line.match(/require\(["']([^"']+)["']\)/);
    if (reqMatch && !requires.includes(reqMatch[1])) {
      requires.push(reqMatch[1]);
    }
  }

  // Estimate function end lines (next function start or EOF)
  for (let i = 0; i < functions.length; i++) {
    const next = functions[i + 1];
    functions[i].endLine = next ? next.line - 1 : lines.length;
    functions[i].estimatedLines = functions[i].endLine - functions[i].line + 1;
  }

  return { functions, requires, totalLines: lines.length };
}

/**
 * Build module groups by camelCase prefix for mechanical planning.
 * Merges small groups together to avoid too many tiny modules.
 */
function buildPrefixGroups(functions, maxLines, maxModules = 25, maxFunctionsPerModule = 30) {
  // Group by camelCase prefix
  const groups = new Map();
  for (const fn of functions) {
    const parts = fn.name.replace(/([a-z])([A-Z])/g, "$1\0$2").split("\0");
    let prefix = parts[0].toLowerCase();
    if (prefix.length <= 2 && parts.length > 1) prefix += parts[1].toLowerCase();
    if (prefix === "_" || prefix === "") prefix = "internal";
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(fn);
  }

  // Build initial module list
  let modules = [...groups.entries()].map(([prefix, fns]) => ({
    prefix,
    name: prefix + "-utils",
    functions: fns,
    totalLines: fns.reduce((s, f) => s + f.estimatedLines, 0),
  })).sort((a, b) => b.totalLines - a.totalLines);

  // Sort by source position for predictable output
  modules.sort((a, b) => a.functions[0].line - b.functions[0].line);

  // Phase 1: Merge tiny groups (< 30 lines) into neighbors
  let merged = [];
  let bucket = null;
  for (const mod of modules) {
    if (mod.totalLines >= 30 && mod.functions.length >= 2) {
      if (bucket) merged.push(bucket);
      merged.push(mod);
      bucket = null;
    } else {
      if (!bucket) {
        bucket = { ...mod, prefix: "misc", name: "misc-helpers", functions: [...mod.functions] };
      } else {
        bucket.functions.push(...mod.functions);
        bucket.totalLines += mod.totalLines;
        if (bucket.totalLines >= maxLines) {
          merged.push(bucket);
          bucket = null;
        }
      }
    }
  }
  if (bucket) merged.push(bucket);

  // Phase 2: If still over maxModules, keep merging the two smallest adjacent groups
  while (merged.length > maxModules) {
    let minSum = Infinity, minIdx = 0;
    for (let i = 0; i < merged.length - 1; i++) {
      const sum = merged[i].totalLines + merged[i + 1].totalLines;
      if (sum < minSum) { minSum = sum; minIdx = i; }
    }
    const a = merged[minIdx], b = merged[minIdx + 1];
    const combined = {
      prefix: a.prefix + "-" + b.prefix,
      name: a.totalLines >= b.totalLines ? a.name : b.name,
      functions: [...a.functions, ...b.functions],
      totalLines: a.totalLines + b.totalLines,
    };
    merged.splice(minIdx, 2, combined);
  }

  // Phase 3: Split any module over maxFunctionsPerModule
  const final = [];
  for (const mod of merged) {
    if (mod.functions.length <= maxFunctionsPerModule) {
      final.push(mod);
    } else {
      // Split into chunks
      for (let i = 0; i < mod.functions.length; i += maxFunctionsPerModule) {
        const chunk = mod.functions.slice(i, i + maxFunctionsPerModule);
        const partNum = Math.floor(i / maxFunctionsPerModule) + 1;
        final.push({
          prefix: mod.prefix,
          name: mod.name.replace(".js", "") + "-part" + partNum,
          functions: chunk,
          totalLines: chunk.reduce((s, f) => s + f.estimatedLines, 0),
        });
      }
    }
  }

  return final;
}

/**
 * Group functions by common prefix to produce a condensed summary.
 * E.g. arrayEach, arrayFilter, arrayMap → "array*" (3 fns, ~35L avg)
 */
function condenseFunctionMap(functions) {
  // Group by camelCase prefix: arrayEach → "array", baseFlatten → "base"
  const groups = new Map();
  for (const fn of functions) {
    // Split camelCase: "arrayEachRight" → ["array", "Each", "Right"]
    const parts = fn.name.replace(/([a-z])([A-Z])/g, "$1\0$2").split("\0");
    // Use first segment, or first two if first is very short (1-2 chars)
    let prefix = parts[0].toLowerCase();
    if (prefix.length <= 2 && parts.length > 1) prefix += parts[1].toLowerCase();
    // Collapse single-char prefixes like _ to "internal"
    if (prefix === "_" || prefix === "") prefix = "internal";
    if (!groups.has(prefix)) groups.set(prefix, []);
    groups.get(prefix).push(fn);
  }

  const lines = [];
  for (const [prefix, fns] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const totalLines = fns.reduce((s, f) => s + f.estimatedLines, 0);
    const avgLines = Math.round(totalLines / fns.length);
    if (fns.length === 1) {
      const f = fns[0];
      lines.push(`  ${f.name}(${f.params}) — ${f.estimatedLines}L`);
    } else {
      const names = fns.map(f => f.name);
      lines.push(`  ${prefix}* group (${fns.length} fns, ~${avgLines}L avg): ${names.join(", ")}`);
    }
  }
  return lines.join("\n");
}

async function plan(args) {
  const filePath = path.resolve(args.file);
  const source = fs.readFileSync(filePath, "utf8");
  const maxLines = args.maxLines || 500;
  const style = args.style || "functional";

  // Auto-unwrap IIFEs before extracting function map
  const { getPreprocessor } = require("../languages");
  const preprocessor = getPreprocessor(filePath);
  let effectiveSource = source;
  if (preprocessor) {
    if (preprocessor.stripIgnoreRegions) {
      const { source: stripped, stripped: didStrip } = preprocessor.stripIgnoreRegions(source);
      if (didStrip) { effectiveSource = stripped; logger.debug("@refactory-ignore regions stripped"); }
    }
    if (preprocessor.unwrapIIFE) {
      const { source: unwrapped, unwrapped: didUnwrap } = preprocessor.unwrapIIFE(effectiveSource);
      if (didUnwrap) { effectiveSource = unwrapped; logger.debug("IIFE wrapper detected and unwrapped for planning"); }
    }
  }

  // Send function map instead of full source — fits in any provider's context
  const functionMap = extractFunctionMap(effectiveSource);
  const estimatedInputTokens = Math.ceil(JSON.stringify(functionMap).length / 4);

  // For very large function lists, use mechanical grouping by prefix — no LLM needed
  if (functionMap.functions.length > 150) {
    const groups = buildPrefixGroups(functionMap.functions, maxLines, args.maxModules || 25, args.maxFunctionsPerModule || 30);
    const modules = groups.map(g => ({
      name: g.name + ".js",
      description: `${g.prefix}* functions (${g.functions.length} fns)`,
      functions: g.functions.map(f => f.name),
      estimatedLines: g.totalLines,
      dependencies: [],
    }));
    const planData = { modules, indexExports: [], sharedHelpers: [] };
    planData._meta = {
      provider: "mechanical/prefix-grouping",
      sourceFile: filePath,
      sourceLines: functionMap.totalLines,
      functionCount: functionMap.functions.length,
      generatedAt: new Date().toISOString(),
    };
    logger.step("PLAN", {
      file: filePath,
      modules: modules.length,
      provider: "mechanical/prefix-grouping",
      durationMs: 0,
    });
    return planData;
  }

  const functionList = functionMap.functions.map((f) => `  ${f.line}-${f.endLine} (${f.estimatedLines}L): ${f.name}(${f.params})`).join("\n");

  const conciseNote = functionMap.totalLines > 2000
    ? "Note: large file — prefer fewer, coarser modules over many small ones."
    : "";

  const prompt = `You are a senior software architect. Analyze this function map and produce a JSON decomposition plan.

Target: split into modules of max ${maxLines} lines each.
Grouping style: ${style}
Total source lines: ${functionMap.totalLines}
${conciseNote}

Function map (${functionMap.functions.length} functions):
${functionList}

Dependencies (require):
${functionMap.requires.map((r) => `  ${r}`).join("\n")}

Output ONLY valid JSON with this structure:
{
  "modules": [
    {
      "name": "module-name.js",
      "description": "what this module does",
      "functions": ["functionA", "functionB"],
      "estimatedLines": 300,
      "dependencies": ["other-module.js"]
    }
  ],
  "indexExports": ["list", "of", "original", "exports", "to", "preserve"],
  "sharedHelpers": ["functions", "needed", "by", "multiple", "modules"]
}`;

  const startMs = Date.now();
  const result = await callWithFallback(prompt, {
    minOutputTokens: 4000,
    estimatedInputTokens,
  });
  const durationMs = Date.now() - startMs;

  // Parse JSON from response — with repair for common LLM output issues
  const jsonMatch = result.content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to generate valid plan JSON");

  let jsonStr = jsonMatch[0];

  // Repair common LLM JSON issues
  // 1. Trailing commas before } or ]
  jsonStr = jsonStr.replace(/,\s*([\]}])/g, "$1");
  // 2. Strip JS-style comments
  jsonStr = jsonStr.replace(/\/\/[^\n]*/g, "");
  // 3. Fix truncated JSON — close unclosed brackets/braces
  let opens = 0, closes = 0;
  for (const ch of jsonStr) { if (ch === "{" || ch === "[") opens++; if (ch === "}" || ch === "]") closes++; }
  if (opens > closes) {
    // Find what needs closing by tracking the stack
    const stack = [];
    for (const ch of jsonStr) {
      if (ch === "{") stack.push("}");
      if (ch === "[") stack.push("]");
      if (ch === "}" || ch === "]") stack.pop();
    }
    jsonStr += stack.reverse().join("");
  }

  let planData;
  try {
    planData = JSON.parse(jsonStr);
  } catch (firstErr) {
    // Try replacing single quotes with double quotes
    try {
      planData = JSON.parse(jsonStr.replace(/'/g, '"'));
    } catch {
      // Log the problematic JSON for debugging
      logger.debug(`Plan JSON failed. First 200 chars: ${jsonStr.slice(0, 200)}`);
      logger.debug(`Last 200 chars: ${jsonStr.slice(-200)}`);
      throw new Error(`Plan JSON parse failed: ${firstErr.message}`);
    }
  }
  planData._meta = {
    provider: result.provider,
    sourceFile: filePath,
    sourceLines: functionMap.totalLines,
    functionCount: functionMap.functions.length,
    generatedAt: new Date().toISOString(),
  };

  logger.step("PLAN", {
    file: filePath,
    modules: planData.modules.length,
    provider: result.provider,
    durationMs,
  });

  return planData;
}

module.exports = { plan, extractFunctionMap };
