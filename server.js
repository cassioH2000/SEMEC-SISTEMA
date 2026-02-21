// server.js (ESM) - SEMEC SISTEMA
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

// dotenv é opcional (no Render normalmente não precisa)
try {
  const dotenv = await import("dotenv");
  dotenv.config();
} catch (_) {}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ✅ Servir arquivos estáticos do /public
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000;

// ======= ENV =======
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const JWT_SECRET = process.env.JWT_SECRET || "change_me_now";
let DATABASE_URL = process.env.DATABASE_URL || "";

// ======= Helpers =======
function normalizePeriodo(periodo) {
  // aceita "2026-02" ou "2026-02-01" e retorna "2026-02"
  if (!periodo) return "";
  const p = String(periodo).trim();
  if (/^\d{4}-\d{2}$/.test(p)) return p;
  if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p.slice(0, 7);
  return "";
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Sem token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }
}

function buildPgConnectionString(url) {
  // ✅ Garantir sslmode=require (ajuda muito no Supabase)
  if (!url) return "";
  if (url.includes("sslmode=")) return url;
  const hasQuery = url.includes("?");
  return url + (hasQuery ? "&" : "?") + "sslmode=require";
}

// ======= PG Pool =======
DATABASE_URL = buildPgConnectionString(DATABASE_URL);

const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // ✅ resolve self-signed certificate
  },
});

// ======= Schema =======
async function ensureSchema() {
  // Tabela de funcionários (cadastro base)
  const sqlEmployees = `
    CREATE TABLE IF NOT EXISTS employees (
      matricula TEXT PRIMARY KEY,
      nome TEXT DEFAULT '',
      funcao TEXT DEFAULT '',
      vinculo TEXT DEFAULT '',
      carga TEXT DEFAULT ''
    );
  `;

  // Registros por mês (folha)
  const sqlRegistros = `
    CREATE TABLE IF NOT EXISTS folha_registros (
      id BIGSERIAL PRIMARY KEY,
      periodo TEXT NOT NULL,          -- "YYYY-MM"
      escola TEXT NOT NULL,           -- nome da escola
      matricula TEXT NOT NULL REFERENCES employees(matricula) ON DELETE CASCADE,
      horas_extras NUMERIC DEFAULT 0,
      faltas NUMERIC DEFAULT 0,
      observacao TEXT DEFAULT '',
      atualizado_em TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (periodo, escola, matricula)
    );
  `;

  await pool.query(sqlEmployees);
  await pool.query(sqlRegistros);
}

// ======= Boot DB =======
(async () => {
  try {
    console.log("Iniciando servidor...");
    console.log("Public dir:", path.join(__dirname, "public"));
    await ensureSchema();
    console.log("✅ Schema OK");
  } catch (e) {
    console.log("❌ Falha ao preparar schema:", e?.message || e);
    // Não derruba o servidor; o site continua online, mas endpoints de DB falham.
  }
})();

// ======= ROTAS =======

// Health
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1 as ok");
    res.json({ ok: true, db: true });
  } catch (e) {
    res.json({ ok: true, db: false, error: e?.message || String(e) });
  }
});

// ✅ LOGIN ADMIN
app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({
      ok: false,
      error: "ADMIN_PASSWORD não configurado no Render.",
    });
  }

  if (!password || String(password) !== String(ADMIN_PASSWORD)) {
    return res.status(401).json({ ok: false, error: "Senha inválida" });
  }

  const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "12h" });
  return res.json({ ok: true, token });
});

