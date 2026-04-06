# Expected Output

Running `refactory decompose ../sample-monolith.js` produces:

## Files created:
- **db.js** -- database connection pool and query functions (`getOrderById`, `getOrdersByCustomer`, `insertOrder`, `updateOrderStatus`)
- **validation.js** -- input validation (`validateCreateOrder`, `validateStatusUpdate`)
- **handlers.js** -- HTTP request handlers (`handleGetOrder`, `handleListOrders`, `handleCreateOrder`, `handleUpdateStatus`)
- **formatting.js** -- output formatting helpers (`formatOrder`, `formatCurrency`, `formatOrderList`)
- **index.js** -- re-exports matching original `module.exports` so existing consumers don't break
- **REPORT.md** -- decomposition report with Refactory Score, per-module status, and dependency graph
