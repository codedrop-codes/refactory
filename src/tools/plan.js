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

async function plan(args) {
  const filePath = path.resolve(args.file);
  const source = fs.readFileSync(filePath, "utf8");
  const maxLines = args.maxLines || 500;
  const style = args.style || "functional";

  // Send function map instead of full source — fits in any provider's context
  const functionMap = extractFunctionMap(source);
  const estimatedInputTokens = Math.ceil(JSON.stringify(functionMap).length / 4);

  const prompt = `You are a senior software architect. Analyze this function map and produce a JSON decomposition plan.

Target: split into modules of max ${maxLines} lines each.
Grouping style: ${style}
Total source lines: ${functionMap.totalLines}

Function map (${functionMap.functions.length} functions):
${functionMap.functions.map((f) => `  ${f.line}-${f.endLine} (${f.estimatedLines}L): ${f.name}(${f.params})`).join("\n")}

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
