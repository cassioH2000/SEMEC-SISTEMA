import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pkg from "pg";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

/**
 * =========================
 * CONFIG
 * =========================
 * Você precisa configurar essas variáveis no seu .env / hosting:
 *
 * DATABASE_URL = string do Postgres (Supabase/Render/Neon/etc)
 * JWT_SECRET   = segredo do token (ex: "minha_chave_super_secreta_123")
 * ADMIN_USER   = (opcional) usuario do admin (default "admin")
 * ADMIN_PASSWORD = senha do admin (ex: "33362526Ca..")
 */

const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123"; // troque no ENV
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_NOW";

if (!process.env.DATABASE_URL) {
  console.warn("⚠️ ATENÇÃO: DATABASE_URL não está definida!");
}

// SSL para Supabase/host externo
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("supabase.co")
    ? { rejectUnauthorized: false }
    : (process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined),
});

/**
 * =========================
 * HELPERS
 * =========================
 */
function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "7d" });
}

function authAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ ok: false, error: "Token ausente" });

    const decoded = jwt.verify(token, JWT_SECRET);
    if (!decoded?.role || decoded.role !== "admin") {
      return res.status(403).json({ ok: false, error: "Sem permissão" });
    }
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ ok: false, error: "Token inválido/expirado" });
  }
}

/**
 * =========================
 * TEST DB
 * =========================
 */
app.get("/api/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT NOW() as now");
    res.json({ ok: true, db: true, now: r.rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
});

/**
 * =========================
 * AUTH
 * =========================
 */
app.post("/api/login", (req, res) => {
  const { usuario, senha } = req.body || {};

  if (usuario === ADMIN_USER && senha === ADMIN_PASSWORD) {
    const token = signToken({ role: "admin", usuario });
    return res.json({ ok: true, role: "admin", token });
  }

  return res.status(401).json({ ok: false, error: "Usuário ou senha inválidos" });
});

/**
 * =========================
 * FUNCIONÁRIOS
 * Tabela esperada: funcionarios
 * Colunas recomendadas:
 * - matricula (PK ou UNIQUE)
 * - nome, funcao, vinculo, carga, escola
 * - faltas (INTEGER), horas_extras (INTEGER), obs (TEXT)
 * =========================
 */

/**
 * Listar funcionários (admin)
 * Query params opcionais:
 * - q: busca por nome/matricula
 */
app.get("/api/funcionarios", authAdmin, async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();

    if (q) {
      const result = await pool.query(
        `
        SELECT matricula, nome, funcao, vinculo, carga, escola, faltas, horas_extras, obs
        FROM funcionarios
        WHERE
          CAST(matricula AS TEXT) ILIKE $1
          OR nome ILIKE $1
        ORDER BY nome ASC
        `,
        [`%${q}%`]
      );
      return res.json({ ok: true, funcionarios: result.rows });
    }

    const result = await pool.query(
      `
      SELECT matricula, nome, funcao, vinculo, carga, escola, faltas, horas_extras, obs
      FROM funcionarios
      ORDER BY nome ASC
      `
    );

    res.json({ ok: true, funcionarios: result.rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Criar/Atualizar funcionário por matrícula (admin)
 * - Se já existir matrícula, atualiza (UPSERT)
 */
app.post("/api/funcionarios", authAdmin, async (req, res) => {
  try {
    const {
      matricula,
      nome = "",
      funcao = "",
      vinculo = "",
      carga = "",
      escola = "SEMEC",
      faltas = 0,
      horas_extras = 0,
      obs = "",
    } = req.body || {};

    if (!matricula) {
      return res.status(400).json({ ok: false, error: "matricula é obrigatória" });
    }

    const result = await pool.query(
      `
      INSERT INTO funcionarios (matricula, nome, funcao, vinculo, carga, escola, faltas, horas_extras, obs)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (matricula)
      DO UPDATE SET
        nome = EXCLUDED.nome,
        funcao = EXCLUDED.funcao,
        vinculo = EXCLUDED.vinculo,
        carga = EXCLUDED.carga,
        escola = EXCLUDED.escola,
        faltas = EXCLUDED.faltas,
        horas_extras = EXCLUDED.horas_extras,
        obs = EXCLUDED.obs
      RETURNING matricula, nome, funcao, vinculo, carga, escola, faltas, horas_extras, obs
      `,
      [matricula, nome, funcao, vinculo, carga, escola, faltas, horas_extras, obs]
    );

    res.json({ ok: true, funcionario: result.rows[0] });
  } catch (e) {
    // se sua tabela não tiver UNIQUE/PK em matricula, vai falhar no ON CONFLICT
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Atualizar SOMENTE faltas/horas_extras/obs (admin)
 */
app.put("/api/funcionarios/:matricula/ponto", authAdmin, async (req, res) => {
  try {
    const { matricula } = req.params;
    const { faltas, horas_extras, obs } = req.body || {};

    const result = await pool.query(
      `
      UPDATE funcionarios
      SET
        faltas = COALESCE($2, faltas),
        horas_extras = COALESCE($3, horas_extras),
        obs = COALESCE($4, obs)
      WHERE matricula = $1
      RETURNING matricula, nome, funcao, vinculo, carga, escola, faltas, horas_extras, obs
      `,
      [matricula, faltas ?? null, horas_extras ?? null, obs ?? null]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Funcionário não encontrado" });
    }

    res.json({ ok: true, funcionario: result.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * Atualizar dados gerais do funcionário (admin)
 */
app.put("/api/funcionarios/:matricula", authAdmin, async (req, res) => {
  try {
    const { matricula } = req.params;
    const {
      nome,
      funcao,
      vinculo,
      carga,
      escola,
      faltas,
      horas_extras,
      obs,
    } = req.body || {};

    const result = await pool.query(
      `
      UPDATE funcionarios
      SET
        nome = COALESCE($2, nome),
        funcao = COALESCE($3, funcao),
        vinculo = COALESCE($4, vinculo),
        carga = COALESCE($5, carga),
        escola = COALESCE($6, escola),
        faltas = COALESCE($7, faltas),
        horas_extras = COALESCE($8, horas_extras),
        obs = COALESCE($9, obs)
      WHERE matricula = $1
      RETURNING matricula, nome, funcao, vinculo, carga, escola, faltas, horas_extras, obs
      `,
      [
        matricula,
        nome ?? null,
        funcao ?? null,
        vinculo ?? null,
        carga ?? null,
        escola ?? null,
        faltas ?? null,
        horas_extras ?? null,
        obs ?? null,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "Funcionário não encontrado" });
    }

    res.json({ ok: true, funcionario: result.rows[0] });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * =========================
 * START
 * =========================
 */
app.listen(PORT, () => {
  console.log(`✅ API rodando na porta ${PORT}`);
});