// ✅ Folha envia/atualiza registro do funcionário citado (UPSERT)
app.post("/api/folha/enviar", async (req, res) => {
  try {
    const body = req.body || {};

    const periodo = normalizePeriodo(body.periodo);
    const escola = String(body.escola || "").trim();
    const matricula = String(body.matricula || "").trim();

    const nome = String(body.nome || "").trim();
    const funcao = String(body.funcao || "").trim();
    const vinculo = String(body.vinculo || "").trim();
    const carga = String(body.carga || "").trim();

    const horas_extras = Number(body.horas_extras || 0) || 0;
    const faltas = Number(body.faltas || 0) || 0;
    const observacao = String(body.observacao || "").trim();

    if (!periodo) return res.status(400).json({ ok: false, error: "Período inválido (use AAAA-MM)" });
    if (!escola) return res.status(400).json({ ok: false, error: "Escola obrigatória" });
    if (!matricula) return res.status(400).json({ ok: false, error: "Matrícula obrigatória" });

    // 1) garante funcionário existe (ou atualiza os campos se vierem preenchidos)
    await pool.query(
      `
      INSERT INTO employees (matricula, nome, funcao, vinculo, carga)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (matricula) DO UPDATE SET
        nome = CASE WHEN EXCLUDED.nome <> '' THEN EXCLUDED.nome ELSE employees.nome END,
        funcao = CASE WHEN EXCLUDED.funcao <> '' THEN EXCLUDED.funcao ELSE employees.funcao END,
        vinculo = CASE WHEN EXCLUDED.vinculo <> '' THEN EXCLUDED.vinculo ELSE employees.vinculo END,
        carga = CASE WHEN EXCLUDED.carga <> '' THEN EXCLUDED.carga ELSE employees.carga END
      `,
      [matricula, nome, funcao, vinculo, carga]
    );

    // 2) registra/atualiza folha do mês
    await pool.query(
      `
      INSERT INTO folha_registros (periodo, escola, matricula, horas_extras, faltas, observacao, atualizado_em)
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
      ON CONFLICT (periodo, escola, matricula) DO UPDATE SET
        horas_extras = EXCLUDED.horas_extras,
        faltas = EXCLUDED.faltas,
        observacao = EXCLUDED.observacao,
        atualizado_em = NOW()
      `,
      [periodo, escola, matricula, horas_extras, faltas, observacao]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.log("❌ /api/folha/enviar erro:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ✅ ADMIN: Balanço geral do mês (todas as escolas) + lista por funcionário
app.get("/api/admin/mes", requireAuth, async (req, res) => {
  try {
    const periodo = normalizePeriodo(req.query.periodo);
    if (!periodo) return res.status(400).json({ ok: false, error: "Período inválido (use AAAA-MM)" });

    // Total de envios e soma de horas extras do mês (todas as escolas)
    const tot = await pool.query(
      `
      SELECT
        COUNT(*)::int AS total_envios,
        COALESCE(SUM(horas_extras), 0) AS horas_extras_soma
      FROM folha_registros
      WHERE periodo = $1
      `,
      [periodo]
    );

    // Lista geral: todos os funcionários + dados do mês (se tiver)
    // (se funcionário não tiver registro no mês, aparece com 0 e escola vazia)
    const lista = await pool.query(
      `
      SELECT
        e.matricula,
        e.nome,
        e.funcao,
        e.vinculo,
        e.carga,
        r.escola,
        COALESCE(r.horas_extras, 0) AS horas_extras,
        COALESCE(r.faltas, 0) AS faltas,
        COALESCE(r.observacao, '') AS observacao,
        r.atualizado_em
      FROM employees e
      LEFT JOIN folha_registros r
        ON r.matricula = e.matricula AND r.periodo = $1
      ORDER BY e.nome ASC
      `,
      [periodo]
    );

    // Escolas do mês (para dropdown)
    const escolas = await pool.query(
      `
      SELECT DISTINCT escola
      FROM folha_registros
      WHERE periodo = $1
      ORDER BY escola ASC
      `,
      [periodo]
    );

    return res.json({
      ok: true,
      periodo,
      resumo: {
        total_envios: tot.rows[0]?.total_envios || 0,
        horas_extras_soma: Number(tot.rows[0]?.horas_extras_soma || 0),
      },
      escolas: escolas.rows.map((x) => x.escola),
      funcionarios: lista.rows,
    });
  } catch (e) {
    console.log("❌ /api/admin/mes erro:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ✅ ADMIN: registros detalhados (por escola opcional)
app.get("/api/admin/registros", requireAuth, async (req, res) => {
  try {
    const periodo = normalizePeriodo(req.query.periodo);
    const escola = String(req.query.escola || "").trim(); // opcional

    if (!periodo) return res.status(400).json({ ok: false, error: "Período inválido (use AAAA-MM)" });

    const params = [periodo];
    let where = "WHERE r.periodo = $1";
    if (escola && escola.toLowerCase() !== "todas" && escola.toLowerCase() !== "todas as escolas") {
      params.push(escola);
      where += ` AND r.escola = $${params.length}`;
    }

    const q = await pool.query(
      `
      SELECT
        r.periodo,
        r.escola,
        e.matricula,
        e.nome,
        e.funcao,
        e.vinculo,
        e.carga,
        r.horas_extras,
        r.faltas,
        r.observacao,
        r.atualizado_em
      FROM folha_registros r
      JOIN employees e ON e.matricula = r.matricula
      ${where}
      ORDER BY r.escola ASC, e.nome ASC
      `,
      params
    );

    return res.json({ ok: true, periodo, escola: escola || "Todas as escolas", registros: q.rows });
  } catch (e) {
    console.log("❌ /api/admin/registros erro:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ✅ ADMIN: editar funcionário (cadastro)
app.put("/api/admin/funcionario/:matricula", requireAuth, async (req, res) => {
  try {
    const matricula = String(req.params.matricula || "").trim();
    if (!matricula) return res.status(400).json({ ok: false, error: "Matrícula inválida" });

    const nome = String(req.body?.nome || "").trim();
    const funcao = String(req.body?.funcao || "").trim();
    const vinculo = String(req.body?.vinculo || "").trim();
    const carga = String(req.body?.carga || "").trim();

    await pool.query(
      `
      INSERT INTO employees (matricula, nome, funcao, vinculo, carga)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (matricula) DO UPDATE SET
        nome = EXCLUDED.nome,
        funcao = EXCLUDED.funcao,
        vinculo = EXCLUDED.vinculo,
        carga = EXCLUDED.carga
      `,
      [matricula, nome, funcao, vinculo, carga]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.log("❌ /api/admin/funcionario/:matricula erro:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ✅ ADMIN: apagar registro do mês de um funcionário (apagar folha daquele mês/escola)
app.delete("/api/admin/registro", requireAuth, async (req, res) => {
  try {
    const periodo = normalizePeriodo(req.query.periodo);
    const escola = String(req.query.escola || "").trim();
    const matricula = String(req.query.matricula || "").trim();

    if (!periodo) return res.status(400).json({ ok: false, error: "Período inválido" });
    if (!escola) return res.status(400).json({ ok: false, error: "Escola obrigatória" });
    if (!matricula) return res.status(400).json({ ok: false, error: "Matrícula obrigatória" });

    await pool.query(
      `DELETE FROM folha_registros WHERE periodo=$1 AND escola=$2 AND matricula=$3`,
      [periodo, escola, matricula]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.log("❌ /api/admin/registro DELETE erro:", e?.message || e);
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Fallback: se bater em rota não existente na API
app.use("/api", (req, res) => {
  res.status(404).json({ ok: false, error: "Rota não encontrada" });
});

app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
