import type { Database } from "./types.ts";

// D1 refuses BEGIN and COMMIT and runs exec() one line at a time, so schema
// scripts are split into statements and sent through batch(), which is one
// transaction. A trigger body holds semicolons: it ends at "; END".
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const part of script.split(";")) {
    current += part;
    const text = current.trim();
    if (!text) { current = ""; continue; }
    if (/^CREATE\s+TRIGGER/i.test(text) && !/;\s*END$/i.test(text)) { current += ";"; continue; }
    out.push(text + ";");
    current = "";
  }
  return out;
}

export async function execScript(db: Database, script: string): Promise<void> {
  const statements = splitStatements(script);
  if (statements.length) await db.batch(statements.map((statement) => db.prepare(statement)));
}
