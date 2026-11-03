// SQLite driver for self-hosting on Node.js 22.5+ (built-in node:sqlite — nothing to compile).
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

function nodeDriver(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  let depth = 0; // nestable transactions via savepoints
  return {
    all: (sql, p) => db.prepare(sql).all(...p),
    get: (sql, p) => db.prepare(sql).get(...p),
    run: (sql, p) => { const r = db.prepare(sql).run(...p); return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes }; },
    exec: (sql) => db.exec(sql),
    transaction(fn) {
      const sp = `sp${depth}`;
      db.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
      depth++;
      try {
        const r = fn();
        depth--;
        db.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
        return r;
      } catch (e) {
        depth--;
        db.exec(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}`);
        throw e;
      }
    },
  };
}

module.exports = { nodeDriver };
