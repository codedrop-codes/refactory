"use strict";
const fs = require("node:fs");
const path = require("node:path");

const RE_REQUIRE = /require\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;
const RE_DYNAMIC = /require\s*\(\s*(?!['"`])(.+?)\s*\)/g;
const RE_IMPORT_FROM = /import\s+(?:[\s\S]*?)\s+from\s+(['"`])([^'"`]+)\1/g;
const RE_IMPORT_SIDE = /import\s+(['"`])([^'"`]+)\1/g;

function extractRequires(source) {
  const statics = new Set(), dynamics = new Set();
  let m;
  const re1 = new RegExp(RE_REQUIRE.source, "g");
  while ((m = re1.exec(source))) statics.add(m[2]);
  const re2 = new RegExp(RE_DYNAMIC.source, "g");
  while ((m = re2.exec(source))) dynamics.add(m[1].trim());
  const re3 = new RegExp(RE_IMPORT_FROM.source, "g");
  while ((m = re3.exec(source))) statics.add(m[2]);
  const re4 = new RegExp(RE_IMPORT_SIDE.source, "g");
  while ((m = re4.exec(source))) statics.add(m[2]);
  return { static: [...statics], dynamic: [...dynamics] };
}

function resolveLocal(reqPath, fromFile, projectDir) {
  if (!reqPath.startsWith(".") && !reqPath.startsWith("/")) return null;
  const base = path.dirname(fromFile);
  for (const suffix of ["", ".js", ".ts", ".mjs", ".cjs", "/index.js", "/index.ts"]) {
    const abs = path.resolve(base, reqPath + suffix);
    if (abs.startsWith(projectDir) && fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  }
  return null;
}

function collectFiles(dir, exts = [".js", ".ts", ".mjs", ".cjs"]) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (ent.name !== "node_modules" && ent.name !== ".git") results.push(...collectFiles(full, exts));
    } else if (exts.some((e) => ent.name.endsWith(e))) {
      results.push(full);
    }
  }
  return results;
}

function readReqs(filePath) {
  return extractRequires(fs.readFileSync(filePath, "utf8"));
}

function mapDependencies({ file, projectDir }) {
  const projDir = path.resolve(projectDir || path.dirname(file));
  const absFile = path.resolve(file);
  const allFiles = collectFiles(projDir);
  const graph = {}, consumers = [], dependencies = [], dynamicRisks = [];
  const rel = (p) => path.relative(projDir, p);

  for (const f of allFiles) {
    const reqs = readReqs(f);
    const resolved = reqs.static
      .map((r) => resolveLocal(r, f, projDir))
      .filter(Boolean);
    graph[f] = resolved;
    if (f !== absFile && resolved.includes(absFile)) consumers.push(f);
    if (f === absFile) {
      dependencies.push(...resolved);
      reqs.dynamic.forEach((d) => dynamicRisks.push(`${rel(f)}: require(${d})`));
    }
  }
  // Flag dynamic requires in consumers of target
  for (const c of consumers) {
    const reqs = readReqs(c);
    reqs.dynamic.forEach((d) => dynamicRisks.push(`${rel(c)}: require(${d})`));
  }

  const relGraph = {};
  for (const [k, v] of Object.entries(graph)) relGraph[rel(k)] = v.map(rel);

  return { consumers: consumers.map(rel), dependencies: dependencies.map(rel), dynamicRisks, graph: relGraph };
}

function detectCircular(graph) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = {}, cycles = [];
  for (const n of Object.keys(graph)) color[n] = WHITE;

  function dfs(node, stack) {
    color[node] = GRAY;
    stack.push(node);
    for (const dep of graph[node] || []) {
      if (color[dep] === GRAY) {
        cycles.push([...stack.slice(stack.indexOf(dep)), dep]);
      } else if (color[dep] === WHITE) {
        dfs(dep, stack);
      }
    }
    stack.pop();
    color[node] = BLACK;
  }

  for (const n of Object.keys(graph)) {
    if (color[n] === WHITE) dfs(n, []);
  }
  return { hasCycles: cycles.length > 0, cycles };
}

function diffDependencies({ original, moduleDir, projectDir }) {
  const projDir = path.resolve(projectDir);
  const origResult = mapDependencies({ file: original, projectDir: projDir });
  const origConsumers = new Set(origResult.consumers);
  const modDir = path.resolve(projDir, moduleDir);
  const modFiles = collectFiles(modDir);
  const rel = (p) => path.relative(projDir, p);
  const newGraph = {}, orphaned = [];

  for (const f of modFiles) {
    const reqs = readReqs(f);
    const resolved = [];
    for (const r of reqs.static) {
      const abs = resolveLocal(r, f, projDir);
      if (abs) resolved.push(rel(abs));
      else if (r.startsWith(".")) orphaned.push(`${rel(f)} -> ${r}`);
    }
    newGraph[rel(f)] = resolved;
  }

  const modExports = new Set(modFiles.map(rel));
  const missing = [];
  for (const consumer of origConsumers) {
    const consumerAbs = path.resolve(projDir, consumer);
    if (!fs.existsSync(consumerAbs)) { missing.push(consumer); continue; }
    const reqs = readReqs(consumerAbs);
    const linked = reqs.static.some((r) => {
      const abs = resolveLocal(r, consumerAbs, projDir);
      return abs && modExports.has(rel(abs));
    });
    if (!linked) missing.push(consumer);
  }

  const circular = detectCircular(newGraph);
  return { satisfied: missing.length === 0 && orphaned.length === 0, missing, orphaned, newCircular: circular.cycles };
}

module.exports = { mapDependencies, detectCircular, diffDependencies, extractRequires };
