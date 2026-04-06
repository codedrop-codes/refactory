"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { callWithFallback } = require("../providers/router");
const logger = require("../logger");

/**
 * Strip markdown code fences from LLM output.
 * ~30% of API-generated modules include fences that break .js files.
 */
function stripMarkdownFences(text) {
  let code = text;
  // Extract from fenced block if present
  const match = code.match(/```(?:javascript|js)\n([\s\S]*?)```/);
  if (match) return match[1].trim();
  // Strip standalone opening/closing fences
  const lines = code.split("\n");
  if (lines[0] && lines[0].trim().startsWith("```")) lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "```") lines.pop();
  return lines.join("\n").trim();
}

/**
 * Validate JavaScript syntax with node --check.
 * Returns { valid, error } — catches truncation and fence remnants.
 */
function validateSyntax(filePath) {
  try {
    execSync(`node --check "${filePath}"`, { stdio: "pipe", timeout: 10000 });
    return { valid: true, error: null };
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().split("\n")[0] : "unknown syntax error";
    return { valid: false, error: stderr };
  }
}

/**
 * Adaptive source compression for LLM extraction.
 * Adapted from CodeDrop's compression.v2 engine.
 *
 * Two non-destructive techniques:
 * 1. Indentation compression: leading spaces → ~cdi{n}: markers
 * 2. Keyword mapping: high-frequency identifiers → short tokens
 *
 * All content preserved (comments, logic, structure). Fully reversible.
 */
const INDENT_PREFIX = "~cdi";
const INDENT_SEP = ":";
const MAX_KEYWORD_TOKENS = 20;

// Token pools — chosen to never collide with JS syntax
const TOKEN_POOL = [
  "\u00A4", "\u00A7", "\u00B1", "\u00B5", "\u00BF",
  "\u00A1", "\u00A2", "\u00A3", "\u00A5", "\u00A6",
  "\u00A8", "\u00A9", "\u00AC", "\u00AE", "\u00B0",
  "\u00B2", "\u00B3", "\u00B4", "\u00B7", "\u00B8",
  "~0", "~1", "~2", "~3", "~4", "~5", "~6", "~7", "~8", "~9",
];

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function chooseTokens(text, max) {
  return TOKEN_POOL.filter(t => !text.includes(t)).slice(0, max);
}

function compressIndentation(text) {
  return text.replace(/^( {4,24})/gm, (m) => `${INDENT_PREFIX}${m.length}${INDENT_SEP}`);
}

function decompressIndentation(text) {
  return text.replace(new RegExp(`^${escapeRegExp(INDENT_PREFIX)}(\\d+)${escapeRegExp(INDENT_SEP)}`, "gm"),
    (_, n) => " ".repeat(parseInt(n, 10)));
}

function buildKeywordMap(text) {
  const counts = new Map();
  const matches = text.match(/\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g) || [];
  for (const w of matches) counts.set(w, (counts.get(w) || 0) + 1);

  const tokens = chooseTokens(text, MAX_KEYWORD_TOKENS);
  if (!tokens.length) return {};

  const candidates = Array.from(counts.entries())
    .filter(([term, count]) => count >= 3 && term.length >= 4)
    .sort((a, b) => (b[0].length * b[1]) - (a[0].length * a[1]));

  const map = {};
  let idx = 0;
  for (const [term, count] of candidates) {
    if (idx >= tokens.length) break;
    const token = tokens[idx];
    if (token.length >= term.length) continue;
    const net = count * (term.length - token.length) - (JSON.stringify(term).length + JSON.stringify(token).length + 2);
    if (net < 4) continue;
    map[term] = token;
    idx++;
  }
  return map;
}

function applyKeywordMap(text, map) {
  let out = text;
  for (const [term, token] of Object.entries(map)) {
    out = out.replace(new RegExp(`\\b${escapeRegExp(term)}\\b`, "g"), token);
  }
  return out;
}

function reverseKeywordMap(text, map) {
  let out = text;
  for (const [term, token] of Object.entries(map)) {
    out = out.replace(new RegExp(escapeRegExp(token), "g"), term);
  }
  return out;
}

function compressSource(source) {
  const originalLen = source.length;

  // Phase 1: adaptive keyword mapping (BEFORE indentation — avoids mapping indent markers)
  const keywordMap = buildKeywordMap(source);
  let compressed = Object.keys(keywordMap).length > 0
    ? applyKeywordMap(source, keywordMap)
    : source;
  const mapHeader = Object.keys(keywordMap).length > 0
    ? `MAP: ${JSON.stringify(keywordMap)}\n---\n`
    : "";

  // Phase 2: indentation compression (after keywords — indent markers won't get mapped)
  compressed = compressIndentation(compressed);

  const savedChars = originalLen - (compressed.length + mapHeader.length);
  const savedPct = originalLen > 0 ? Math.round((savedChars / originalLen) * 100) : 0;

  return {
    compressed: mapHeader + compressed,
    keywordMap,
    originalChars: originalLen,
    compressedChars: compressed.length + mapHeader.length,
    savedPct,
  };
}

