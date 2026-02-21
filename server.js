import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pg from "pg";

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json());

// ======================
// ENV obrigatórias
// ======================
const PORT = process.env.PORT || 3000;

// Supabase geralmente usa DATABASE_URL
const DATABASE_URL = process.env.DATABASE_URL;

// JWT e Admin
const JWT_SECRET = process.env.JWT_SECRET || "troque_essa_chave_em_producao";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "1234";

// ======================
// Conexão Postgres (Supabase)
// ======================
const shouldUseSSL =
  (process.env.PGSSLMODE && process.env.PGSSLMODE.toLowerCase() === "require") ||
  (DATABASE_URL && DATABASE_URL.includes("supabase.co"));

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: shouldUseSSL ? { rejectUnauthorized: false } : false,
});

// ======================
// Helpers
// ======================
function nowMonth() {
  // formato: YYYY-MM
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function normalizeMonth(mes) {
  // aceita "YYYY-MM" apenas
  if (!mes) return nowMonth();
  const ok = /^\d{4}-\d{2}$/.test(mes);
  if (!ok) return null;
  return mes;
}

function toInt(v, def = 0) {
  if (v === null || v === undefined || v === "") return def;
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.trunc(n);
}

function toText(v, def = "") {
  if (v === null || v === undefined) return def;
  return String(v);
}

// Cria/garante folha do mês para TODOS os funcionários
async function ensureMonthSheets(mes) {
  // Cria as linhas na tabela folhas para cada funcionário (se ainda não existir)
  // Importante: precisa existir constraint UNIQUE (mes, matricula) na tabela folhas
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Insere todos funcionários na folha do mês (se ainda não existir)
    await client.query(
      `
      INSERT INTO folhas (mes, matricula, faltas, faltas_atestado, horas_extras, obs)
      SELECT $1, f.matricula, 0, 0, 0, ''
      FROM funcionarios f
      ON CONFLICT (mes, matricula) DO NOTHING
      `,
      [mes]
    );

    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Middleware JWT
function auth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;

  if (!token) return res.status(401).json({ error: "Sem token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  } catch {
    return res.status(401).json({ error: "Token inválido" });
  }
}

// ======================
// Rotas básicas
// ======================
app.get("/api/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: "DB não conectou", detail: e.message });
  }
});

// Login do Admin
app.post("/api/admin/login", async (req, res) => {
  const { user, password } = req.body || {};

  if (user !== ADMIN_USER || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Usuário ou senha incorretos" });
  }

  const token = jwt.sign({ role: "admin", user }, JWT_SECRET, { expiresIn: "8h" });
  res.json({ ok: true, token });
});

// ======================
// FUNCIONÁRIOS (pesquisa)
// ======================

