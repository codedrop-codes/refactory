"use strict";

/**
 * JavaScript/TypeScript mechanical preprocessor.
 *
 * Detects function boundaries via brace matching, resolves imports,
 * and assembles modules — zero LLM tokens, 100% syntax-valid output.
 */

// ── IIFE unwrapping ────────────────────────────────────────────────

/**
 * Detect and strip IIFE wrappers — ;(function() { ... }).call(this) etc.
 * Returns { source, unwrapped } where source is the inner body if IIFE found.
 * Supports: (function(){...}()), (function(){...}).call(this), !function(){...}()
 */
function unwrapIIFE(source) {
  const lines = source.split("\n");

  // Find IIFE opening in first 20 lines (allow license comments before it)
  let openLine = -1;
  for (let i = 0; i < Math.min(20, lines.length); i++) {
    const t = lines[i].trim();
    if (/^[;!]?\s*\(?\s*function\s*\(/.test(t)) {
      openLine = i;
      break;
    }
  }
  if (openLine === -1) return { source, unwrapped: false };

  // Find IIFE closing in last 20 lines
  let closeLine = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
    const t = lines[i].trim();
    if (/^\}\s*\)\s*[;.]?\s*$/.test(t) || /^\}\s*\.\s*call\s*\(/.test(t) || /^\}\s*\(\s*\)\s*\)\s*;?\s*$/.test(t)) {
      closeLine = i;
      break;
    }
  }
  if (closeLine === -1) return { source, unwrapped: false };

  // Extract inner body, preserving everything before the IIFE (license comments)
  const before = lines.slice(0, openLine).join("\n");
  const inner = lines.slice(openLine + 1, closeLine).join("\n");
  const result = before ? before + "\n" + inner : inner;
  return { source: result, unwrapped: true };
}

// ── Function detection ──────────────────────────────────────────────

const FUNC_PATTERNS = [
  // async function name(
  { re: /^(?:export\s+)?async\s+function\s+(\w+)\s*\(/, type: "async-function" },
  // function name(
  { re: /^(?:export\s+)?function\s+(\w+)\s*\(/, type: "function" },
  // const name = async function(   or   const name = async (
  { re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*async\s+(?:function\s*)?\(/, type: "async-arrow" },
  // const name = function(
  { re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*function\s*\(/, type: "function-expr" },
  // const name = (   — arrow function (only if followed by => on same or next line)
  { re: /^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*\(/, type: "arrow-candidate" },
  // class Name {
  { re: /^(?:export\s+)?class\s+(\w+)/, type: "class" },
];

function detectFunctions(source) {
  const lines = source.split("\n");
  const functions = [];

  for (let i = 0; i < lines.length; i++) {
    // Skip lines inside an already-detected function (avoids nested functions)
    if (functions.length > 0) {
      const last = functions[functions.length - 1];
      if (i > last.startLine && i <= last.endLine) continue;
    }

    const trimmed = lines[i].trimStart();

    for (const pattern of FUNC_PATTERNS) {
      const match = trimmed.match(pattern.re);
      if (!match) continue;

      // Arrow candidate: verify => exists within next 3 lines
      if (pattern.type === "arrow-candidate") {
        const window = lines.slice(i, i + 4).join("\n");
        if (!window.includes("=>")) continue;
      }

      const name = match[1];
      // Classes don't have a param list — use simple brace matching
      const endLine = pattern.type === "class"
        ? findBlockEndSimple(lines, i)
        : findBlockEnd(lines, i);
      if (endLine === -1) continue; // couldn't find closing brace/end

      functions.push({
        name,
        startLine: i,
        endLine,
        type: pattern.type,
        async: pattern.type.startsWith("async"),
        lineCount: endLine - i + 1,
      });
      break; // matched, don't try other patterns
    }
  }

  return functions;
}

/**
 * Find the end of a block starting at startLine.
 * Uses brace counting for JS, skipping strings, comments, and template expressions.
 *
 * Key challenge: default parameters like `function foo(options = {})` have braces
 * before the function body. We find the body-opening brace by first skipping past
 * the parameter list (balanced parentheses), then counting braces from there.
 */
function findBlockEnd(lines, startLine) {
  let depth = 0;
  let parenDepth = 0;
  let foundParamStart = false;
  let pastParams = false;
  let foundBodyOpen = false;
  let inBlockComment = false;
  let inString = null; // null, '"', "'", '`'
  let inTemplateExpr = 0; // depth of ${ } inside template literals

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];

    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];

      // Inside block comment
      if (inBlockComment) {
        if (ch === "*" && next === "/") { inBlockComment = false; j++; }
        continue;
      }

      // Inside string (non-template)
      if (inString && inString !== "`") {
        if (ch === "\\") { j++; continue; }
        if (ch === inString) inString = null;
        continue;
      }

      // Inside template literal
      if (inString === "`") {
        if (ch === "\\") { j++; continue; }
        if (ch === "$" && next === "{") {
          inTemplateExpr++;
          j++;
          continue;
        }
        if (inTemplateExpr > 0) {
          if (ch === "{") inTemplateExpr++;
          if (ch === "}") {
            inTemplateExpr--;
            // Don't count this brace — it's inside a template expression
          }
          continue;
        }
        if (ch === "`") inString = null;
        continue;
      }

      // Start of comment
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") { inBlockComment = true; j++; continue; }

      // Start of string
      if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }

      // Phase 1: skip past parameter list (parentheses)
      if (!pastParams) {
        if (ch === "(") { parenDepth++; foundParamStart = true; }
        if (ch === ")") {
          parenDepth--;
          if (foundParamStart && parenDepth === 0) pastParams = true;
        }
        continue;
      }

      // Phase 2: find body-opening brace, then count to closing
      if (ch === "{") {
        depth++;
        foundBodyOpen = true;
      }
      if (ch === "}") {
        depth--;
        if (foundBodyOpen && depth === 0) return i;
      }
    }
  }

  return -1; // unmatched
}

