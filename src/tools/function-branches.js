"use strict";

/**
 * Function-branch analyzer.
 *
 * Non-destructive: reports extractable branches inside a single function —
 * top-level if/else-if chains, switch cases, try blocks, and loop bodies
 * that end in a `return` or otherwise look like dispatch branches.
 *
 * This is the PLANNING half of function-level decomposition. The execution
 * half (actual extraction) is a separate tool — manual guidance first,
 * automated later.
 *
 * Output per candidate: line range, first-line preview, line count,
 * ends-in-return flag, approximate free-variable set.
 */

const fs = require("node:fs");
const { detectFunctions, findBlockEnd } = require("../languages/javascript");

// Reserved words + globals that should never be treated as free variables.
const JS_RESERVED = new Set([
  "var", "let", "const", "function", "class", "return", "if", "else", "for",
  "while", "do", "switch", "case", "default", "break", "continue", "try",
  "catch", "finally", "throw", "new", "typeof", "instanceof", "in", "of",
  "delete", "void", "this", "super", "true", "false", "null", "undefined",
  "async", "await", "yield", "import", "export", "from", "as", "extends",
  "implements", "interface", "enum", "static", "public", "private", "protected",
  "abstract", "readonly", "declare", "module", "namespace", "require", "arguments",
]);

const JS_GLOBALS = new Set([
  "console", "Date", "Math", "JSON", "Promise", "Array", "Object", "String",
  "Number", "Boolean", "parseInt", "parseFloat", "isNaN", "isFinite", "process",
  "Buffer", "setTimeout", "setInterval", "clearTimeout", "clearInterval",
  "fetch", "AbortSignal", "AbortController", "Error", "TypeError", "RangeError",
  "Symbol", "Map", "Set", "WeakMap", "WeakSet", "RegExp", "globalThis", "NaN",
  "Infinity", "encodeURIComponent", "decodeURIComponent", "encodeURI", "decodeURI",
  "URL", "URLSearchParams", "Blob", "File", "FormData", "Headers", "Request",
  "Response", "queueMicrotask", "structuredClone",
]);

/**
 * Find the end of a `{ ... }` block starting at lineIdx, where lineIdx
 * contains the opening brace (possibly after other tokens). Uses the
 * same brace-counting helper that detectFunctions uses.
 *
 * Returns the 0-indexed line number of the closing brace, or -1.
 */
