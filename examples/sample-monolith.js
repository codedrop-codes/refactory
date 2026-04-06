"use strict";

const mysql = require("mysql2/promise");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Database configuration and connection pool
// ---------------------------------------------------------------------------

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "3306", 10),
  user: process.env.DB_USER || "app",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "orders_db",
  waitForConnections: true,
  connectionLimit: 10,
});

// ---------------------------------------------------------------------------
// Database queries — direct SQL against the pool
// ---------------------------------------------------------------------------

async function getOrderById(orderId) {
  const [rows] = await pool.execute(
    "SELECT * FROM orders WHERE id = ? AND deleted_at IS NULL",
    [orderId]
  );
  return rows[0] || null;
}

async function getOrdersByCustomer(customerId, limit = 50) {
  const [rows] = await pool.execute(
    "SELECT * FROM orders WHERE customer_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?",
    [customerId, limit]
  );
  return rows;
}

async function insertOrder(order) {
  const id = crypto.randomUUID();
  await pool.execute(
    "INSERT INTO orders (id, customer_id, status, total_cents, currency, items_json, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())",
    [id, order.customerId, "pending", order.totalCents, order.currency || "USD", JSON.stringify(order.items)]
  );
  return id;
}

async function updateOrderStatus(orderId, newStatus) {
  const allowed = ["pending", "confirmed", "shipped", "delivered", "cancelled"];
  if (!allowed.includes(newStatus)) {
    throw new Error(`Invalid status: ${newStatus}`);
  }
  await pool.execute(
    "UPDATE orders SET status = ?, updated_at = NOW() WHERE id = ?",
    [newStatus, orderId]
  );
}

// ---------------------------------------------------------------------------
// Validation — input checking for the HTTP layer
// ---------------------------------------------------------------------------

function validateCreateOrder(body) {
  const errors = [];
  if (!body.customerId || typeof body.customerId !== "string") {
    errors.push("customerId is required and must be a string");
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    errors.push("items must be a non-empty array");
  } else {
    body.items.forEach((item, i) => {
      if (!item.sku) errors.push(`items[${i}].sku is required`);
      if (typeof item.qty !== "number" || item.qty < 1) {
        errors.push(`items[${i}].qty must be a positive number`);
      }
      if (typeof item.priceCents !== "number" || item.priceCents < 0) {
        errors.push(`items[${i}].priceCents must be a non-negative number`);
      }
    });
  }
  // HACK: legacy clients send totalCents as a string sometimes
  if (body.totalCents && typeof body.totalCents === "string") {
    body.totalCents = parseInt(body.totalCents, 10);
  }
  if (typeof body.totalCents !== "number" || body.totalCents < 0) {
    errors.push("totalCents must be a non-negative number");
  }
  return errors;
}

function validateStatusUpdate(body) {
  const errors = [];
  if (!body.status || typeof body.status !== "string") {
    errors.push("status is required and must be a string");
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Formatting — shape DB rows into API responses
// ---------------------------------------------------------------------------

function formatOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    total: formatCurrency(row.total_cents, row.currency),
    items: JSON.parse(row.items_json || "[]"),
    createdAt: row.created_at ? row.created_at.toISOString() : null,
    updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
  };
}

function formatCurrency(cents, currency = "USD") {
  const dollars = (cents / 100).toFixed(2);
  const symbols = { USD: "$", EUR: "\u20AC", GBP: "\u00A3" };
  const sym = symbols[currency] || currency + " ";
  return `${sym}${dollars}`;
}

function formatOrderList(rows) {
  return rows.map(formatOrder);
}

// ---------------------------------------------------------------------------
// HTTP handlers — Express route callbacks
// ---------------------------------------------------------------------------

async function handleGetOrder(req, res) {
  try {
    const row = await getOrderById(req.params.id);
    if (!row) return res.status(404).json({ error: "Order not found" });
    return res.json(formatOrder(row));
  } catch (err) {
    console.error("GET /orders/:id failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

async function handleListOrders(req, res) {
  try {
    const customerId = req.query.customerId;
    if (!customerId) return res.status(400).json({ error: "customerId query param required" });
    const rows = await getOrdersByCustomer(customerId);
    return res.json(formatOrderList(rows));
  } catch (err) {
    console.error("GET /orders failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

async function handleCreateOrder(req, res) {
  try {
    const errors = validateCreateOrder(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });
    const id = await insertOrder(req.body);
    return res.status(201).json({ id, status: "pending" });
  } catch (err) {
    console.error("POST /orders failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

async function handleUpdateStatus(req, res) {
  try {
    const errors = validateStatusUpdate(req.body);
    if (errors.length > 0) return res.status(400).json({ errors });
    const existing = await getOrderById(req.params.id);
    if (!existing) return res.status(404).json({ error: "Order not found" });
    await updateOrderStatus(req.params.id, req.body.status);
    return res.json({ id: req.params.id, status: req.body.status });
  } catch (err) {
    console.error("PATCH /orders/:id/status failed:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}

// ---------------------------------------------------------------------------
// Exports — everything hangs off one big module.exports
// ---------------------------------------------------------------------------

module.exports = {
  pool,
  getOrderById,
  getOrdersByCustomer,
  insertOrder,
  updateOrderStatus,
  validateCreateOrder,
  validateStatusUpdate,
  formatOrder,
  formatCurrency,
  formatOrderList,
  handleGetOrder,
  handleListOrders,
  handleCreateOrder,
  handleUpdateStatus,
};
