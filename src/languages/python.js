"use strict";

/**
 * Python mechanical preprocessor.
 *
 * Uses indentation-based block detection — no AST parser needed.
 */

// ── Function detection ──────────────────────────────────────────────

function getIndent(line) {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function detectFunctions(source) {
  const lines = source.split("\n");
  const functions = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    // def name(  or  async def name(
    const match = trimmed.match(/^(async\s+)?def\s+(\w+)\s*\(/);
    if (!match) continue;

    const isAsync = !!match[1];
    const name = match[2];
    const defIndent = getIndent(lines[i]);

    // Find end: next line at same or lesser indent (that isn't blank/comment)
    let endLine = i;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "" || line.trim().startsWith("#")) { endLine = j; continue; }
      if (getIndent(line) <= defIndent) break;
      endLine = j;
    }

    // Trim trailing blank lines
    while (endLine > i && lines[endLine].trim() === "") endLine--;

    functions.push({
      name,
      startLine: i,
      endLine,
      type: isAsync ? "async-def" : "def",
      async: isAsync,
      lineCount: endLine - i + 1,
    });
  }

  return functions;
}

// ── Class detection ─────────────────────────────────────────────────

function detectClasses(source) {
  const lines = source.split("\n");
  const classes = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();
    const match = trimmed.match(/^class\s+(\w+)/);
    if (!match) continue;

    const name = match[1];
    const classIndent = getIndent(lines[i]);

    let endLine = i;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (line.trim() === "" || line.trim().startsWith("#")) { endLine = j; continue; }
      if (getIndent(line) <= classIndent) break;
      endLine = j;
    }
    while (endLine > i && lines[endLine].trim() === "") endLine--;

    classes.push({ name, startLine: i, endLine, type: "class", lineCount: endLine - i + 1 });
  }

  return classes;
}

// ── Import detection ────────────────────────────────────────────────

function detectImports(source) {
  const lines = source.split("\n");
  const imports = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimStart();

    // import module  /  import module as alias
    if (trimmed.match(/^import\s+\w+/)) {
      const mod = trimmed.match(/^import\s+(\w+)/)[1];
      imports.push({ line: lines[i], lineNumber: i, module: mod, type: "import" });
      continue;
    }

    // from module import ...
    const fromMatch = trimmed.match(/^from\s+([\w.]+)\s+import\s+(.+)/);
    if (fromMatch) {
      imports.push({ line: lines[i], lineNumber: i, module: fromMatch[1], type: "from-import" });
      continue;
    }
  }

  return imports;
}

// ── Import resolution ───────────────────────────────────────────────

function resolveImports(functions, imports, source) {
  const lines = source.split("\n");
  const result = new Map();

  // Build identifier → import mapping
  const identToImport = new Map();
  for (const imp of imports) {
    const trimmed = imp.line.trim();

    // from X import a, b, c
    const fromMatch = trimmed.match(/^from\s+\S+\s+import\s+(.+)/);
    if (fromMatch) {
      const names = fromMatch[1].split(",").map((s) => s.trim().split(/\s+as\s+/).pop().trim());
      for (const name of names) identToImport.set(name, imp);
    }

    // import X  /  import X as Y
    const impMatch = trimmed.match(/^import\s+(\w+)(?:\s+as\s+(\w+))?/);
    if (impMatch) {
      identToImport.set(impMatch[2] || impMatch[1], imp);
    }
  }

  for (const func of functions) {
    const body = lines.slice(func.startLine, func.endLine + 1).join("\n");
    const needed = new Set();

    for (const [ident, imp] of identToImport) {
      if (new RegExp(`\\b${ident}\\b`).test(body)) needed.add(imp.line);
    }

    result.set(func.name, [...needed]);
  }

  return result;
}

// ── Module assembly ─────────────────────────────────────────────────

function assembleModule(functions, importLines, options = {}) {
  const parts = [];

  // Imports
  const uniqueImports = [...new Set(importLines)].sort();
  if (uniqueImports.length) {
    parts.push(...uniqueImports);
    parts.push("");
    parts.push("");
  }

  // Function bodies
  for (let i = 0; i < functions.length; i++) {
    parts.push(functions[i].body);
    if (i < functions.length - 1) { parts.push(""); parts.push(""); }
  }

  parts.push("");

  return parts.join("\n");
}

// ── Top-level mechanical extract ────────────────────────────────────

function extractModule(source, functionNames) {
  const lines = source.split("\n");
  const allFunctions = [...detectFunctions(source), ...detectClasses(source)];
  const allImports = detectImports(source);
  const importMap = resolveImports(allFunctions, allImports, source);

  const extracted = [];
  const missing = [];
  const bodies = [];
  const neededImports = new Set();

  for (const name of functionNames) {
    const func = allFunctions.find((f) => f.name === name);
    if (!func) { missing.push(name); continue; }

    const body = lines.slice(func.startLine, func.endLine + 1).join("\n");
    bodies.push({ name, body });
    extracted.push(name);

    const imports = importMap.get(name) || [];
    for (const imp of imports) neededImports.add(imp);
  }

  // Top-level constants (before first function)
  const firstFuncLine = allFunctions.length > 0
    ? Math.min(...allFunctions.map((f) => f.startLine))
    : lines.length;
  const topLevelConsts = [];
  for (let i = 0; i < firstFuncLine; i++) {
    const trimmed = lines[i].trimStart();
    if (trimmed.match(/^[A-Z_][A-Z0-9_]*\s*=/) || trimmed.match(/^\w+\s*=\s*[^(]/)) {
      const constName = trimmed.match(/^(\w+)/)?.[1];
      if (constName) {
        const allBodies = bodies.map((b) => b.body).join("\n");
        if (new RegExp(`\\b${constName}\\b`).test(allBodies)) {
          topLevelConsts.push(lines[i]);
        }
      }
    }
  }

  const importLines = [...neededImports, ...topLevelConsts];
  const code = assembleModule(bodies, importLines);

  return { code, extracted, missing };
}

module.exports = {
  id: "python",
  name: "Python",
  extensions: [".py", ".pyw"],
  detectFunctions,
  detectClasses,
  detectImports,
  resolveImports,
  assembleModule,
  extractModule,
};
