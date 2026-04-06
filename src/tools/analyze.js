"use strict";
const fs = require("node:fs");
const path = require("node:path");

let sgParse, sgLang;
try { const sg = require("@ast-grep/napi"); sgParse = sg.parse; sgLang = sg.Lang; } catch (_) {}

const KW_FILTER = /^(if|else|for|while|do|switch|catch|return|throw|new|delete|typeof|void|yield|await|try)$/;
const DB_PAT = /\b(?:query|execute|sql|db\.|database|knex|prisma|sequelize|mongoose|\.find\(|\.insert|\.update|\.delete|\.create\(|\.save\(|\.remove\(|\.aggregate\()/i;
const FS_PAT = /\b(?:fs\.|readFile|writeFile|readdir|mkdir|unlink|createReadStream|createWriteStream|path\.join|path\.resolve)/;
const HTTP_PAT = /\b(?:fetch\(|axios|http\.|https\.|\.get\(|\.post\(|\.put\(|\.delete\(|request\(|got\(|superagent)/;
const CONC_PAT = /\b(?:setTimeout|setInterval|Promise\.all|Promise\.race|Promise\.allSettled|new Promise|process\.nextTick|queueMicrotask)/;
const BIZ_COMMENT = /\b(HACK|WORKAROUND|SAFETY|BUSINESS|DO\s*NOT|IMPORTANT|FIXME|XXX|MAGIC|HARDCODE)/i;
const MAGIC_NUM = /(?<!\w)(?:(?:===?|!==?|>=?|<=?|%)\s*(?:[2-9]\d{1,}|[1-9]\d{2,}))\b/;
const NULL_CHAIN = /(?:\?\.|!= null|!== null|!== undefined|!= undefined|\|\||if\s*\(\s*!\w)/;

// --- AST extraction (ast-grep) ---
function astExtractFunctions(root) {
  const results = [], seen = new Set();
  const push = (name, node, kind) => {
    const r = node.range(), key = `${name}:${r.start.line}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ name, startLine: r.start.line + 1, endLine: r.end.line + 1, kind });
  };
  for (const pat of ["function $N($$$) {$$$}", "async function $N($$$) {$$$}"]) {
    for (const n of root.findAll(pat)) {
      const name = n.getMatch("N")?.text();
      if (name) push(name, n, pat.startsWith("async") ? "async_function" : "function");
    }
  }
  for (const pat of [
    "const $N = ($$$) => $$$", "const $N = async ($$$) => $$$",
    "const $N = $P => $$$", "const $N = async $P => $$$",
    "let $N = ($$$) => $$$", "let $N = async ($$$) => $$$",
    "var $N = ($$$) => $$$", "var $N = async ($$$) => $$$",
  ]) {
    for (const n of root.findAll(pat)) {
      const name = n.getMatch("N")?.text();
      if (name) push(name, n, pat.includes("async") ? "async_arrow" : "arrow");
    }
  }
  (function walk(node) {
    if (node.kind() === "method_definition") {
      const nn = node.children().find(c => c.kind() === "property_identifier" || c.kind() === "private_property_identifier");
      if (nn) {
        const txt = node.text().trimStart();
        const isStatic = txt.startsWith("static");
        const isAsync = txt.replace(/^static\s*/, "").startsWith("async");
        push(nn.text(), node, isStatic ? "static_method" : isAsync ? "async_method" : "method");
      }
    }
    for (const c of node.children()) walk(c);
  })(root);
  return results.sort((a, b) => a.startLine - b.startLine);
}

function astExtractRequires(root) {
  const results = [], seen = new Set();
  for (const n of root.findAll("require($P)")) {
    const raw = n.getMatch("P")?.text();
    if (!raw) continue;
    const mod = raw.replace(/^['"`]|['"`]$/g, ""), line = n.range().start.line + 1;
    const key = `${mod}:${line}`;
    if (!seen.has(key)) { seen.add(key); results.push({ module: mod, line }); }
  }
  return results;
}

// --- Regex fallback ---
function regexExtractFunctions(lines) {
  const fns = [], braceStack = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fnMatch = line.match(/^(?:export\s+)?(?:(async)\s+)?function\s+(\w+)\s*\(/);
    const arrowMatch = !fnMatch && line.match(/^(?:const|let|var)\s+(\w+)\s*=\s*(async\s+)?(?:\([^)]*\)|[\w]+)\s*=>/);
    const methodMatch = !fnMatch && !arrowMatch && line.match(/^\s+(?:(static)\s+)?(?:(async)\s+)?(\w+)\s*\([^)]*\)\s*\{/);
    const validMethod = methodMatch && !KW_FILTER.test(methodMatch[3]);
    if (fnMatch || arrowMatch || validMethod) {
      if (current) { current.endLine = i; fns.push(current); }
      const name = fnMatch ? fnMatch[2] : arrowMatch ? arrowMatch[1] : methodMatch[3];
      const isAsync = fnMatch ? !!fnMatch[1] : arrowMatch ? !!arrowMatch[2] : validMethod ? !!methodMatch[2] : false;
      let kind = fnMatch ? "function" : arrowMatch ? "arrow" : (validMethod && methodMatch[1] ? "static_method" : "method");
      if (isAsync && kind === "function") kind = "async_function";
      if (isAsync && kind === "arrow") kind = "async_arrow";
      if (isAsync && kind === "method") kind = "async_method";
      current = { name, startLine: i + 1, endLine: i + 1, kind };
    }
    for (const ch of line) {
      if (ch === "{") braceStack.push(i);
      if (ch === "}" && braceStack.length) braceStack.pop();
    }
    if (current && braceStack.length === 0 && line.includes("}")) {
      current.endLine = i + 1; fns.push(current); current = null;
    }
  }
  if (current) { current.endLine = lines.length; fns.push(current); }
  return fns;
}

function regexExtractDeps(lines) {
  const reqs = [], imps = [];
  for (let i = 0; i < lines.length; i++) {
    const rq = lines[i].match(/require\(["']([^"']+)["']\)/);
    if (rq) reqs.push({ module: rq[1], line: i + 1 });
    const im = lines[i].match(/^\s*import\s+(?:(?:\{[^}]*\}|[\w*]+(?:\s+as\s+\w+)?)\s+from\s+)?["']([^"']+)["']/);
    if (im) imps.push({ module: im[1], line: i + 1 });
  }
  // Merge, dedup
  const seen = new Set(reqs.map(d => `${d.module}:${d.line}`));
  for (const imp of imps) {
    const key = `${imp.module}:${imp.line}`;
    if (!seen.has(key)) { reqs.push(imp); seen.add(key); }
  }
  return reqs;
}

// --- Enrichment & scoring ---
function extractParams(line) {
  const m = line.match(/\(([^)]*)\)/);
  return m ? m[1].split(",").map(s => s.trim()).filter(Boolean) : [];
}

function enrichFunctions(fns, lines) {
  return fns.map(fn => {
    const body = lines.slice(fn.startLine - 1, fn.endLine).join("\n");
    const params = extractParams(lines[fn.startLine - 1] || "");
    const estLines = fn.endLine - fn.startLine + 1;
    const isAsync = fn.kind.includes("async");
    const touchesDb = DB_PAT.test(body), touchesFs = FS_PAT.test(body);
    const makesHttp = HTTP_PAT.test(body), usesConcurrency = CONC_PAT.test(body);
    const hasTryCatch = /\btry\s*\{/.test(body);
    let complexity = 1;
    const cm = body.match(/\b(if|else if|else|switch|case|for|while|do|catch)\b|\?\?|\|\||&&/g);
    if (cm) complexity += cm.length;
    let risk = "low";
    const rf = [touchesDb, touchesFs, makesHttp, usesConcurrency, estLines > 50, complexity > 10].filter(Boolean).length;
    if (rf >= 3 || (touchesDb && !hasTryCatch) || (makesHttp && !hasTryCatch)) risk = "high";
    else if (rf >= 1) risk = "medium";
    return { ...fn, params, estLines, isAsync, touchesDb, touchesFs, makesHttp, usesConcurrency, hasTryCatch, complexity, risk };
  });
}

function buildDependencyMap(deps, fns, lines) {
  return deps.map(dep => {
    const isLocal = dep.module.startsWith(".");
    const modName = dep.module.split("/").pop().replace(/\.\w+$/, "");
    const usedBy = fns.filter(fn => lines.slice(fn.startLine - 1, fn.endLine).join("\n").includes(modName)).map(fn => fn.name);
    return { module: dep.module, line: dep.line, isLocal, isNpm: !isLocal, usedBy };
  });
}

function detectBusinessLogic(lines) {
  const flags = [], seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (MAGIC_NUM.test(line))
      flags.push({ line: i + 1, type: "magic_number", text: line.trim() });
    if (BIZ_COMMENT.test(line) && (line.includes("//") || line.includes("/*") || line.includes("*")))
      flags.push({ line: i + 1, type: "flagged_comment", text: line.trim() });
    if (NULL_CHAIN.test(line)) {
      const window = lines.slice(Math.max(0, i - 2), Math.min(lines.length, i + 3));
      if (window.filter(l => NULL_CHAIN.test(l)).length >= 3)
        flags.push({ line: i + 1, type: "defensive_null_cluster", text: line.trim() });
    }
  }
  return flags.filter(f => { const k = `${f.line}:${f.type}`; if (seen.has(k)) return false; seen.add(k); return true; });
}

function findConsumers(filePath, projectDir) {
  const consumers = [], basename = path.basename(filePath, ".js");
  (function scan(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.name === "node_modules" || ent.name === ".git") continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { scan(full, depth + 1); continue; }
      if (!/\.(?:js|ts|mjs|cjs)$/.test(ent.name) || full === filePath) continue;
      try {
        const src = fs.readFileSync(full, "utf8");
        if (src.includes(basename) && (src.includes("require") || src.includes("import")))
          consumers.push(path.relative(projectDir, full).replace(/\\/g, "/"));
      } catch {}
    }
  })(projectDir, 0);
  return consumers;
}

function tier(val, thresholds) {
  for (const [limit, score] of thresholds) { if (val <= limit) return score; }
  return thresholds[thresholds.length - 1][1];
}

function calcHealth(totalLines, fns, deps) {
  const maxFnLen = fns.length ? Math.max(...fns.map(f => f.estLines || (f.endLine - f.startLine + 1))) : 0;
  const maxCx = fns.length ? Math.max(...fns.map(f => f.complexity || 1)) : 1;
  const ls = tier(totalLines, [[300,1],[500,.9],[1000,.7],[2000,.4]]) || .2;
  const fc = tier(fns.length, [[10,1],[20,.8],[30,.6],[50,.4]]) || .2;
  const fs_ = tier(maxFnLen, [[50,1],[100,.8],[200,.6],[500,.4]]) || .2;
  const cs = tier(deps.length, [[5,1],[10,.8],[20,.6]]) || .4;
  const cx = tier(maxCx, [[5,1],[10,.8],[20,.6]]) || .4;
  const o100 = fns.filter(f => (f.estLines || (f.endLine - f.startLine + 1)) > 100).length;
  const o300 = fns.filter(f => (f.estLines || (f.endLine - f.startLine + 1)) > 300).length;
  const penalty = o300 > 0 ? 0.3 : o100 > 3 ? 0.2 : 0;
  const overall = Math.max(0, Math.min(1, (ls*.25 + fc*.2 + fs_*.2 + cs*.15 + cx*.2) - penalty));
  return {
    overall: Math.round(overall * 100) / 100,
    linesScore: ls, fnCountScore: fc, fnSizeScore: fs_, couplingScore: cs, complexityScore: cx,
    maxFunctionLines: maxFnLen, maxComplexity: maxCx, functionsOver100Lines: o100, functionsOver300Lines: o300,
  };
}

// --- Main entry ---
async function analyze(args) {
  const filePath = path.resolve(args.file);
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
  const source = fs.readFileSync(filePath, "utf8");
  const lines = source.split("\n");
  const totalLines = lines.length;
  const deep = !!args.deep;
  const projectDir = args.projectDir ? path.resolve(args.projectDir) : path.dirname(filePath);

  let rawFns, rawDeps;
  if (sgParse && sgLang) {
    const root = sgParse(sgLang.JavaScript, source).root();
    rawFns = astExtractFunctions(root);
    rawDeps = astExtractRequires(root);
    // Merge ES imports
    const imps = regexExtractDeps(lines).filter(d => !rawDeps.some(r => r.module === d.module && r.line === d.line));
    rawDeps.push(...imps);
  } else {
    rawFns = regexExtractFunctions(lines);
    rawDeps = regexExtractDeps(lines);
  }

  const functions = enrichFunctions(rawFns, lines);
  const dependencies = deep ? buildDependencyMap(rawDeps, functions, lines) : rawDeps.map(d => ({
    module: d.module, line: d.line, isLocal: d.module.startsWith("."), isNpm: !d.module.startsWith(".")
  }));
  const health = calcHealth(totalLines, functions, rawDeps);
  const businessLogicFlags = deep ? detectBusinessLogic(lines) : [];
  const consumers = deep ? findConsumers(filePath, projectDir) : [];

  let recommendation = "ok";
  if (totalLines > 1000 || health.overall < 0.5) recommendation = "decompose";
  else if (totalLines > 500 || health.overall < 0.7) recommendation = "consider_decompose";

  return {
    file: filePath, lines: totalLines, analysisMode: sgParse ? "ast" : "regex", deep,
    functions: functions.length, functionList: functions,
    requires: rawDeps.length, requireList: rawDeps,
    internalRequires: rawDeps.filter(r => r.module.startsWith(".")).map(r => r.module),
    externalRequires: rawDeps.filter(r => !r.module.startsWith(".")).map(r => r.module),
    dependencies, health, recommendation,
    ...(deep ? {
      businessLogicFlags, consumers,
      riskSummary: {
        high: functions.filter(f => f.risk === "high").map(f => f.name),
        medium: functions.filter(f => f.risk === "medium").map(f => f.name),
        low: functions.filter(f => f.risk === "low").map(f => f.name),
      },
    } : {}),
  };
}

module.exports = { analyze };
