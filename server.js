import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import jwt from "jsonwebtoken";
import { initDb } from "./db.js";
import path from "path";
import { fileURLToPath } from "url";

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "semec2026";

const db = initDb("./data.sqlite");
const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

// Servir o frontend
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "..", "public")));

function signToken() {
  return jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "8h" });
}
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token) return res.status(401).json({ error: "no_token" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.role !== "admin") return res.status(403).json({ error: "forbidden" });
    next();
  } catch {
    return res.status(401).json({ error: "invalid_token" });
  }
}

// ===== AUTH =====
app.post("/api/auth/login", (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "missing_password" });
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: "wrong_password" });
  return res.json({ token: signToken() });
});

// ===== RECEBER RELATÓRIO DA FOLHA (sem login) =====
// (Se quiser proteger com uma "chave de envio", dá pra adicionar depois)
app.post("/api/reports", (req, res) => {
  const { source, records } = req.body || {};
  if (!source || !Array.isArray(records)) return res.status(400).json({ error: "bad_payload" });

  const now = new Date().toISOString();
  const insUpload = db.prepare("INSERT INTO uploads (source, created_at) VALUES (?, ?)");
  const insRec = db.prepare(`
    INSERT INTO records (
      upload_id, period, matricula, nome, funcao, vinculo, carga,
      horas_extras, falta_atestado, falta_sem_atestado, obs, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    const info = insUpload.run(String(source).trim(), now);
    const uploadId = info.lastInsertRowid;

    for (const r of records) {
      insRec.run(
        uploadId,
        String(r.period ?? ""),
        String(r.matricula ?? ""),
        String(r.nome ?? ""),
        String(r.funcao ?? ""),
        String(r.vinculo ?? ""),
        String(r.carga ?? ""),
        Number(r.horas_extras ?? 0) || 0,
        Number(r.falta_atestado ?? 0) || 0,
        Number(r.falta_sem_atestado ?? 0) || 0,
        String(r.obs ?? ""),
        now
      );
    }
    return uploadId;
  });

  try {
    const uploadId = tx();
    res.json({ ok: true, upload_id: uploadId });
  } catch (e) {
    res.status(500).json({ error: "db_error", detail: String(e?.message || e) });
  }
});

// ===== ADM: LISTAR UPLOADS =====
app.get("/api/admin/uploads", auth, (req, res) => {
  const { limit = 50 } = req.query;
  const rows = db.prepare(`
    SELECT id, source, created_at,
      (SELECT COUNT(*) FROM records r WHERE r.upload_id = uploads.id) AS count
    FROM uploads
    ORDER BY id DESC
    LIMIT ?
  `).all(Number(limit) || 50);
  res.json({ uploads: rows });
});

// ===== ADM: CONSOLIDADO (opcional por período) =====
app.get("/api/admin/summary", auth, (req, res) => {
  const { period } = req.query; // "YYYY-MM" ou vazio
  const where = period ? "WHERE period = ?" : "";
  const row = db.prepare(`
    SELECT
      COUNT(*) AS registros,
      COALESCE(SUM(horas_extras),0) AS horas_extras,
      COALESCE(SUM(falta_atestado),0) AS falta_atestado,
      COALESCE(SUM(falta_sem_atestado),0) AS falta_sem_atestado
    FROM records
    ${where}
  `).get(period ? [String(period)] : []);
  res.json({
    ...row,
    total_faltas: (row.falta_atestado || 0) + (row.falta_sem_atestado || 0)
  });
});

// ===== ADM: RESUMO POR MATRÍCULA =====
app.get("/api/admin/matricula/:mat/summary", auth, (req, res) => {
  const mat = String(req.params.mat || "").trim();
  const { period } = req.query;

  const where = period ? "WHERE matricula = ? AND period = ?" : "WHERE matricula = ?";
  const params = period ? [mat, String(period)] : [mat];

  const agg = db.prepare(`
    SELECT
      COUNT(*) AS registros,
      COALESCE(SUM(horas_extras),0) AS horas_extras,
      COALESCE(SUM(falta_atestado),0) AS falta_atestado,
      COALESCE(SUM(falta_sem_atestado),0) AS falta_sem_atestado
    FROM records
    ${where}
  `).get(params);

  const info = db.prepare(`
    SELECT
      MAX(nome) AS nome,
      MAX(funcao) AS funcao,
      MAX(vinculo) AS vinculo,
      MAX(carga) AS carga
    FROM records
    ${where}
  `).get(params);

  res.json({
    matricula: mat,
    period: period ? String(period) : null,
    ...info,
    ...agg,
    total_faltas: (agg.falta_atestado || 0) + (agg.falta_sem_atestado || 0)
  });
});

// ===== ADM: LISTAR REGISTROS (com filtros) =====
app.get("/api/admin/records", auth, (req, res) => {
  const { period, matricula, limit = 200 } = req.query;

  const clauses = [];
  const params = [];

  if (period) { clauses.push("period = ?"); params.push(String(period)); }
  if (matricula) { clauses.push("matricula = ?"); params.push(String(matricula)); }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`
    SELECT r.*, u.source
    FROM records r
    JOIN uploads u ON u.id = r.upload_id
    ${where}
    ORDER BY r.id DESC
    LIMIT ?
  `).all([...params, Number(limit) || 200]);

  res.json({ records: rows });
});

app.listen(PORT, () => {
  console.log(`✅ Server on http://localhost:${PORT}`);
});
