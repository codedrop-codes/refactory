"use strict";
const fs = require("node:fs");

const LEVELS = { quiet: 0, normal: 1, verbose: 2, debug: 3 };
const PREFIX = "[refactory]";

// Per-provider pricing ($ per 1M tokens) — 0 = free tier
const PRICING = {
  "groq":             { input: 0, output: 0 },
  "gemini-flash":     { input: 0, output: 0 },
  "openrouter-qwen":  { input: 0, output: 0 },
  "sambanova":        { input: 0, output: 0 },
  "gemini-pro":       { input: 1.25, output: 5.00 },
  "claude":           { input: 3.00, output: 15.00 },
};

let level = LEVELS.normal;
const runLog = [];
let totalApiCost = 0;
let totalApiCalls = 0;

function ts() {
  return new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmt(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function pad(s, n) {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function estimateCost(provider, inputTokens, outputTokens) {
  const p = PRICING[provider] || { input: 0, output: 0 };
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
}

function setLevel(l) {
  if (typeof l === "string") l = LEVELS[l] ?? LEVELS.normal;
  level = l;
}

function getLevel() {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === level) || "normal";
}

function log(minLevel, msg) {
  if (level >= minLevel) process.stderr.write(msg + "\n");
}

function step(name, data = {}) {
  const entry = { ts: new Date().toISOString(), step: name, ...data };
  if (data.durationMs != null) entry.duration = data.durationMs;
  runLog.push(entry);

  // Build display line
  const parts = [];
  if (data.file) parts.push(path_base(data.file));
  if (data.module) parts.push(data.module);
  if (data.lines != null) parts.push(`${data.lines}L`);
  if (data.functions != null) parts.push(`${data.functions} functions`);
  if (data.health != null) parts.push(`health ${data.health}`);
  if (data.modules != null) parts.push(`${data.modules} modules`);
  if (data.syntax != null) parts.push(`syntax:${data.syntax ? "OK" : "FAIL"}`);
  if (data.provider) parts.push(`via ${data.provider}`);
  if (data.clean != null) parts.push(`${data.clean}/${data.total} clean`);
  if (data.score != null) parts.push(`Score: ${data.score}`);
  const detail = parts.length ? " " + parts.join(", ") : "";
  const dur = data.durationMs != null ? ` (${fmt(data.durationMs)})` : "";

  log(LEVELS.normal, `${PREFIX} ${ts()} ${pad(name, 12)}${detail}${dur}`);
}

function apiCall(data = {}) {
  const cost = estimateCost(data.provider, data.inputTokens || 0, data.outputTokens || 0);
  totalApiCost += cost;
  totalApiCalls++;

  const entry = {
    ts: new Date().toISOString(),
    type: "API_CALL",
    provider: data.provider,
    inputTokens: data.inputTokens || 0,
    outputTokens: data.outputTokens || 0,
    durationMs: data.durationMs || 0,
    cost,
  };
  runLog.push(entry);

  const tokStr = `in:${entry.inputTokens} out:${entry.outputTokens}`;
  const costStr = cost > 0 ? ` $${cost.toFixed(4)}` : " $0.00";
  log(LEVELS.verbose, `${PREFIX} ${ts()} ${pad("API", 12)} ${data.provider} ${tokStr}${costStr} (${fmt(entry.durationMs)})`);
}

function progress(label, current, total) {
  if (level < LEVELS.normal) return;
  const pct = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * 16);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(16 - filled);
  process.stderr.write(`\r${PREFIX} ${pad(label, 8)} [${bar}] ${current}/${total} (${pct}%)`);
  if (current >= total) process.stderr.write("\n");
}

function complete(data = {}) {
  const entry = {
    ts: new Date().toISOString(),
    step: "COMPLETE",
    steps: data.steps || runLog.filter((e) => e.step && e.step !== "COMPLETE").length,
    totalMs: data.totalMs,
    apiCost: totalApiCost,
    apiCalls: totalApiCalls,
  };
  runLog.push(entry);

  const dur = data.totalMs != null ? fmt(data.totalMs) : "?";
  const costStr = `$${totalApiCost.toFixed(2)}`;
  log(LEVELS.normal, `${PREFIX} ${ts()} ${pad("COMPLETE", 12)} ${entry.steps} steps in ${dur} | ${costStr} API cost`);
}

function getRunLog() {
  return runLog.slice();
}

function writeRunLog(filePath) {
  const lines = runLog.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(filePath, lines, "utf8");
  log(LEVELS.verbose, `${PREFIX} Run log written to ${filePath} (${runLog.length} entries)`);
}

function debug(msg) {
  log(LEVELS.debug, `${PREFIX} ${ts()} DEBUG        ${msg}`);
}

function error(msg) {
  log(LEVELS.quiet, `${PREFIX} ${ts()} ERROR        ${msg}`);
}

function path_base(p) {
  const i = p.lastIndexOf("/");
  const j = p.lastIndexOf("\\");
  return p.slice(Math.max(i, j) + 1);
}

module.exports = {
  setLevel,
  getLevel,
  step,
  apiCall,
  progress,
  complete,
  getRunLog,
  writeRunLog,
  debug,
  error,
  estimateCost,
};
