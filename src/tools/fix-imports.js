"use strict";
const fs = require("node:fs");
const path = require("node:path");

const REQUIRE_RE = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

/**
 * Collect all .js files under a directory (recursive).
 */
function collectFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules") {
      results.push(...collectFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Resolve a require path to an actual file, or null if not found.
 * Handles ./foo, ./foo.js, ./foo/index.js patterns.
 */
function resolveRequire(fromFile, reqPath) {
  if (!reqPath.startsWith(".")) return null; // skip bare specifiers
  const dir = path.dirname(fromFile);
  const abs = path.resolve(dir, reqPath);
  const candidates = [
    abs,
    abs + ".js",
    abs + ".json",
    path.join(abs, "index.js"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  }
  return null;
}

/**
 * Scan a module directory for broken require() calls.
 * A require is "broken" if it uses a relative path that doesn't resolve.
 */
function scanBrokenRequires({ moduleDir }) {
  const broken = [];
  const files = collectFiles(moduleDir);
  for (const file of files) {
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      let m;
      REQUIRE_RE.lastIndex = 0;
      while ((m = REQUIRE_RE.exec(lines[i])) !== null) {
        const reqPath = m[2];
        if (!reqPath.startsWith(".")) continue;
        const resolved = resolveRequire(file, reqPath);
        if (!resolved) {
          broken.push({
            file,
            line: i + 1,
            require: reqPath,
            error: `Cannot resolve "${reqPath}" from ${path.relative(moduleDir, file)}`,
          });
        }
      }
    }
  }
  return broken;
}

/**
 * Find the best target file for a broken require within the module dir.
 * Matches by basename — e.g. "../../my-module" finds "my-module.js"
 * or "my-module/index.js" inside moduleDir.
 */
function findTarget(moduleDir, reqBasename) {
  const name = path.basename(reqBasename);
  const files = collectFiles(moduleDir);
  // Exact basename match
  for (const f of files) {
    if (path.basename(f, ".js") === name) return f;
  }
  // index.js inside a matching directory
  for (const f of files) {
    if (path.basename(f) === "index.js" && path.basename(path.dirname(f)) === name) return f;
  }
  return null;
}

/**
 * Calculate the correct relative require path from source to target.
 */
function relativeRequirePath(fromFile, toFile) {
  const fromDir = path.dirname(fromFile);
  let rel = path.relative(fromDir, toFile).replace(/\\/g, "/");
  // Strip .js extension (Node resolves without it)
  if (rel.endsWith(".js")) rel = rel.slice(0, -3);
  // Strip trailing /index
  if (rel.endsWith("/index")) rel = rel.slice(0, -6);
  if (!rel.startsWith(".")) rel = "./" + rel;
  return rel;
}

/**
 * Fix broken require paths across a module and its consumers.
 */
function fixImports({ moduleDir, projectDir, dryRun = false }) {
  const fixed = [];
  const errors = [];
  const modDirAbs = path.resolve(moduleDir);
  const projDirAbs = path.resolve(projectDir);

  // Phase 1: fix broken requires inside moduleDir
  const broken = scanBrokenRequires({ moduleDir: modDirAbs });
  for (const b of broken) {
    const target = findTarget(modDirAbs, b.require);
    if (!target) {
      errors.push(`No target found for "${b.require}" in ${b.file}:${b.line}`);
      continue;
    }
    const newPath = relativeRequirePath(b.file, target);
    if (newPath === b.require) continue;
    if (!dryRun) {
      let src = fs.readFileSync(b.file, "utf8");
      // Replace this specific require string (escape for regex)
      const escaped = b.require.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      src = src.replace(
        new RegExp(`(require\\s*\\(\\s*['"])${escaped}(['"]\\s*\\))`, "g"),
        `$1${newPath}$2`
      );
      fs.writeFileSync(b.file, src, "utf8");
    }
    fixed.push({ file: b.file, old: b.require, new: newPath });
  }

  // Phase 2: scan project consumers outside moduleDir
  const projFiles = collectFiles(projDirAbs).filter(
    (f) => !f.startsWith(modDirAbs + path.sep)
  );
  for (const file of projFiles) {
    const src = fs.readFileSync(file, "utf8");
    let m;
    REQUIRE_RE.lastIndex = 0;
    while ((m = REQUIRE_RE.exec(src)) !== null) {
      const reqPath = m[2];
      if (!reqPath.startsWith(".")) continue;
      const resolved = resolveRequire(file, reqPath);
      if (resolved) continue; // already works
      // Try to find it in moduleDir
      const target = findTarget(modDirAbs, reqPath);
      if (!target) continue; // not a module-related require
      const newPath = relativeRequirePath(file, target);
      if (newPath === reqPath) continue;
      if (!dryRun) {
        let content = fs.readFileSync(file, "utf8");
        const escaped = reqPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        content = content.replace(
          new RegExp(`(require\\s*\\(\\s*['"])${escaped}(['"]\\s*\\))`, "g"),
          `$1${newPath}$2`
        );
        fs.writeFileSync(file, content, "utf8");
      }
      fixed.push({ file, old: reqPath, new: newPath });
    }
  }

  return { fixed, errors };
}

/**
 * Generate a thin re-export shim at the original monolith location.
 */
function generateReexport({ originalFile, moduleDir }) {
  const origAbs = path.resolve(originalFile);
  const modAbs = path.resolve(moduleDir);
  const name = path.basename(modAbs);
  // Find the entry point (index.js) in the module
  const indexFile = path.join(modAbs, "index.js");
  const target = fs.existsSync(indexFile) ? indexFile : collectFiles(modAbs)[0];
  if (!target) {
    return { path: origAbs, content: null };
  }
  const rel = relativeRequirePath(origAbs, target);
  const content = [
    `"use strict";`,
    `// Thin re-export — original module extracted to ${path.relative(path.dirname(origAbs), modAbs)}/`,
    `const mod = require("${rel}");`,
    `module.exports = mod;`,
    "",
  ].join("\n");
  return { path: origAbs, content };
}

module.exports = { fixImports, generateReexport, scanBrokenRequires };
