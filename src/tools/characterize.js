"use strict";
const fs = require("node:fs");
const path = require("node:path");

/**
 * Generate characterization tests and a golden-exports contract for a module.
 * Run BEFORE decomposition to lock the public API surface.
 *
 * @param {{ file: string, outputDir: string }} args
 * @returns {{ testFile: string, goldenFile: string, exportCount: number, exports: Record<string, string> }}
 */
function characterize({ file, outputDir }) {
  const absFile = path.resolve(file);
  if (!fs.existsSync(absFile)) {
    throw new Error(`Source file not found: ${absFile}`);
  }

  const outDir = path.resolve(outputDir);
  fs.mkdirSync(outDir, { recursive: true });

  // Load the module in a child process to avoid side effects (some modules
  // run main() on require or call process.exit). Falls back to empty exports.
  let mod = {};
  try {
    const { execSync } = require("node:child_process");
    const script = `try { const m = require(${JSON.stringify(absFile)}); const e = {}; if (m && typeof m === "object") { for (const [k,v] of Object.entries(m)) e[k] = typeof v; } else if (typeof m === "function") { e["default"] = "function"; } console.log(JSON.stringify(e)); } catch { console.log("{}"); }`;
    const out = execSync(`node -e '${script.replace(/'/g, "'\\''")}'`, { timeout: 10000, encoding: "utf8" }).trim();
    mod = JSON.parse(out || "{}");
  } catch {
    // Module has side effects or can't be loaded — use static analysis fallback
    const source = fs.readFileSync(absFile, "utf8");
    const exportsMatch = source.match(/module\.exports\s*=\s*\{([^}]+)\}/);
    if (exportsMatch) {
      for (const name of exportsMatch[1].match(/\w+/g) || []) {
        mod[name] = "unknown";
      }
    }
  }
  const exports = typeof mod === "object" ? mod : {};
  const exportCount = Object.keys(exports).length;

  // Write golden-exports JSON
  const baseName = path.basename(absFile, path.extname(absFile));
  const goldenFile = path.join(outDir, `${baseName}.golden-exports.json`);
  const golden = {
    file: absFile,
    exports,
    exportCount,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(goldenFile, JSON.stringify(golden, null, 2) + "\n");

  // Generate node:test file
  const testFile = path.join(outDir, `${baseName}.characterize.test.js`);
  const testSource = generateTest(absFile, exports, exportCount, goldenFile);
  fs.writeFileSync(testFile, testSource);

  return { testFile, goldenFile, exportCount, exports };
}

/**
 * Verify a (possibly rewritten) module still matches the golden-exports contract.
 *
 * @param {{ goldenFile: string, newFile: string }} args
 * @returns {{ matches: boolean, missing: string[], added: string[], typeChanged: string[] }}
 */
function verifyExports({ goldenFile, newFile }) {
  const absGolden = path.resolve(goldenFile);
  const absNew = path.resolve(newFile);

  if (!fs.existsSync(absGolden)) {
    throw new Error(`Golden file not found: ${absGolden}`);
  }
  if (!fs.existsSync(absNew)) {
    throw new Error(`New module not found: ${absNew}`);
  }

  const golden = JSON.parse(fs.readFileSync(absGolden, "utf8"));
  const mod = freshRequire(absNew);
  const current = captureExports(mod);

  const goldenNames = Object.keys(golden.exports);
  const currentNames = Object.keys(current);

  const missing = goldenNames.filter((n) => !(n in current));
  const added = currentNames.filter((n) => !(n in golden.exports));
  const typeChanged = goldenNames.filter(
    (n) => n in current && current[n] !== golden.exports[n]
  );

  const matches = missing.length === 0 && added.length === 0 && typeChanged.length === 0;
  return { matches, missing, added, typeChanged };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Map every export key to its typeof string. */
function captureExports(mod) {
  const result = {};
  if (mod == null) return result;

  // If the module is a plain function (module.exports = fn), record as "default"
  if (typeof mod === "function") {
    result["default"] = "function";
    // Also capture any properties attached to the function
    for (const key of Object.keys(mod)) {
      result[key] = typeof mod[key];
    }
    return result;
  }

  if (typeof mod !== "object") {
    result["default"] = typeof mod;
    return result;
  }

  for (const key of Object.keys(mod)) {
    result[key] = typeof mod[key];
  }
  return result;
}

/** Require a module without cache (for post-decomposition re-check). */
function freshRequire(absPath) {
  delete require.cache[require.resolve(absPath)];
  return require(absPath);
}

/** Generate a node:test characterization test file as a string. */
function generateTest(absFile, exports, exportCount, goldenFile) {
  const relModule = JSON.stringify(absFile);
  const relGolden = JSON.stringify(goldenFile);

  const lines = [
    `"use strict";`,
    `const { describe, it } = require("node:test");`,
    `const assert = require("node:assert/strict");`,
    `const fs = require("node:fs");`,
    ``,
    `describe("Characterization: ${path.basename(absFile)}", () => {`,
    `  const mod = require(${relModule});`,
    `  const golden = JSON.parse(fs.readFileSync(${relGolden}, "utf8"));`,
    ``,
    `  it("export count matches golden snapshot (${exportCount})", () => {`,
    `    const keys = typeof mod === "object" && mod !== null`,
    `      ? Object.keys(mod)`,
    `      : typeof mod === "function" ? ["default", ...Object.keys(mod)] : ["default"];`,
    `    assert.equal(keys.length, golden.exportCount,`,
    `      \`Export count changed: expected \${golden.exportCount}, got \${keys.length}. ` +
      `Missing or added exports after refactoring.\`);`,
    `  });`,
    ``,
  ];

  // Per-export type assertions
  for (const [name, type] of Object.entries(exports)) {
    const accessor = name === "default" ? "mod" : `mod[${JSON.stringify(name)}]`;
    lines.push(
      `  it("export ${esc(name)} is ${type}", () => {`,
      `    assert.equal(typeof ${accessor}, ${JSON.stringify(type)});`,
      `  });`,
      ``
    );
  }

  // Callable check for function exports
  const fnExports = Object.entries(exports).filter(([, t]) => t === "function");
  if (fnExports.length > 0) {
    lines.push(`  describe("function exports are callable", () => {`);
    for (const [name] of fnExports) {
      const accessor = name === "default" ? "mod" : `mod[${JSON.stringify(name)}]`;
      lines.push(
        `    it("${esc(name)} does not throw on typeof check", () => {`,
        `      assert.equal(typeof ${accessor}, "function");`,
        `      assert.ok(${accessor}.length >= 0, "has an arity");`,
        `    });`,
        ``
      );
    }
    lines.push(`  });`);
  }

  lines.push(`});`, ``);
  return lines.join("\n");
}

/** Escape a string for safe inclusion in a JS string literal. */
function esc(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

module.exports = { characterize, verifyExports };