// Buscar por nome ou matrícula (Folha usa isso)
app.get("/api/funcionarios/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.json({ ok: true, data: [] });

  try {
    // se for número, tenta matrícula exata e também começa com
    const isNum = /^\d+$/.test(q);

    const result = await pool.query(
      `
      SELECT matricula, nome, funcao, vinculo, carga, escola
      FROM funcionarios
      WHERE
        ($1 = true AND (matricula::text = $2 OR matricula::text ILIKE $3))
        OR
        ($1 = false AND nome ILIKE $4)
      ORDER BY nome ASC
      LIMIT 50
      `,
      [
        isNum,
        q,
        `${q}%`,
        `%${q}%`,
      ]
    );

    res.json({ ok: true, data: result.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Pegar 1 funcionário
app.get("/api/funcionarios/:matricula", async (req, res) => {
  const { matricula } = req.params;

  try {
    const r = await pool.query(
      `
      SELECT matricula, nome, funcao, vinculo, carga, escola
      FROM funcionarios
      WHERE matricula::text = $1
      `,
      [String(matricula)]
    );

    if (r.rowCount === 0) return res.status(404).json({ ok: false, error: "Não encontrado" });
    res.json({ ok: true, data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ======================
// FOLHA (lançamento) - sem precisar ser admin
// (Se você quiser proteger também, é só colocar auth aqui.)
// ======================

// Lançar informação no funcionário do mês (soma/incrementa)
// body: { mes, matricula, faltas, faltas_atestado, horas_extras, obs }
// - faltas/faltas_atestado/horas_extras: SOMA no mês
// - obs: se vier, substitui (ou você pode mudar para anexar)
app.post("/api/folha/lancar", async (req, res) => {
  const mes = normalizeMonth(req.body?.mes);
  const matricula = String(req.body?.matricula || "").trim();

  if (!mes) return res.status(400).json({ ok: false, error: "Mês inválido. Use YYYY-MM." });
  if (!matricula) return res.status(400).json({ ok: false, error: "Matrícula obrigatória." });

  const faltas = toInt(req.body?.faltas, 0);
  const faltas_atestado = toInt(req.body?.faltas_atestado, 0);
  const horas_extras = toInt(req.body?.horas_extras, 0);
  const obs = req.body?.obs !== undefined ? toText(req.body?.obs, "") : undefined;

  try {
    // garante que o mês existe pra todo mundo
    await ensureMonthSheets(mes);

    // garante que o funcionário existe
    const fx = await pool.query(
      `SELECT matricula FROM funcionarios WHERE matricula::text = $1`,
      [matricula]
    );
    if (fx.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Matrícula não existe em funcionarios." });
    }

    // Atualiza somando
    if (obs === undefined) {
      await pool.query(
        `
        UPDATE folhas
        SET
          faltas = COALESCE(faltas,0) + $1,
          faltas_atestado = COALESCE(faltas_atestado,0) + $2,
          horas_extras = COALESCE(horas_extras,0) + $3,
          updated_at = NOW()
        WHERE mes = $4 AND matricula::text = $5
        `,
        [faltas, faltas_atestado, horas_extras, mes, matricula]
      );
    } else {
      await pool.query(
        `
        UPDATE folhas
        SET
          faltas = COALESCE(faltas,0) + $1,
          faltas_atestado = COALESCE(faltas_atestado,0) + $2,
          horas_extras = COALESCE(horas_extras,0) + $3,
          obs = $4,
          updated_at = NOW()
        WHERE mes = $5 AND matricula::text = $6
        `,
        [faltas, faltas_atestado, horas_extras, obs, mes, matricula]
      );
    }

    // devolve o registro atualizado (para atualizar no front)
    const r = await pool.query(
      `
      SELECT mes, matricula, faltas, faltas_atestado, horas_extras, obs
      FROM folhas
      WHERE mes = $1 AND matricula::text = $2
      `,
      [mes, matricula]
    );

    res.json({ ok: true, data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ======================
// ADMIN - lista e edita tudo do mês
// ======================

// Lista completa do mês (admin)
app.get("/api/admin/folhas", auth, async (req, res) => {
  const mes = normalizeMonth(req.query?.mes);
  if (!mes) return res.status(400).json({ ok: false, error: "Mês inválido. Use YYYY-MM." });

  try {
    await ensureMonthSheets(mes);

    const r = await pool.query(
      `
      SELECT
        f.matricula,
        f.nome,
        f.funcao,
        f.vinculo,
        f.carga,
        f.escola,
        fl.mes,
        COALESCE(fl.faltas,0) AS faltas,
        COALESCE(fl.faltas_atestado,0) AS faltas_atestado,
        COALESCE(fl.horas_extras,0) AS horas_extras,
        COALESCE(fl.obs,'') AS obs
      FROM funcionarios f
      JOIN folhas fl
        ON fl.matricula = f.matricula AND fl.mes = $1
      ORDER BY f.nome ASC
      `,
      [mes]
    );

    res.json({ ok: true, mes, total: r.rowCount, data: r.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Admin edita (SUBSTITUI) os valores do mês do funcionário
// body: { mes, faltas, faltas_atestado, horas_extras, obs }
app.patch("/api/admin/folhas/:matricula", auth, async (req, res) => {
  const mes = normalizeMonth(req.body?.mes || req.query?.mes);
  const matricula = String(req.params.matricula || "").trim();

  if (!mes) return res.status(400).json({ ok: false, error: "Mês inválido. Use YYYY-MM." });
  if (!matricula) return res.status(400).json({ ok: false, error: "Matrícula obrigatória." });

  const faltas = req.body?.faltas !== undefined ? toInt(req.body.faltas, 0) : undefined;
  const faltas_atestado = req.body?.faltas_atestado !== undefined ? toInt(req.body.faltas_atestado, 0) : undefined;
  const horas_extras = req.body?.horas_extras !== undefined ? toInt(req.body.horas_extras, 0) : undefined;
  const obs = req.body?.obs !== undefined ? toText(req.body.obs, "") : undefined;

  try {
    await ensureMonthSheets(mes);

    // monta update dinâmico
    const sets = [];
    const vals = [];
    let i = 1;

    if (faltas !== undefined) { sets.push(`faltas = $${i++}`); vals.push(faltas); }
    if (faltas_atestado !== undefined) { sets.push(`faltas_atestado = $${i++}`); vals.push(faltas_atestado); }
    if (horas_extras !== undefined) { sets.push(`horas_extras = $${i++}`); vals.push(horas_extras); }
    if (obs !== undefined) { sets.push(`obs = $${i++}`); vals.push(obs); }

    if (sets.length === 0) {
      return res.status(400).json({ ok: false, error: "Nada para atualizar." });
    }

    sets.push(`updated_at = NOW()`);

    vals.push(mes);
    vals.push(matricula);

    const sql = `
      UPDATE folhas
      SET ${sets.join(", ")}
      WHERE mes = $${i++} AND matricula::text = $${i++}
      RETURNING mes, matricula, faltas, faltas_atestado, horas_extras, obs
    `;

    const r = await pool.query(sql, vals);

    if (r.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Registro da folha não encontrado." });
    }

    res.json({ ok: true, data: r.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ======================
// START
// ======================
app.listen(PORT, async () => {
  console.log(`✅ Server rodando na porta ${PORT}`);

  // opcional: garantir mês atual ao iniciar
  try {
    const mes = nowMonth();
    await ensureMonthSheets(mes);
    console.log(`✅ Folhas garantidas para o mês atual: ${mes}`);
  } catch (e) {
    console.log("⚠️ Não consegui garantir folhas no start:", e.message);
  }
});
