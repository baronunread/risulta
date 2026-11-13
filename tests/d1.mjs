// A D1-shaped adapter over bun:sqlite for the tests. It follows the Workers D1
// contract the app is written against: every call except prepare() and bind()
// returns a Promise, batch() is one transaction, BEGIN/COMMIT are refused and
// exec() runs one line at a time.
export function d1(sqlite, extras) {
  const refused = /^\s*(begin|commit|end|rollback|savepoint|release)\b/i;
  function statement(sql, args) {
    return {
      bind(...values) { return statement(sql, values); },
      async first() { return sqlite.query(sql).get(...args) || null; },
      async all() { return { success: true, results: sqlite.query(sql).all(...args), meta: {} }; },
      async run() {
        const result = sqlite.query(sql).run(...args);
        return { success: true, results: [], meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      __sql: sql,
      __args: args,
    };
  }
  const db = {
    prepare(sql) {
      if (refused.test(sql)) throw new Error("D1_ERROR: transaction statements are not allowed, use batch()");
      return statement(sql, []);
    },
    async batch(statements) {
      const results = [];
      sqlite.exec("BEGIN");
      try {
        for (const s of statements) results.push(await s.run());
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      return results;
    },
    async exec(sql) {
      const lines = String(sql).split("\n").filter((line) => line.trim());
      for (const line of lines) {
        if (refused.test(line)) throw new Error("D1_EXEC_ERROR: transaction statements are not allowed");
      }
      sqlite.exec("BEGIN");
      try { for (const line of lines) sqlite.exec(line); sqlite.exec("COMMIT"); } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      return { count: lines.length, duration: 0 };
    },
  };
  return extras ? Object.assign(db, extras) : db;
}

// Make every batch whose statements match fail after they ran (an invalid
// statement is appended), to prove a failed step rolls back whole. Returns
// a function that restores the original batch.
export function breakBatch(db, matches) {
  const original = db.batch;
  db.batch = (statements) => matches(statements.map((statement) => statement.__sql))
    ? original.call(db, [...statements, db.prepare("INVALID SQL")])
    : original.call(db, statements);
  return () => { db.batch = original; };
}
