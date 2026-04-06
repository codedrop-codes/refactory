"use strict";
/**
 * Test fixture: realistic monolith with mixed concerns.
 * Used by integration tests to validate analyze → plan → extract pipeline.
 *
 * Contains: DB helpers, user auth, order management, notifications, utils.
 * Intentionally large (~220 lines) to trigger decompose recommendation.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const EventEmitter = require("node:events");

const DEFAULT_PAGE_SIZE = 20;
const MAX_LOGIN_ATTEMPTS = 5;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Database helpers ────────────────────────────────────────────────────────

function dbConnect(config) {
  if (!config || !config.host) throw new Error("DB config missing host");
  return {
    host: config.host,
    port: config.port || 5432,
    connected: true,
    query: async (sql, params) => ({ rows: [], sql, params }),
  };
}

async function dbQuery(conn, sql, params = []) {
  if (!conn || !conn.connected) throw new Error("DB not connected");
  return conn.query(sql, params);
}

async function dbClose(conn) {
  if (conn) conn.connected = false;
}

// ─── User management ─────────────────────────────────────────────────────────

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHmac("sha256", s).update(password).digest("hex");
  return { hash, salt: s };
}

async function createUser(db, email, password, role = "user") {
  if (!email || !email.includes("@")) throw new Error("Invalid email");
  if (!password || password.length < 8) throw new Error("Password too short");
  const { hash, salt } = hashPassword(password);
  const id = crypto.randomUUID();
  await dbQuery(db, "INSERT INTO users (id, email, hash, salt, role) VALUES ($1,$2,$3,$4,$5)", [id, email, hash, salt, role]);
  return { id, email, role };
}

async function getUser(db, email) {
  const result = await dbQuery(db, "SELECT * FROM users WHERE email = $1", [email]);
  return result.rows[0] || null;
}

async function updateUserRole(db, userId, newRole) {
  const allowed = ["user", "admin", "moderator"];
  if (!allowed.includes(newRole)) throw new Error(`Invalid role: ${newRole}`);
  await dbQuery(db, "UPDATE users SET role = $1 WHERE id = $2", [newRole, userId]);
}

// ─── Authentication ───────────────────────────────────────────────────────────

const loginAttempts = new Map();

function generateToken(userId) {
  const payload = { userId, exp: Date.now() + TOKEN_TTL_MS, nonce: crypto.randomBytes(8).toString("hex") };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function verifyToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

async function login(db, email, password) {
  const attempts = loginAttempts.get(email) || 0;
  if (attempts >= MAX_LOGIN_ATTEMPTS) {
    throw new Error("Account locked — too many failed attempts");
  }

  const user = await getUser(db, email);
  if (!user) {
    loginAttempts.set(email, attempts + 1);
    throw new Error("Invalid credentials");
  }

  const { hash } = hashPassword(password, user.salt);
  if (hash !== user.hash) {
    loginAttempts.set(email, attempts + 1);
    throw new Error("Invalid credentials");
  }

  loginAttempts.delete(email);
  return { token: generateToken(user.id), user: { id: user.id, email: user.email, role: user.role } };
}

async function logout(db, token) {
  const payload = verifyToken(token);
  if (!payload) return false;
  await dbQuery(db, "INSERT INTO revoked_tokens (token, revoked_at) VALUES ($1, NOW())", [token]);
  return true;
}

// ─── Order management ─────────────────────────────────────────────────────────

async function createOrder(db, userId, items) {
  if (!items || items.length === 0) throw new Error("Order must have at least one item");
  const total = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const orderId = crypto.randomUUID();
  await dbQuery(db, "INSERT INTO orders (id, user_id, total, status) VALUES ($1,$2,$3,'pending')", [orderId, userId, total]);
  for (const item of items) {
    await dbQuery(db, "INSERT INTO order_items (order_id, sku, qty, price) VALUES ($1,$2,$3,$4)", [orderId, item.sku, item.qty, item.price]);
  }
  return { orderId, total, status: "pending" };
}

async function getOrders(db, userId, page = 1) {
  const offset = (page - 1) * DEFAULT_PAGE_SIZE;
  const result = await dbQuery(db, "SELECT * FROM orders WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3", [userId, DEFAULT_PAGE_SIZE, offset]);
  return result.rows;
}

async function cancelOrder(db, orderId, userId) {
  const result = await dbQuery(db, "SELECT * FROM orders WHERE id=$1 AND user_id=$2", [orderId, userId]);
  const order = result.rows[0];
  if (!order) throw new Error("Order not found");
  if (order.status !== "pending") throw new Error(`Cannot cancel order in status: ${order.status}`);
  await dbQuery(db, "UPDATE orders SET status='cancelled' WHERE id=$1", [orderId]);
  return { orderId, status: "cancelled" };
}

async function fulfillOrder(db, orderId) {
  await dbQuery(db, "UPDATE orders SET status='fulfilled', fulfilled_at=NOW() WHERE id=$1", [orderId]);
}

// ─── Notifications ────────────────────────────────────────────────────────────

const notificationEmitter = new EventEmitter();

function onNotification(handler) {
  notificationEmitter.on("notification", handler);
  return () => notificationEmitter.off("notification", handler);
}

async function sendNotification(db, userId, type, payload) {
  const id = crypto.randomUUID();
  await dbQuery(db, "INSERT INTO notifications (id, user_id, type, payload, sent_at) VALUES ($1,$2,$3,$4,NOW())", [id, userId, type, JSON.stringify(payload)]);
  notificationEmitter.emit("notification", { id, userId, type, payload });
  return id;
}

async function getUnreadNotifications(db, userId) {
  const result = await dbQuery(db, "SELECT * FROM notifications WHERE user_id=$1 AND read_at IS NULL ORDER BY sent_at DESC", [userId]);
  return result.rows;
}

async function markNotificationsRead(db, userId, notificationIds) {
  if (!notificationIds || notificationIds.length === 0) return 0;
  await dbQuery(db, "UPDATE notifications SET read_at=NOW() WHERE user_id=$1 AND id=ANY($2)", [userId, notificationIds]);
  return notificationIds.length;
}

// ─── Report utilities ─────────────────────────────────────────────────────────

function paginate(items, page, pageSize = DEFAULT_PAGE_SIZE) {
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize, pages: Math.ceil(items.length / pageSize) };
}

function writeReport(outputPath, data) {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(data, null, 2), "utf8");
  return outputPath;
}

function formatCurrency(amount, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

module.exports = {
  dbConnect, dbQuery, dbClose,
  hashPassword, createUser, getUser, updateUserRole,
  generateToken, verifyToken, login, logout,
  createOrder, getOrders, cancelOrder, fulfillOrder,
  onNotification, sendNotification, getUnreadNotifications, markNotificationsRead,
  paginate, writeReport, formatCurrency,
};
