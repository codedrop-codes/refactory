"use strict";
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { analyze } = require("../src/tools/analyze");

const FIXTURE = path.join(__dirname, "fixtures", "monolith.js");
const ROUTER = path.join(__dirname, "../src/providers/router.js");

describe("analyze tool", () => {
  test("uses AST mode when ast-grep is available", async () => {
    const result = await analyze({ file: FIXTURE });
    assert.equal(result.analysisMode, "ast", "should use ast mode");
  });

  test("detects all named functions in fixture", async () => {
    const result = await analyze({ file: FIXTURE });
    const names = result.functionList.map((f) => f.name);

    // DB helpers
    assert.ok(names.includes("dbConnect"), "should detect dbConnect");
    assert.ok(names.includes("dbQuery"), "should detect dbQuery");
    assert.ok(names.includes("dbClose"), "should detect dbClose");

    // User management
    assert.ok(names.includes("createUser"), "should detect createUser");
    assert.ok(names.includes("getUser"), "should detect getUser");
    assert.ok(names.includes("hashPassword"), "should detect hashPassword");
    assert.ok(names.includes("updateUserRole"), "should detect updateUserRole");

    // Auth
    assert.ok(names.includes("login"), "should detect login");
    assert.ok(names.includes("logout"), "should detect logout");
    assert.ok(names.includes("generateToken"), "should detect generateToken");
    assert.ok(names.includes("verifyToken"), "should detect verifyToken");

    // Orders
    assert.ok(names.includes("createOrder"), "should detect createOrder");
    assert.ok(names.includes("getOrders"), "should detect getOrders");
    assert.ok(names.includes("cancelOrder"), "should detect cancelOrder");
    assert.ok(names.includes("fulfillOrder"), "should detect fulfillOrder");

    // Notifications
    assert.ok(names.includes("sendNotification"), "should detect sendNotification");
    assert.ok(names.includes("getUnreadNotifications"), "should detect getUnreadNotifications");
    assert.ok(names.includes("markNotificationsRead"), "should detect markNotificationsRead");
    assert.ok(names.includes("onNotification"), "should detect onNotification");

    // Utils
    assert.ok(names.includes("paginate"), "should detect paginate");
    assert.ok(names.includes("writeReport"), "should detect writeReport");
    assert.ok(names.includes("formatCurrency"), "should detect formatCurrency");
  });

  test("function line ranges are accurate", async () => {
    const result = await analyze({ file: FIXTURE });
    const dbConnect = result.functionList.find((f) => f.name === "dbConnect");
    const login = result.functionList.find((f) => f.name === "login");

    assert.ok(dbConnect, "dbConnect should be present");
    assert.ok(dbConnect.startLine > 0, "startLine should be positive");
    assert.ok(dbConnect.endLine >= dbConnect.startLine, "endLine >= startLine");

    assert.ok(login, "login should be present");
    // login function is multi-line — verify it spans more than 5 lines
    assert.ok(login.endLine - login.startLine >= 5, "login should span multiple lines");
  });

  test("detects all require() calls", async () => {
    const result = await analyze({ file: FIXTURE });
    const modules = result.requireList.map((r) => r.module);
    assert.ok(modules.includes("node:fs"), "should detect node:fs");
    assert.ok(modules.includes("node:path"), "should detect node:path");
    assert.ok(modules.includes("node:crypto"), "should detect node:crypto");
    assert.ok(modules.includes("node:events"), "should detect node:events");
    assert.equal(result.requires, 4, "should find exactly 4 requires");
  });

  test("classifies internal vs external requires", async () => {
    const result = await analyze({ file: ROUTER });
    // router.js uses node: built-ins (external)
    assert.ok(result.externalRequires.length >= 2, "should find external requires");
    // router.js has no local imports
    assert.equal(result.internalRequires.length, 0, "router has no internal requires");
  });

  test("health scoring reflects file size", async () => {
    const result = await analyze({ file: FIXTURE });
    assert.ok(result.health.overall >= 0 && result.health.overall <= 1, "overall should be 0-1");
    assert.ok(result.health.linesScore > 0, "linesScore should be positive");
    assert.ok(result.health.fnCountScore > 0, "fnCountScore should be positive");
  });

  test("recommendation is set for large files", async () => {
    // monolith.js is ~200 lines — should be 'ok' or 'consider_decompose'
    const result = await analyze({ file: FIXTURE });
    assert.ok(["ok", "consider_decompose", "decompose"].includes(result.recommendation));
  });

  test("throws on missing file", async () => {
    await assert.rejects(
      () => analyze({ file: "/tmp/nonexistent_refactory_test_file.js" }),
      /File not found/
    );
  });

  test("result shape is complete", async () => {
    const result = await analyze({ file: FIXTURE });
    assert.ok(typeof result.file === "string", "file should be string");
    assert.ok(typeof result.lines === "number", "lines should be number");
    assert.ok(Array.isArray(result.functionList), "functionList should be array");
    assert.ok(Array.isArray(result.requireList), "requireList should be array");
    assert.ok(Array.isArray(result.internalRequires), "internalRequires should be array");
    assert.ok(Array.isArray(result.externalRequires), "externalRequires should be array");
    assert.ok(typeof result.health === "object", "health should be object");
    assert.ok(typeof result.recommendation === "string", "recommendation should be string");
  });
});
