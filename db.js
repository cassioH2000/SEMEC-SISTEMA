import Database from "better-sqlite3";

export function initDb(dbPath = "./data.sqlite") {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upload_id INTEGER NOT NULL,
      period TEXT,
      matricula TEXT,
      nome TEXT,
      funcao TEXT,
      vinculo TEXT,
      carga TEXT,
      horas_extras INTEGER DEFAULT 0,
      falta_atestado INTEGER DEFAULT 0,
      falta_sem_atestado INTEGER DEFAULT 0,
      obs TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(upload_id) REFERENCES uploads(id)
    );

    CREATE INDEX IF NOT EXISTS idx_records_matricula ON records(matricula);
    CREATE INDEX IF NOT EXISTS idx_records_period ON records(period);
    CREATE INDEX IF NOT EXISTS idx_records_upload ON records(upload_id);
  `);

  return db;
}
