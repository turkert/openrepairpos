// SQLite driver for Cloudflare: a Durable Object's built-in SQLite storage.
// Its API is synchronous, so the business logic is identical to the Node.js version.
function durableDriver(storage) {
  const sql = storage.sql;
  let depth = 0;
  return {
    all: (q, p) => sql.exec(q, ...p).toArray(),
    get: (q, p) => sql.exec(q, ...p).toArray()[0],
    run(q, p) {
      const c = sql.exec(q, ...p);
      c.toArray(); // drain the cursor so the statement completes
      const id = sql.exec('SELECT last_insert_rowid() AS id').toArray()[0].id;
      return { lastInsertRowid: Number(id), changes: c.rowsWritten };
    },
    exec: (q) => { sql.exec(q).toArray(); },
    // Durable Objects don't allow BEGIN/SAVEPOINT; transactionSync wraps the outermost call,
    // and any error inside rolls the whole thing back.
    transaction(fn) {
      if (depth > 0) return fn();
      depth++;
      try { return storage.transactionSync(fn); } finally { depth--; }
    },
  };
}

module.exports = { durableDriver };
