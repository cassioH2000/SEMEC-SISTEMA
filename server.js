// server.js (ESM) - SEMEC Sistema
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

// (opcional) dotenv local - no Render não precisa, mas ajuda no PC
try {
  const dotenv = await import("dotenv");
  dotenv.default.config();
} catch (_) {}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ---------- Config ----------
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();
const JWT_SECRET = (process.env.JWT_SECRET || "semec_jwt_secret_trocar").trim();
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

// ---------- Static (public) ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// Rota raiz (evita "Cannot GET /" caso não tenha index)
app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ---------- Banco (pg) ----------
if (!DATABASE_URL) {
  console.warn("⚠️ DATABASE_URL não configurada. Configure no Render (Environment).");
}

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  // Corrige SELF_SIGNED_CERT_IN_CHAIN no ambiente do Render/Supabase
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 20_000,
});

// helper de query SEM PREPARE (bom pro transaction pooler)
async function q(text, values = []) {
  return pool.query({ text, values, queryMode: "simple" });
}

// cria tabelas se não existirem
async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS employees (
      matricula TEXT PRIMARY KEY,
      nome TEXT DEFAULT '',
      funcao TEXT DEFAULT '',
      vinculo TEXT DEFAULT '',
      carga TEXT DEFAULT '',
      escola TEXT DEFAULT ''
    );
  `);

  await q(`
    CREATE TABLE IF NOT EXISTS submissions (
      id BIGSERIAL PRIMARY KEY,
      periodo DATE NOT NULL,                 -- usar sempre 1º dia do mês
      matricula TEXT NOT NULL REFERENCES employees(matricula) ON DELETE CASCADE,
      escola TEXT DEFAULT '',
      dias_trabalhados INTEGER,
      faltas INTEGER,
      horas_extras NUMERIC(10,2),
      observacoes TEXT,
      payload JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (periodo, matricula)
    );
  `);
}

// conecta e prepara schema (não derruba o server se falhar)
(async () => {
  try {
    await ensureSchema();
    console.log("✅ Banco pronto (schema ok).");
  } catch (err) {
    console.error("❌ Falha ao preparar o banco (ensureSchema):", err?.message || err);
  }
})();

// ---------- Auth ----------
function authAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ error: "Sem token" });

  try {
    const data = jwt.verify(token, JWT_SECRET);
    if (data?.role !== "admin") return res.status(403).json({ error: "Sem permissão" });
    req.user = data;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Token inválido" });
  }
}

// ---------- Login ----------
app.post("/api/login", async (req, res) => {
  try {
    const senha = String(req.body?.password ?? "").trim();

    if (!ADMIN_PASSWORD) {
      return res.status(500).json({
        error: "ADMIN_PASSWORD não configurado no Render.",
      });
    }

    if (senha !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: "Senha inválida" });
    }

    const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "12h" });
    return res.json({ token });
  } catch (e) {
    return res.status(500).json({ error: "Erro no login" });
  }
});

// ---------- Folha: enviar/atualizar ----------
/**
 * Espera algo assim:
 * {
 *   "periodo": "2026-02",
 *   "escola": "ESCOLA X",
 *   "matricula": "396",
 *   "nome": "...",
 *   "funcao": "...",
 *   "vinculo": "...",
 *   "carga": "...",
 *   "dias_trabalhados": 20,
 *   "faltas": 1,
 *   "horas_extras": 4.5,
 *   "observacoes": "..."
 * }
 */
app.post("/api/folha/enviar", async (req, res) => {
  try {
    const body = req.body || {};
    const matricula = String(body.matricula || "").trim();
    const periodoStr = String(body.periodo || "").trim(); // "YYYY-MM"
    const escola = String(body.escola || "").trim();

    if (!matricula) return res.status(400).json({ error: "matricula é obrigatória" });
    if (!/^\d{4}-\d{2}$/.test(periodoStr)) {
      return res.status(400).json({ error: "periodo deve ser YYYY-MM" });
    }

    const periodoDate = `${periodoStr}-01`;

    // 1) garante funcionário existe e ATUALIZA dados quando vier algo da folha (upsert)
    const nome = String(body.nome || "").trim();
    const funcao = String(body.funcao || "").trim();
    const vinculo = String(body.vinculo || "").trim();
    const carga = String(body.carga || "").trim();

    await q(
      `
      INSERT INTO employees (matricula, nome, funcao, vinculo, carga, escola)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (matricula) DO UPDATE SET
        nome = COALESCE(NULLIF(EXCLUDED.nome,''), employees.nome),
        funcao = COALESCE(NULLIF(EXCLUDED.funcao,''), employees.funcao),
        vinculo = COALESCE(NULLIF(EXCLUDED.vinculo,''), employees.vinculo),
        carga = COALESCE(NULLIF(EXCLUDED.carga,''), employees.carga),
        escola = COALESCE(NULLIF(EXCLUDED.escola,''), employees.escola)
      `,
      [matricula, nome, funcao, vinculo, carga, escola]
    );

    // 2) salva/atualiza o registro do mês (1 por funcionário por mês)
    const dias_trabalhados = body.dias_trabalhados ?? null;
    const faltas = body.faltas ?? null;
    const horas_extras = body.horas_extras ?? null;
    const observacoes = body.observacoes ?? null;

    await q(
      `
      INSERT INTO submissions (periodo, matricula, escola, dias_trabalhados, faltas, horas_extras, observacoes, payload)
      VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (periodo, matricula) DO UPDATE SET
        escola = COALESCE(NULLIF(EXCLUDED.escola,''), submissions.escola),
        dias_trabalhados = EXCLUDED.dias_trabalhados,
        faltas = EXCLUDED.faltas,
        horas_extras = EXCLUDED.horas_extras,
        observacoes = EXCLUDED.observacoes,
        payload = EXCLUDED.payload
      `,
      [
        periodoDate,
        matricula,
        escola,
        dias_trabalhados,
        faltas,
        horas_extras,
        observacoes,
        JSON.stringify(body),
      ]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /api/folha/enviar:", err?.message || err);
    return res.status(500).json({ error: "Erro ao salvar envio" });
  }
});

// ---------- Admin: mês (TODOS os funcionários SEMPRE) ----------
/**
 * GET /api/admin/mes?periodo=2026-02&escola=...
 * Retorna todos employees + dados do mês (se existir submissão)
 */
app.get("/api/admin/mes", authAdmin, async (req, res) => {
  try {
    const periodoStr = String(req.query.periodo || "").trim();
    const escola = String(req.query.escola || "").trim();

    if (!/^\d{4}-\d{2}$/.test(periodoStr)) {
      return res.status(400).json({ error: "periodo deve ser YYYY-MM" });
    }

    const periodoDate = `${periodoStr}-01`;

    // filtro por escola (opcional): usa escola do envio do mês ou do cadastro se não tiver envio
    const rows = await q(
      `
      SELECT
        e.matricula,
        e.nome, e.funcao, e.vinculo, e.carga,
        COALESCE(s.escola, e.escola, '') AS escola,
        s.dias_trabalhados,
        s.faltas,
        s.horas_extras,
        s.observacoes,
        s.created_at
      FROM employees e
      LEFT JOIN submissions s
        ON s.matricula = e.matricula
       AND s.periodo = $1::date
      WHERE
        ($2 = '' OR COALESCE(s.escola, e.escola, '') = $2)
      ORDER BY e.nome ASC
      `,
      [periodoDate, escola]
    );

    // KPIs do mês (com base nas submissões existentes)
    const kpis = await q(
      `
      SELECT
        COUNT(*)::int AS total_envios,
        COALESCE(SUM(COALESCE(horas_extras,0)),0)::float AS horas_extras_soma
      FROM submissions
      WHERE periodo = $1::date
        AND ($2 = '' OR escola = $2)
      `,
      [periodoDate, escola]
    );

    return res.json({
      periodo: periodoStr,
      escola: escola || "Todas",
      kpis: kpis.rows[0],
      funcionarios: rows.rows,
    });
  } catch (err) {
    console.error("❌ /api/admin/mes:", err?.message || err);
    return res.status(500).json({ error: "Erro ao carregar mês" });
  }
});

// ---------- Admin: editar registro do mês ----------
app.put("/api/admin/registro", authAdmin, async (req, res) => {
  try {
    const { periodo, matricula } = req.body || {};
    const periodoStr = String(periodo || "").trim();
    const m = String(matricula || "").trim();
    if (!m) return res.status(400).json({ error: "matricula é obrigatória" });
    if (!/^\d{4}-\d{2}$/.test(periodoStr)) return res.status(400).json({ error: "periodo deve ser YYYY-MM" });

    const periodoDate = `${periodoStr}-01`;

    const escola = String(req.body?.escola || "").trim();
    const dias_trabalhados = req.body?.dias_trabalhados ?? null;
    const faltas = req.body?.faltas ?? null;
    const horas_extras = req.body?.horas_extras ?? null;
    const observacoes = req.body?.observacoes ?? null;

    // garante que existe submissão (upsert)
    await q(
      `
      INSERT INTO submissions (periodo, matricula, escola, dias_trabalhados, faltas, horas_extras, observacoes, payload)
      VALUES ($1::date, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (periodo, matricula) DO UPDATE SET
        escola = COALESCE(NULLIF(EXCLUDED.escola,''), submissions.escola),
        dias_trabalhados = EXCLUDED.dias_trabalhados,
        faltas = EXCLUDED.faltas,
        horas_extras = EXCLUDED.horas_extras,
        observacoes = EXCLUDED.observacoes,
        payload = EXCLUDED.payload
      `,
      [
        periodoDate,
        m,
        escola,
        dias_trabalhados,
        faltas,
        horas_extras,
        observacoes,
        JSON.stringify(req.body || {}),
      ]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /api/admin/registro PUT:", err?.message || err);
    return res.status(500).json({ error: "Erro ao editar" });
  }
});

// ---------- Admin: apagar registro do mês ----------
app.delete("/api/admin/registro", authAdmin, async (req, res) => {
  try {
    const periodoStr = String(req.query.periodo || "").trim();
    const matricula = String(req.query.matricula || "").trim();
    if (!matricula) return res.status(400).json({ error: "matricula é obrigatória" });
    if (!/^\d{4}-\d{2}$/.test(periodoStr)) return res.status(400).json({ error: "periodo deve ser YYYY-MM" });

    const periodoDate = `${periodoStr}-01`;
    await q(`DELETE FROM submissions WHERE periodo = $1::date AND matricula = $2`, [periodoDate, matricula]);

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ /api/admin/registro DELETE:", err?.message || err);
    return res.status(500).json({ error: "Erro ao apagar" });
  }
});

// Healthcheck simples
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log(`📁 Public dir: ${publicDir}`);
});