/** Simple brace matcher for class bodies (no parameter list to skip). */
function findBlockEndSimple(lines, startLine) {
  let depth = 0;
  let foundOpen = false;
  let inBlockComment = false;
  let inString = null;

  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];
      if (inBlockComment) { if (ch === "*" && next === "/") { inBlockComment = false; j++; } continue; }
      if (inString) { if (ch === "\\") { j++; continue; } if (ch === inString) inString = null; continue; }
      if (ch === "/" && next === "/") break;
      if (ch === "/" && next === "*") { inBlockComment = true; j++; continue; }
      if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
      if (ch === "{") { depth++; foundOpen = true; }
      if (ch === "}") { depth--; if (foundOpen && depth === 0) return i; }
    }
  }
  return -1;
}

// ── Import detection ────────────────────────────────────────────────

function detectImports(source) {
  const lines = source.split("\n");
  const imports = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    // require() — CommonJS
    const reqMatch = trimmed.match(/(?:const|let|var)\s+(?:\{[^}]+\}|\w+)\s*=\s*require\(["'`]([^"'`]+)["'`]\)/);
    if (reqMatch) {
      imports.push({ line: lines[i], lineNumber: i, module: reqMatch[1], type: "require" });
      continue;
    }

    // import ... from "..."  — ESM
    const esmMatch = trimmed.match(/^import\s+.+\s+from\s+["'`]([^"'`]+)["'`]/);
    if (esmMatch) {
      imports.push({ line: lines[i], lineNumber: i, module: esmMatch[1], type: "import" });
      continue;
    }

    // import "..." (side-effect)
    const sideMatch = trimmed.match(/^import\s+["'`]([^"'`]+)["'`]/);
    if (sideMatch) {
      imports.push({ line: lines[i], lineNumber: i, module: sideMatch[1], type: "import-side" });
      continue;
    }
  }

  return imports;
}

// ── Export detection ─────────────────────────────────────────────────

function detectExports(source) {
  const lines = source.split("\n");
  const exports = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    // module.exports = { ... }
    if (trimmed.startsWith("module.exports")) {
      // Collect multi-line module.exports
      let block = trimmed;
      if (trimmed.includes("{") && !trimmed.includes("}")) {
        for (let j = i + 1; j < lines.length && j < i + 30; j++) {
          block += "\n" + lines[j];
          if (lines[j].includes("}")) break;
        }
      }
      const names = [...block.matchAll(/\b(\w+)\b(?:\s*[:,}])/g)].map((m) => m[1])
        .filter((n) => n !== "module" && n !== "exports");
      exports.push({ lineNumber: i, names, type: "module.exports" });
    }

    // exports.name = ...
    const namedMatch = trimmed.match(/^exports\.(\w+)\s*=/);
    if (namedMatch) {
      exports.push({ lineNumber: i, names: [namedMatch[1]], type: "exports.name" });
    }
  }

  return exports;
}

// ── Import resolution ───────────────────────────────────────────────

/**
 * Determine which imports each function needs by scanning the function
 * body for references to imported identifiers.
 */
function resolveImports(functions, imports, source) {
  const lines = source.split("\n");
  const result = new Map();

  // Build a map of identifier → import line
  const identToImport = new Map();
  for (const imp of imports) {
    // Extract bound identifiers from the import line
    const destructured = imp.line.match(/\{([^}]+)\}/);
    if (destructured) {
      const names = destructured[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop().trim());
      for (const name of names) identToImport.set(name, imp);
    }
    const simpleMatch = imp.line.match(/(?:const|let|var|import)\s+(\w+)\s*[=\s]/);
    if (simpleMatch) identToImport.set(simpleMatch[1], imp);
  }

  for (const func of functions) {
    const body = lines.slice(func.startLine, func.endLine + 1).join("\n");
    const needed = new Set();

    for (const [ident, imp] of identToImport) {
      // Only valid JS identifiers — skip anything with special chars
      if (!/^\w+$/.test(ident)) continue;
      const re = new RegExp(`\\b${ident}\\b`);
      if (re.test(body)) needed.add(imp.line);
    }

    result.set(func.name, [...needed]);
  }

  return result;
}

// ── Dedent utility ──────────────────────────────────────────────────

/**
 * Remove common leading whitespace from a code block.
 * Handles functions extracted from inside IIFEs or nested scopes.
 */
function dedentBlock(text) {
  const lines = text.split("\n");
  // Find minimum indentation (ignoring empty lines)
  let minIndent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    const indent = line.match(/^(\s*)/)[1].length;
    if (indent < minIndent) minIndent = indent;
  }
  if (minIndent === 0 || minIndent === Infinity) return text;
  return lines.map((line) => line.slice(minIndent)).join("\n");
}

// ── Module assembly ─────────────────────────────────────────────────

/**
 * Assemble a module from extracted function bodies and their imports.
 *
 * @param {{ name: string, body: string }[]} functions
 * @param {string[]} importLines - Deduplicated import lines
 * @param {{ strict?: boolean, exportStyle?: "cjs"|"esm" }} options
 * @returns {string}
 */
function assembleModule(functions, importLines, options = {}) {
  const parts = [];

  if (options.strict !== false) parts.push('"use strict";');
  if (parts.length) parts.push("");

  // Imports (deduplicated, sorted)
  const uniqueImports = [...new Set(importLines)].sort();
  if (uniqueImports.length) {
    parts.push(...uniqueImports);
    parts.push("");
  }

  // Function bodies (dedented to top level if extracted from nested scope)
  for (let i = 0; i < functions.length; i++) {
    parts.push(dedentBlock(functions[i].body));
    if (i < functions.length - 1) parts.push("");
  }

  // Exports
  parts.push("");
  const names = functions.map((f) => f.name);
  if (options.exportStyle === "esm") {
    parts.push(`export { ${names.join(", ")} };`);
  } else {
    parts.push(`module.exports = { ${names.join(", ")} };`);
  }
  parts.push("");

  return parts.join("\n");
}

// ── Top-level mechanical extract ────────────────────────────────────

/**
 * Mechanically extract a module — no LLM needed.
 *
 * @param {string} source - Full source code
 * @param {string[]} functionNames - Names of functions to extract
 * @returns {{ code: string, extracted: string[], missing: string[] }}
 */
function extractModule(source, functionNames) {
  // Auto-unwrap IIFE wrappers so inner functions become top-level
  const { source: effectiveSource, unwrapped } = unwrapIIFE(source);
  const lines = effectiveSource.split("\n");
  const allFunctions = detectFunctions(effectiveSource);
  const allImports = detectImports(source);
  const importMap = resolveImports(allFunctions, allImports, source);

  const extracted = [];
  const missing = [];
  const bodies = [];
  const neededImports = new Set();

  for (const name of functionNames) {
    const func = allFunctions.find((f) => f.name === name);
    if (!func) {
      missing.push(name);
      continue;
    }

    const body = lines.slice(func.startLine, func.endLine + 1).join("\n");
    bodies.push({ name, body });
    extracted.push(name);

    // Collect imports this function needs
    const imports = importMap.get(name) || [];
    for (const imp of imports) neededImports.add(imp);
  }

  // Parse preamble into individual declarations, then include only
  // what this module's functions actually reference.
  const firstFuncLine = allFunctions.length > 0
    ? Math.min(...allFunctions.map((f) => f.startLine))
    : lines.length;

  // Find preamble boundary (stop at unbalanced brace for IIFEs)
  let preambleEnd = firstFuncLine;
  let braceCheck = 0;
  for (let i = 0; i < firstFuncLine; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") braceCheck++;
      if (ch === "}") braceCheck--;
    }
    if (braceCheck > 0) { preambleEnd = i; break; }
  }

  // Split preamble into individual declarations (handling multi-line)
  const declarations = [];
  let current = null;
  let depth = 0;
  for (let i = 0; i < preambleEnd; i++) {
    const line = lines[i];
    if (line.startsWith("#!")) continue; // skip shebang
    const trimmed = line.trimStart();
    if (!trimmed) continue; // skip blank lines

    // Start of a new declaration?
    const isStart = /^(?:const|let|var|\/\/|\/\*|"use strict")/.test(trimmed);
    if (isStart && depth === 0) {
      if (current) declarations.push(current);
      current = { startLine: i, lines: [line], names: [] };
      // Extract declared name(s)
      const nameMatch = trimmed.match(/^(?:const|let|var)\s+(?:\{([^}]+)\}|(\w+))/);
      if (nameMatch) {
        if (nameMatch[1]) {
          // Destructured: const { a, b } = ...
          current.names = nameMatch[1].split(",").map(s => s.trim().split(/\s*:\s*/)[0].trim()).filter(Boolean);
        } else {
          current.names = [nameMatch[2]];
        }
      }
    } else if (current) {
      current.lines.push(line);
    } else {
      // Orphan line before any declaration — treat as its own block
      current = { startLine: i, lines: [line], names: [] };
    }

    // Track brace/bracket depth for multi-line declarations
    for (const ch of line) {
      if (ch === "{" || ch === "[" || ch === "(") depth++;
      if (ch === "}" || ch === "]" || ch === ")") depth--;
    }
    // Declaration ends when depth returns to 0 and line ends with ;
    if (depth <= 0 && (trimmed.endsWith(";") || trimmed.endsWith(",") === false)) {
      depth = 0; // normalize
    }
  }
  if (current) declarations.push(current);

  // Now select only declarations referenced by this module's functions
  const allBodiesText = bodies.map((b) => b.body).join("\n");
  const selectedDecls = [];

  // Always include "use strict" and require() lines
  // Then include constants/variables only if referenced
  for (const decl of declarations) {
    const text = decl.lines.join("\n");
    const isStrict = text.includes('"use strict"') || text.includes("'use strict'");
    const isRequire = text.includes("require(");
    const isImport = text.trimStart().startsWith("import ");

    if (isStrict) {
      // Skip — assembleModule adds "use strict" already
      continue;
    }

    if (isRequire || isImport) {
      // Include require/import only if any of its exported names are used
      if (decl.names.length === 0) {
        // Side-effect require or couldn't parse name — include it
        selectedDecls.push(text);
      } else {
        const referenced = decl.names.some(n => /^\w+$/.test(n) && new RegExp(`\\b${n}\\b`).test(allBodiesText));
        if (referenced) selectedDecls.push(text);
      }
      continue;
    }

    // Constants/variables — include only if referenced
    if (decl.names.length > 0) {
      const referenced = decl.names.some(n => /^\w+$/.test(n) && new RegExp(`\\b${n}\\b`).test(allBodiesText));
      if (referenced) selectedDecls.push(text);
    }
  }

  const code = assembleModule(bodies, selectedDecls);

  return { code, extracted, missing };
}

module.exports = {
  id: "javascript",
  name: "JavaScript / TypeScript",
  extensions: [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"],
  detectFunctions,
  detectImports,
  detectExports,
  resolveImports,
  assembleModule,
  extractModule,
  unwrapIIFE,
  // Exported for testing
  findBlockEnd,
};
