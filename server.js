// server.js (ESM)
// Requisitos no package.json: express, pg, jsonwebtoken, cors

import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import jwt from "jsonwebtoken";
import pg from "pg";

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 10000;

// ====== ENV ======
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();
const JWT_SECRET = (process.env.JWT_SECRET || "TROQUE_NO_RENDER").trim();
const DATABASE_URL = (process.env.DATABASE_URL || "").trim();

if (!DATABASE_URL) {
  console.warn("⚠️ DATABASE_URL não configurada. O servidor vai subir, mas rotas do banco vão falhar.");
}

// ====== PATHS (para servir HTML/CSS/JS) ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ajuste aqui se seu projeto guarda HTML em outro lugar.
// Exemplo comum: src/public
const PUBLIC_DIR = path.join(__dirname, "public");

// Serve arquivos estáticos (index.html, admin.html, folha.html, etc)
app.use(express.static(PUBLIC_DIR));

// Fallback: se acessar "/" abre index.html se existir
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

// ====== BANCO (pg) ======
// Usamos SSL + rejectUnauthorized:false para evitar o erro SELF_SIGNED_CERT_IN_CHAIN.
// E queryMode:'simple' para evitar PREPARE statements (pooler/pgbouncer).
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      // max e timeouts podem ajudar no Render
      max: 5,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

async function dbQuery(text, values = []) {
  if (!pool) throw new Error("DATABASE_URL não configurada (pool não inicializado).");
  // queryMode:'simple' evita prepared statements (resolve “Does not support PREPARE statements”)
  return pool.query({ text, values, queryMode: "simple" });
}