function decompressOutput(text, keywordMap) {
  let out = text;
  // Reverse in opposite order: indentation first (applied last), then keywords
  out = decompressIndentation(out);
  if (Object.keys(keywordMap).length > 0) out = reverseKeywordMap(out, keywordMap);
  return out;
}

/**
 * Extract a module — mechanical first, LLM fallback.
 *
 * If a language preprocessor exists for the file type, extraction is 100%
 * mechanical (zero LLM tokens, guaranteed syntax validity). If not, falls
 * back to LLM extraction with adaptive compression.
 */
async function extract(args) {
  const filePath = path.resolve(args.file);
  const rawSource = fs.readFileSync(filePath, "utf8");
  const moduleName = args.module;
  const functions = args.functions || [];
  const outputDir = args.outputDir || path.join(path.dirname(filePath), "lib", path.basename(filePath, path.extname(filePath)));
  const forceLlm = args.forceLlm || false;

  fs.mkdirSync(outputDir, { recursive: true });

  // ── Try mechanical extraction first ─────────────────────────────
  const { getPreprocessor } = require("../languages");
  const preprocessor = getPreprocessor(filePath);

  if (preprocessor && !forceLlm) {
    const startMs = Date.now();
    try {
      const result = preprocessor.extractModule(rawSource, functions);
      const outputPath = path.join(outputDir, moduleName);
      fs.writeFileSync(outputPath, result.code, "utf8");

      const syntax = validateSyntax(outputPath);
      const durationMs = Date.now() - startMs;

      logger.step("EXTRACT", {
        module: moduleName,
        lines: result.code.split("\n").length,
        syntax: syntax.valid,
        provider: `mechanical/${preprocessor.id}`,
        durationMs,
      });

      if (result.missing.length > 0) {
        logger.debug(`Mechanical extract: missing functions: ${result.missing.join(", ")}`);
      }

      // If mechanical extraction produced valid syntax, we're done
      if (syntax.valid) {
        return {
          module: moduleName,
          outputPath,
          lines: result.code.split("\n").length,
          provider: `mechanical/${preprocessor.id}`,
          syntaxValid: true,
          syntaxError: null,
          mechanical: true,
          missing: result.missing,
        };
      }

      // Mechanical failed syntax — fall through to LLM
      logger.debug(`Mechanical extract syntax failed: ${syntax.error} — falling back to LLM`);
    } catch (err) {
      logger.debug(`Mechanical extract error: ${err.message} — falling back to LLM`);
    }
  }

  // ── LLM extraction with adaptive compression ───────────────────
  const { compressed: source, keywordMap, originalChars, compressedChars, savedPct } = compressSource(rawSource);
  const hasMap = Object.keys(keywordMap).length > 0;
  logger.debug(`Compressed ${originalChars} → ${compressedChars} chars (${savedPct}% saved${hasMap ? ", keyword map active" : ""})`);

  const estimatedInputTokens = Math.ceil(source.length / 4);
  const startMs = Date.now();

  const mapNote = hasMap
    ? "\n8. The source uses compressed tokens (MAP header shows replacements). Output your code using the SAME compressed tokens — they will be expanded automatically after extraction."
    : "";

  const prompt = `Extract a module from this source file. Output ONLY the complete JavaScript file in a code fence.

MODULE: ${moduleName}
FUNCTIONS TO EXTRACT: ${functions.join(", ")}

RULES:
1. "use strict"; at top
2. Include all require() imports the extracted functions need
3. Use relative paths for sibling modules
4. Preserve exact function signatures
5. module.exports at bottom
6. Do NOT truncate — include every function completely
7. Add reasonable spacing between functions for readability${mapNote}

SOURCE:
${source}`;

  const result = await callWithFallback(prompt, {
    minOutputTokens: 8000,
    preferHighOutput: true,
    estimatedInputTokens,
  });

  let code = stripMarkdownFences(result.content);
  code = decompressOutput(code, keywordMap);

  const outputPath = path.join(outputDir, moduleName);
  fs.writeFileSync(outputPath, code + "\n", "utf8");

  const syntax = validateSyntax(outputPath);
  const durationMs = Date.now() - startMs;

  logger.apiCall({
    provider: result.provider,
    inputTokens: estimatedInputTokens,
    outputTokens: Math.ceil(code.length / 4),
    durationMs,
  });
  logger.step("EXTRACT", {
    module: moduleName,
    lines: code.split("\n").length,
    syntax: syntax.valid,
    provider: result.provider,
    durationMs,
  });

  return {
    module: moduleName,
    outputPath,
    lines: code.split("\n").length,
    provider: result.provider,
    syntaxValid: syntax.valid,
    syntaxError: syntax.error,
    mechanical: false,
  };
}

module.exports = { extract, stripMarkdownFences, validateSyntax, compressSource, decompressOutput };
