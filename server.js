// server.js
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";
import dns from "dns";

const { Pool } = pg;

/**
 * Render/Supabase: prioriza IPv4 em alguns ambientes (ajuda a evitar erros de DNS/rede)
 */
try { dns.setDefaultResultOrder("ipv4first"); } catch {}

/**
 * ENV (Render)
 * - DATABASE_URL
 * - ADMIN_PASSWORD
 * - JWT_SECRET
 */
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const JWT_SECRET = process.env.JWT_SECRET || "";

if (!DATABASE_URL) console.warn("⚠️ Falta DATABASE_URL no ambiente (Render).");
if (!ADMIN_PASSWORD) console.warn("⚠️ Falta ADMIN_PASSWORD no ambiente (Render).");
if (!JWT_SECRET) console.warn("⚠️ Falta JWT_SECRET no ambiente (Render).");

/**
 * Pool Postgres
 */
const pool = new Pool({
  connectionString: DATABASE_URL,
  // Se sua DATABASE_URL já tiver sslmode, deixa o pg lidar.
  ssl: DATABASE_URL.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

/**
 * queryMode: 'simple' para evitar prepared statements (supabase pooler pode reclamar)
 */
async function dbQuery(text, values = []) {
  return pool.query({ text, values, queryMode: "simple" });
}

/**
 * Cria/atualiza tabelas
 */
async function ensureSchema() {
  try {
    await dbQuery(`
      create table if not exists funcionarios (
        matricula text primary key,
        nome text,
        funcao text,
        vinculo text,
        carga text,
        escola text,
        atualizado_em timestamptz default now()
      );
    `);

    await dbQuery(`
      create table if not exists folhas (
        id bigserial primary key,
        periodo text not null,
        matricula text not null references funcionarios(matricula) on delete cascade,
        faltas int default 0,
        falta_sem_atestado int default 0,
        horas_extras int default 0,
        observacoes text,
        criado_em timestamptz default now(),
        atualizado_em timestamptz default now(),
        unique (periodo, matricula)
      );
    `);

    // ✅ Novo campo (sem quebrar o antigo)
    await dbQuery(`alter table folhas add column if not exists falta_com_atestado int default 0;`);

    await dbQuery(`create index if not exists idx_folhas_periodo on folhas(periodo);`);

    console.log("✅ Schema ok.");
  } catch (err) {
    console.error("❌ ensureSchema erro:", err?.message || err);
  }
}
ensureSchema();

/**
 * App
 */
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/**
 * Static: /public
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

/**
 * Auth Admin
 */
function signAdminToken() {
  return jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "7d" });
}

function requireAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Sem token" });

    const payload = jwt.verify(token, JWT_SECRET);
    if (payload?.role !== "admin") return res.status(403).json({ ok: false, error: "Acesso negado" });

    req.admin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }
}

/**
 * Health
 */
app.get("/api/health", async (req, res) => {
  try {
    await dbQuery("select 1;");
    res.json({ ok: true, db: true });
  } catch (e) {
    res.status(200).json({ ok: true, db: false, error: e?.message });
  }
});

/**
 * Login Admin
 * POST /api/login {password} -> {token}
 */
app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD || !JWT_SECRET) {
    return res.status(500).json({ ok: false, error: "Servidor sem configuração (ADMIN_PASSWORD/JWT_SECRET)." });
  }
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Senha inválida" });
  }
  return res.json({ ok: true, token: signAdminToken() });
});

/**
 * ✅ PÚBLICO (Folha): lista funcionários (somente leitura)
 * GET /api/funcionarios
 */
app.get("/api/funcionarios", async (req, res) => {
  try {
    const r = await dbQuery(`
      select matricula, nome, funcao, vinculo, carga, escola
      from funcionarios
      order by nome nulls last, matricula
    `);
    res.json({ ok: true, funcionarios: r.rows });
  } catch (err) {
    console.error("❌ GET /api/funcionarios erro:", err);
    res.status(500).json({ ok: false, error: err?.message || "Erro interno" });
  }
});

/**
 * Folha envia (UPSERT)
 * POST /api/folha/enviar
 */