async function ensureSchema() {
  if (!pool) return;

  // Tabela de funcionários “fixos” (matrícula única)
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS employees (
      matricula TEXT PRIMARY KEY,
      nome TEXT DEFAULT '',
      funcao TEXT DEFAULT '',
      vinculo TEXT DEFAULT '',
      carga TEXT DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Envios de folha (um por funcionário por mês por escola — pode ter correção depois)
  await dbQuery(`
    CREATE TABLE IF NOT EXISTS folha_envios (
      id BIGSERIAL PRIMARY KEY,
      periodo TEXT NOT NULL,           -- YYYY-MM
      escola TEXT NOT NULL DEFAULT '',
      matricula TEXT NOT NULL,
      nome TEXT NOT NULL DEFAULT '',
      funcao TEXT NOT NULL DEFAULT '',
      vinculo TEXT NOT NULL DEFAULT '',
      carga TEXT NOT NULL DEFAULT '',
      faltas INTEGER NOT NULL DEFAULT 0,
      horas_extras NUMERIC(10,2) NOT NULL DEFAULT 0,
      observacao TEXT NOT NULL DEFAULT '',
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Evita duplicidade (mesmo funcionário, mesma escola, mesmo mês)
  await dbQuery(`
    CREATE UNIQUE INDEX IF NOT EXISTS folha_unique_mes
    ON folha_envios(periodo, escola, matricula);
  `);

  console.log("✅ Banco pronto (schema OK)");
}

// tenta preparar schema ao iniciar
ensureSchema().catch((e) => console.error("❌ Falha ao preparar schema:", e?.message || e));

// ====== AUTH ======
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const parts = auth.split(" ");
  const token = parts.length === 2 ? parts[1] : "";

  if (!token) return res.status(401).json({ error: "Token ausente" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload?.role !== "admin") return res.status(403).json({ error: "Acesso negado" });
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Token inválido/expirado" });
  }
}

// ====== LOGIN ADMIN ======
app.post("/api/login", (req, res) => {
  const password = (req.body?.password || "").trim();

  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: "ADMIN_PASSWORD não configurado no Render" });
  }

  if (!password) return res.status(400).json({ error: "Informe a senha" });

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Senha inválida" });
  }

  const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "12h" });
  return res.json({ token });
});

// ====== HELPERS ======
function normalizePeriodo(p) {
  const periodo = (p || "").trim();
  if (!/^\d{4}-\d{2}$/.test(periodo)) return null;
  return periodo;
}

function asText(v) {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function asInt(v, def = 0) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : def;
}

function asNum(v, def = 0) {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : def;
}

// ====== ROTAS DA FOLHA (envio) ======
// A página folha.html deve POSTAR aqui.
// Isso faz UPSERT do funcionário (employees) e UPSERT do envio do mês (folha_envios)
app.post("/api/folha/enviar", async (req, res) => {
  try {
    const body = req.body || {};
    const periodo = normalizePeriodo(body.periodo);
    if (!periodo) return res.status(400).json({ error: "periodo inválido. Use YYYY-MM (ex: 2026-02)" });

    const escola = asText(body.escola);
    const matricula = asText(body.matricula);
    if (!matricula) return res.status(400).json({ error: "matricula é obrigatória" });

    const nome = asText(body.nome);
    const funcao = asText(body.funcao);
    const vinculo = asText(body.vinculo);
    const carga = asText(body.carga);

    const faltas = asInt(body.faltas, 0);
    const horas_extras = asNum(body.horas_extras, 0);
    const observacao = asText(body.observacao);

    // Salva o funcionário “fixo” (assim o admin sempre tem todos cadastrados)
    await dbQuery(
      `
      INSERT INTO employees (matricula, nome, funcao, vinculo, carga, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (matricula)
      DO UPDATE SET
        nome = EXCLUDED.nome,
        funcao = EXCLUDED.funcao,
        vinculo = EXCLUDED.vinculo,
        carga = EXCLUDED.carga,
        updated_at = NOW()
      `,
      [matricula, nome, funcao, vinculo, carga]
    );

    // Salva o envio do mês (UPSERT: se já existe, atualiza)
    const payload = body.payload && typeof body.payload === "object" ? body.payload : body;

    const result = await dbQuery(
      `
      INSERT INTO folha_envios
        (periodo, escola, matricula, nome, funcao, vinculo, carga, faltas, horas_extras, observacao, payload, updated_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,NOW())
      ON CONFLICT (periodo, escola, matricula)
      DO UPDATE SET
        nome = EXCLUDED.nome,
        funcao = EXCLUDED.funcao,
        vinculo = EXCLUDED.vinculo,
        carga = EXCLUDED.carga,
        faltas = EXCLUDED.faltas,
        horas_extras = EXCLUDED.horas_extras,
        observacao = EXCLUDED.observacao,
        payload = EXCLUDED.payload,
        updated_at = NOW()
      RETURNING id
      `,
      [
        periodo,
        escola,
        matricula,
        nome,
        funcao,
        vinculo,
        carga,
        faltas,
        horas_extras,
        observacao,
        JSON.stringify(payload),
      ]
    );

    return res.json({ ok: true, id: result.rows?.[0]?.id });
  } catch (e) {
    console.error("❌ /api/folha/enviar:", e);
    return res.status(500).json({ error: e?.message || "Erro interno" });
  }
});

// ====== ADMIN: LISTAR FUNCIONÁRIOS (sempre todos) ======
app.get("/api/admin/funcionarios", requireAdmin, async (req, res) => {
  try {
    const q = asText(req.query.q).toLowerCase();
    const where = q
      ? `WHERE LOWER(matricula) LIKE $1 OR LOWER(nome) LIKE $1 OR LOWER(funcao) LIKE $1`
      : "";
    const params = q ? [`%${q}%`] : [];

    const r = await dbQuery(
      `
      SELECT matricula, nome, funcao, vinculo, carga, updated_at
      FROM employees
      ${where}
      ORDER BY nome ASC
      LIMIT 500
      `,
      params
    );

    return res.json({ funcionarios: r.rows });
  } catch (e) {
    console.error("❌ /api/admin/funcionarios:", e);
    return res.status(500).json({ error: e?.message || "Erro interno" });
  }
});

// ====== ADMIN: BALANÇO DO MÊS (todas as escolas ou por escola) ======
// GET /api/admin/mes?periodo=YYYY-MM&escola=... (opcional)
app.get("/api/admin/mes", requireAdmin, async (req, res) => {
  try {
    const periodo = normalizePeriodo(req.query.periodo);
    if (!periodo) return res.status(400).json({ error: "periodo inválido. Use YYYY-MM" });

    const escola = asText(req.query.escola);

    const where = escola ? `WHERE periodo = $1 AND escola = $2` : `WHERE periodo = $1`;
    const params = escola ? [periodo, escola] : [periodo];

    // KPIs
    const kpi = await dbQuery(
      `
      SELECT
        COUNT(*)::int AS total_registros,
        COALESCE(SUM(horas_extras), 0)::float AS horas_extras_soma,
        COALESCE(SUM(faltas), 0)::int AS faltas_soma
      FROM folha_envios
      ${where}
      `,
      params
    );

    // Registros detalhados
    const regs = await dbQuery(
      `
      SELECT id, periodo, escola, matricula, nome, funcao, vinculo, carga, faltas, horas_extras, observacao, updated_at
      FROM folha_envios
      ${where}
      ORDER BY escola ASC, nome ASC
      LIMIT 5000
      `,
      params
    );

    return res.json({
      periodo,
      escola: escola || "Todas",
      kpis: kpi.rows?.[0] || { total_registros: 0, horas_extras_soma: 0, faltas_soma: 0 },
      registros: regs.rows || [],
    });
  } catch (e) {
    console.error("❌ /api/admin/mes:", e);
    return res.status(500).json({ error: e?.message || "Erro interno" });
  }
});

// ====== ADMIN: DETALHADO POR ESCOLA (agrupado) ======
app.get("/api/admin/mes/escolas", requireAdmin, async (req, res) => {
  try {
    const periodo = normalizePeriodo(req.query.periodo);
    if (!periodo) return res.status(400).json({ error: "periodo inválido. Use YYYY-MM" });

    const r = await dbQuery(
      `
      SELECT
        escola,
        COUNT(*)::int AS total_registros,
        COALESCE(SUM(horas_extras),0)::float AS horas_extras_soma,
        COALESCE(SUM(faltas),0)::int AS faltas_soma
      FROM folha_envios
      WHERE periodo = $1
      GROUP BY escola
      ORDER BY escola ASC
      `,
      [periodo]
    );

    return res.json({ periodo, escolas: r.rows });
  } catch (e) {
    console.error("❌ /api/admin/mes/escolas:", e);
    return res.status(500).json({ error: e?.message || "Erro interno" });
  }
});

// ====== ADMIN: EDITAR REGISTRO (A) ======
app.put("/api/admin/registro/:id", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const body = req.body || {};

    const faltas = asInt(body.faltas, 0);
    const horas_extras = asNum(body.horas_extras, 0);
    const observacao = asText(body.observacao);

    const r = await dbQuery(
      `
      UPDATE folha_envios
      SET faltas = $1,
          horas_extras = $2,
          observacao = $3,
          payload = COALESCE($4::jsonb, payload),
          updated_at = NOW()
      WHERE id = $5
      RETURNING id
      `,
      [faltas, horas_extras, observacao, body.payload ? JSON.stringify(body.payload) : null, id]
    );

    if (!r.rowCount) return res.status(404).json({ error: "Registro não encontrado" });
    return res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    console.error("❌ PUT /api/admin/registro/:id:", e);
    return res.status(500).json({ error: e?.message || "Erro interno" });
  }
});

// ====== ADMIN: APAGAR REGISTRO (B) ======
app.delete("/api/admin/registro/:id", requireAdmin, async (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const r = await dbQuery(`DELETE FROM folha_envios WHERE id = $1`, [id]);
    if (!r.rowCount) return res.status(404).json({ error: "Registro não encontrado" });
    return res.json({ ok: true });
  } catch (e) {
    console.error("❌ DELETE /api/admin/registro/:id:", e);
    return res.status(500).json({ error: e?.message || "Erro interno" });
  }
});

// ====== DEBUG RÁPIDO ======
app.get("/api/health", async (req, res) => {
  try {
    if (!pool) return res.json({ ok: true, db: false });
    const r = await dbQuery("SELECT 1 as ok");
    return res.json({ ok: true, db: r.rows?.[0]?.ok === 1 });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || "Erro" });
  }
});

app.listen(PORT, () => {
  console.log("✅ Servidor rodando na porta", PORT);
  console.log("📌 Public dir:", PUBLIC_DIR);
});