function findBraceBlockEnd(lines, startLine) {
  // Reuse the robust findBlockEnd by feeding it a synthetic "function"
  // opening. Simpler: write a local brace counter that handles strings
  // and comments at line granularity (good enough for line-level output).
  let depth = 0;
  let started = false;
  let inBlockComment = false;
  let inString = null;
  for (let i = startLine; i < lines.length; i++) {
    const line = lines[i];
    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      const next = line[j + 1];
      if (inBlockComment) {
        if (ch === "*" && next === "/") { inBlockComment = false; j++; }
        continue;
      }
      if (inString) {
        if (ch === "\\") { j++; continue; }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === "/" && next === "*") { inBlockComment = true; j++; continue; }
      if (ch === "/" && next === "/") break; // line comment
      if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
      if (ch === "{") { depth++; started = true; }
      else if (ch === "}") {
        if (!started) continue;   // leading } before the opening { — not ours
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return -1;
}

/**
 * Extract identifiers from a text block via a coarse regex. Strips string
 * literals, comments, and template interpolation markers. Not as precise as
 * a real AST walk but good enough for free-variable estimation.
 */
function extractIdentifiers(text) {
  // Remove block comments, line comments, and string literals so their
  // contents don't show up as fake identifiers.
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    // Template literals: keep ${} expressions so identifiers inside interpolations still count.
    .replace(/`(?:[^`\\$]|\\.|\$(?!\{))*`/g, "``");

  const ids = new Set();
  const re = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    const name = m[1];
    if (JS_RESERVED.has(name) || JS_GLOBALS.has(name)) continue;
    if (/^\d/.test(name)) continue;
    ids.add(name);
  }
  return ids;
}

/**
 * Collect identifiers declared inside a block (naive but covers most cases):
 *   const/let/var NAME = ...
 *   const/let/var { NAME, ... } = ...
 *   const/let/var [ NAME, ... ] = ...
 *   function NAME ...
 *   for (const NAME of ...) / for (let NAME = ...)
 *   catch (NAME)
 */
function extractDeclarations(text) {
  const declared = new Set();
  const patterns = [
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g,
    /\b(?:const|let|var)\s+\{([^}]+)\}\s*=/g,   // destructured object
    /\b(?:const|let|var)\s+\[([^\]]+)\]\s*=/g,  // destructured array
    /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)/g,
    /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:of|in|=)/g,
    /\bcatch\s*\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const captured = m[1];
      if (captured.includes(",") || captured.includes(":")) {
        // Destructured list — split and take identifier heads
        for (const part of captured.split(",")) {
          const id = part.trim().split(/[:=\s]/)[0].replace(/^\.\.\./, "");
          if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id)) declared.add(id);
        }
      } else {
        declared.add(captured);
      }
    }
  }
  return declared;
}

/**
 * Does the block end with a `return` at its own top level (inside the outermost
 * braces, not nested)? Heuristic: strip nested {...} and check for a bare
 * `return` before the closing brace.
 */
function endsInReturn(blockText) {
  // Remove nested { ... } bodies — repeatedly until none remain.
  let stripped = blockText;
  let prev;
  do {
    prev = stripped;
    stripped = stripped.replace(/\{[^{}]*\}/g, "{}");
  } while (stripped !== prev && stripped.length > 0);
  // Look for `return` as the last meaningful statement before outer `}`.
  return /\breturn\b[^;]*;?\s*\}\s*$/.test(stripped.trim()) ||
         /\breturn\b[^;]*;?\s*$/m.test(stripped.trimEnd().replace(/\}\s*$/, ""));
}

/**
 * Given a function node (from detectFunctions) and the full file lines,
 * return an array of candidate branches inside the function body.
 */
function analyzeFunctionBranches(lines, fn) {
  const candidates = [];
  // The function body is between the opening line (contains `{`) and endLine.
  // Scan top-level statements: find the opening brace line then iterate,
  // detecting `if (`, `switch (`, `try {`, `for (`, `while (` at top level.

  // Find the line with the opening brace of the function body.
  let bodyStart = fn.startLine;
  for (let i = fn.startLine; i <= fn.endLine; i++) {
    if (lines[i].includes("{")) { bodyStart = i; break; }
  }

  let i = bodyStart + 1;
  let depth = 1; // inside function body
  while (i < fn.endLine) {
    const line = lines[i];
    const trimmed = line.trim();

    // Only consider top-level statements (depth === 1).
    if (depth !== 1) {
      depth += braceDelta(line);
      i++;
      continue;
    }

    // Attempt branch detection on this line.
    let kind = null;
    let preview = "";
    if (/^if\s*\(/.test(trimmed)) {
      kind = "if";
      preview = trimmed.slice(0, 100);
    } else if (/^switch\s*\(/.test(trimmed)) {
      kind = "switch";
      preview = trimmed.slice(0, 100);
    } else if (/^try\s*\{/.test(trimmed) || trimmed === "try") {
      kind = "try";
      preview = "try { ... }";
    } else if (/^for\s*\(/.test(trimmed)) {
      kind = "for";
      preview = trimmed.slice(0, 100);
    } else if (/^while\s*\(/.test(trimmed)) {
      kind = "while";
      preview = trimmed.slice(0, 100);
    }

    if (kind) {
      // Find the end of this top-level block — for if/else-if chains, we
      // walk forward over `} else if` / `} else {` to capture the full chain.
      let endLine = findBraceBlockEnd(lines, i);
      if (endLine === -1) { i++; continue; }
      // Extend to capture `else if` / `else` continuations.
      if (kind === "if") {
        while (endLine + 1 < fn.endLine) {
          const nextTrim = (lines[endLine + 1] || "").trim();
          // Also handle `} else if ...` on the SAME line as the closing brace.
          const closingLine = lines[endLine];
          if (/\belse\b/.test(closingLine) && /\{\s*$/.test(closingLine)) {
            endLine = findBraceBlockEnd(lines, endLine);
            if (endLine === -1) break;
            continue;
          }
          if (/^else\b/.test(nextTrim)) {
            endLine = findBraceBlockEnd(lines, endLine + 1);
            if (endLine === -1) break;
            continue;
          }
          break;
        }
      }
      if (kind === "try") {
        // Capture following catch/finally. Handles both forms:
        //   }\n  catch (e) { ... }      (catch on its own line)
        //   } catch (e) { ... }          (catch on the closing-brace line)
        let prev = -1;
        while (endLine !== prev) {
          prev = endLine;
          const closingLine = lines[endLine] || "";
          const nextTrim = (lines[endLine + 1] || "").trim();
          if (/\}\s*(catch|finally)\b/.test(closingLine)) {
            endLine = findBraceBlockEnd(lines, endLine);
            if (endLine === -1) break;
            continue;
          }
          if (/^(catch|finally)\b/.test(nextTrim)) {
            if (endLine + 1 >= fn.endLine) break;
            endLine = findBraceBlockEnd(lines, endLine + 1);
            if (endLine === -1) break;
            continue;
          }
          break;
        }
      }
      // `if` extension: same-line `} else if` / `} else {` already handled above,
      // but also support `} else` appearing on the same line as the closing brace.
      if (kind === "if") {
        let prev = -1;
        while (endLine !== prev) {
          prev = endLine;
          const closingLine = lines[endLine] || "";
          if (/\}\s*else\b/.test(closingLine)) {
            endLine = findBraceBlockEnd(lines, endLine);
            if (endLine === -1) break;
            continue;
          }
          break;
        }
      }

      const blockText = lines.slice(i, endLine + 1).join("\n");
      const ids = extractIdentifiers(blockText);
      const declared = extractDeclarations(blockText);
      const free = [...ids].filter((id) => !declared.has(id));

      candidates.push({
        kind,
        preview,
        startLine: i + 1,        // 1-indexed for output
        endLine: endLine + 1,
        lineCount: endLine - i + 1,
        endsInReturn: endsInReturn(blockText),
        freeVariables: free.sort(),
      });

      i = endLine + 1;
      continue;
    }

    depth += braceDelta(line);
    i++;
  }

  return candidates;
}

function braceDelta(line) {
  // Naive but line-level: ignore string/comment content. Since our inputs
  // are well-formatted JS, this is accurate for depth tracking.
  let delta = 0;
  let inString = null;
  let inBlockComment = false;
  for (let j = 0; j < line.length; j++) {
    const ch = line[j];
    const next = line[j + 1];
    if (inBlockComment) {
      if (ch === "*" && next === "/") { inBlockComment = false; j++; }
      continue;
    }
    if (inString) {
      if (ch === "\\") { j++; continue; }
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === "/" && next === "*") { inBlockComment = true; j++; continue; }
    if (ch === "/" && next === "/") break;
    if (ch === '"' || ch === "'" || ch === "`") { inString = ch; continue; }
    if (ch === "{") delta++;
    else if (ch === "}") delta--;
  }
  return delta;
}

/**
 * Top-level: analyze one function in a file.
 */
function analyze(filePath, fnName, options = {}) {
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.split("\n");
  const functions = detectFunctions(source);
  const target = functions.find((f) => f.name === fnName);
  if (!target) {
    throw new Error(`function not found: ${fnName} (available: ${functions.map((f) => f.name).slice(0, 20).join(", ")}${functions.length > 20 ? ", ..." : ""})`);
  }
  const minBranchLines = options.minBranchLines || 5;
  const allBranches = analyzeFunctionBranches(lines, target);
  const candidates = allBranches.filter((b) => b.lineCount >= minBranchLines);

  return {
    file: filePath,
    fn: { name: target.name, startLine: target.startLine + 1, endLine: target.endLine + 1, lineCount: target.lineCount },
    candidates,
    dropped: allBranches.length - candidates.length,
    minBranchLines,
  };
}

module.exports = { analyze };