app.post("/api/folha/enviar", async (req, res) => {
  try {
    const body = req.body || {};
    const periodo = String(body.periodo || "").trim(); // YYYY-MM
    const matricula = String(body.matricula || "").trim();

    if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
      return res.status(400).json({ ok: false, error: "Período inválido. Use YYYY-MM (ex: 2026-02)" });
    }
    if (!matricula) {
      return res.status(400).json({ ok: false, error: "Matrícula é obrigatória" });
    }

    const nome = body.nome ?? null;
    const funcao = body.funcao ?? null;
    const vinculo = body.vinculo ?? null;
    const carga = body.carga ?? null;
    const escola = body.escola ?? null;

    const faltas = Number.isFinite(+body.faltas) ? +body.faltas : 0;

    // ✅ aceita o novo e mantém compatibilidade com o antigo
    const faltaComAtestado =
      Number.isFinite(+body.falta_com_atestado) ? +body.falta_com_atestado :
      (Number.isFinite(+body.falta_sem_atestado) ? +body.falta_sem_atestado : 0);

    const horasExtras = Number.isFinite(+body.horas_extras) ? +body.horas_extras : 0;
    const observacoes = body.observacoes ?? null;

    // 1) garante que o funcionário existe/atualiza cadastro
    await dbQuery(
      `
      insert into funcionarios (matricula, nome, funcao, vinculo, carga, escola, atualizado_em)
      values ($1,$2,$3,$4,$5,$6, now())
      on conflict (matricula) do update set
        nome = coalesce(excluded.nome, funcionarios.nome),
        funcao = coalesce(excluded.funcao, funcionarios.funcao),
        vinculo = coalesce(excluded.vinculo, funcionarios.vinculo),
        carga = coalesce(excluded.carga, funcionarios.carga),
        escola = coalesce(excluded.escola, funcionarios.escola),
        atualizado_em = now()
      `,
      [matricula, nome, funcao, vinculo, carga, escola]
    );

    // 2) grava folha do mês
    // - salva no novo campo falta_com_atestado
    // - e também espelha no antigo falta_sem_atestado (para não quebrar nada antigo)
    await dbQuery(
      `
      insert into folhas (
        periodo, matricula,
        faltas, falta_com_atestado, falta_sem_atestado,
        horas_extras, observacoes, atualizado_em
      )
      values ($1,$2,$3,$4,$4,$5,$6, now())
      on conflict (periodo, matricula) do update set
        faltas = excluded.faltas,
        falta_com_atestado = excluded.falta_com_atestado,
        falta_sem_atestado = excluded.falta_sem_atestado,
        horas_extras = excluded.horas_extras,
        observacoes = excluded.observacoes,
        atualizado_em = now()
      `,
      [periodo, matricula, faltas, faltaComAtestado, horasExtras, observacoes]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error("❌ POST /api/folha/enviar erro:", err);
    res.status(500).json({ ok: false, error: err?.message || "Erro interno" });
  }
});

/**
 * ADMIN: listar cadastro
 * GET /api/admin/funcionarios
 */
app.get("/api/admin/funcionarios", requireAdmin, async (req, res) => {
  try {
    const r = await dbQuery(`
      select matricula, nome, funcao, vinculo, carga, escola, atualizado_em
      from funcionarios
      order by nome nulls last, matricula
    `);
    res.json({ ok: true, funcionarios: r.rows });
  } catch (err) {
    console.error("❌ GET /api/admin/funcionarios erro:", err);
    res.status(500).json({ ok: false, error: err?.message || "Erro interno" });
  }
});

/**
 * ADMIN: editar cadastro
 * PUT /api/admin/funcionarios/:matricula
 */
app.put("/api/admin/funcionarios/:matricula", requireAdmin, async (req, res) => {
  try {
    const matricula = String(req.params.matricula || "").trim();
    if (!matricula) return res.status(400).json({ ok: false, error: "Matrícula inválida" });

    const body = req.body || {};
    const nome = body.nome ?? null;
    const funcao = body.funcao ?? null;
    const vinculo = body.vinculo ?? null;
    const carga = body.carga ?? null;
    const escola = body.escola ?? null;

    const r = await dbQuery(
      `
      insert into funcionarios (matricula, nome, funcao, vinculo, carga, escola, atualizado_em)
      values ($1,$2,$3,$4,$5,$6, now())
      on conflict (matricula) do update set
        nome = excluded.nome,
        funcao = excluded.funcao,
        vinculo = excluded.vinculo,
        carga = excluded.carga,
        escola = excluded.escola,
        atualizado_em = now()
      returning *
      `,
      [matricula, nome, funcao, vinculo, carga, escola]
    );

    res.json({ ok: true, funcionario: r.rows[0] });
  } catch (err) {
    console.error("❌ PUT /api/admin/funcionarios/:matricula erro:", err);
    res.status(500).json({ ok: false, error: err?.message || "Erro interno" });
  }
});

/**
 * ✅ ADMIN: dados do mês
 * GET /api/admin/mes?periodo=YYYY-MM
 *
 * ⚠️ IMPORTANTE: seu admin.html espera "registros"
 */
app.get("/api/admin/mes", requireAdmin, async (req, res) => {
  try {
    const periodo = String(req.query.periodo || "").trim();
    if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
      return res.status(400).json({ ok: false, error: "Período inválido. Use YYYY-MM (ex: 2026-02)" });
    }

    const r = await dbQuery(
      `
      select
        f.escola,
        f.matricula,
        f.nome,
        f.funcao,
        f.vinculo,
        f.carga,
        $1 as periodo,
        coalesce(fl.faltas, 0) as faltas,
        coalesce(fl.falta_com_atestado, fl.falta_sem_atestado, 0) as falta_com_atestado,
        coalesce(fl.horas_extras, 0) as horas_extras,
        coalesce(fl.observacoes, '') as observacoes
      from funcionarios f
      left join folhas fl
        on fl.matricula = f.matricula
       and fl.periodo = $1
      order by f.nome nulls last, f.matricula
      `,
      [periodo]
    );

    // ✅ admin.html usa j.registros
    return res.json({ ok: true, periodo, registros: r.rows });
  } catch (err) {
    console.error("❌ GET /api/admin/mes erro:", err);
    res.status(500).json({ ok: false, error: err?.message || "Erro interno" });
  }
});

/**
 * Fallback (opcional)
 */
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"), (err) => {
    if (err) res.status(404).send("Not found");
  });
});

app.listen(PORT, () => {
  console.log(`✅ Server ON na porta ${PORT}`);
});
