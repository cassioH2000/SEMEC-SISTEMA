import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pg from "pg";

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// =========================
// Config
// =========================
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET || "dev_secret";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

if (!DATABASE_URL) {
  console.error("❌ Falta DATABASE_URL no .env");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false },
});

// =========================
// Helpers
// =========================
function signAdminToken() {
  return jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "12h" });
}

function authAdmin(req, res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Token ausente" });

    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || payload.role !== "admin") {
      return res.status(403).json({ error: "Sem permissão" });
    }
    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Token inválido" });
  }
}

function toInt(v, fallback = 0) {
  const n = Number.parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function normMes(m) {
  // aceita 1..12 ou "01".."12"
  const n = toInt(m, 0);
  if (n < 1 || n > 12) return null;
  return n;
}

// =========================
// Criação de tabelas (safe)
// =========================
async function ensureSchema() {
  const sql = `
  CREATE TABLE IF NOT EXISTS funcionarios (
    matricula TEXT PRIMARY KEY,
    nome TEXT NOT NULL DEFAULT '',
    funcao TEXT NOT NULL DEFAULT '',
    vinculo TEXT NOT NULL DEFAULT '',
    carga TEXT NOT NULL DEFAULT '',
    escola TEXT NOT NULL DEFAULT 'SEMEC',
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS folhas (
    id SERIAL PRIMARY KEY,
    matricula TEXT NOT NULL REFERENCES funcionarios(matricula) ON DELETE CASCADE,
    ano INT NOT NULL,
    mes INT NOT NULL,
    faltas INT NOT NULL DEFAULT 0,
    horas_extras NUMERIC(10,2) NOT NULL DEFAULT 0,
    obs TEXT NOT NULL DEFAULT '',
    // campos extras que você já usa na folha podem entrar aqui:
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (matricula, ano, mes)
  );
  `;
  await pool.query(sql);
  console.log("✅ Schema ok");
}

// =========================
// Rotas
// =========================

// health
app.get("/api/health", async (_req, res) => {
  try {
    const r = await pool.query("SELECT 1 as ok");
    res.json({ ok: true, db: r.rows[0].ok === 1 });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// login admin
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "Informe a senha" });

  if (String(password) !== String(ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "Senha inválida" });
  }

  const token = signAdminToken();
  res.json({ token });
});

// listar funcionários (admin)
app.get("/api/admin/funcionarios", authAdmin, async (_req, res) => {
  try {
    const r = await pool.query(
      `SELECT matricula, nome, funcao, vinculo, carga, escola
       FROM funcionarios
       ORDER BY nome ASC`
    );
    res.json({ funcionarios: r.rows });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// editar cadastro do funcionário (admin)
app.put("/api/admin/funcionarios/:matricula", authAdmin, async (req, res) => {
  try {
    const matricula = String(req.params.matricula);
    const { nome, funcao, vinculo, carga, escola } = req.body || {};

    const r = await pool.query(
      `UPDATE funcionarios
       SET nome = COALESCE($2, nome),
           funcao = COALESCE($3, funcao),
           vinculo = COALESCE($4, vinculo),
           carga = COALESCE($5, carga),
           escola = COALESCE($6, escola),
           updated_at = NOW()
       WHERE matricula = $1
       RETURNING matricula, nome, funcao, vinculo, carga, escola`,
      [matricula, nome, funcao, vinculo, carga, escola]
    );

    if (r.rowCount === 0) return res.status(404).json({ error: "Não encontrado" });
    res.json({ funcionario: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Buscar folhas por mês/ano (admin)
app.get("/api/admin/folhas", authAdmin, async (req, res) => {
  try {
    const ano = toInt(req.query.ano, new Date().getFullYear());
    const mes = normMes(req.query.mes);
    if (!mes) return res.status(400).json({ error: "mes inválido (1..12)" });

    const r = await pool.query(
      `SELECT f.id, f.matricula, fu.nome, fu.funcao, fu.vinculo, fu.carga, fu.escola,
              f.ano, f.mes, f.faltas, f.horas_extras, f.obs, f.payload, f.updated_at
       FROM folhas f
       JOIN funcionarios fu ON fu.matricula = f.matricula
       WHERE f.ano = $1 AND f.mes = $2
       ORDER BY fu.nome ASC`,
      [ano, mes]
    );

    res.json({ folhas: r.rows, ano, mes });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// Admin: editar faltas/horas_extras/obs (por matricula/mes/ano)
app.put("/api/admin/folhas/:matricula", authAdmin, async (req, res) => {
  try {
    const matricula = String(req.params.matricula);
    const ano = toInt(req.body?.ano, new Date().getFullYear());
    const mes = normMes(req.body?.mes);
    if (!mes) return res.status(400).json({ error: "mes inválido (1..12)" });

    const faltas = req.body?.faltas;
    const horas_extras = req.body?.horas_extras;
    const obs = req.body?.obs;

    // garante que a folha existe (se não existir, cria zerada)
    await pool.query(
      `INSERT INTO folhas (matricula, ano, mes)
       VALUES ($1, $2, $3)
       ON CONFLICT (matricula, ano, mes) DO NOTHING`,
      [matricula, ano, mes]
    );

    const r = await pool.query(
      `UPDATE folhas
       SET faltas = COALESCE($4, faltas),
           horas_extras = COALESCE($5, horas_extras),
           obs = COALESCE($6, obs),
           updated_at = NOW()
       WHERE matricula = $1 AND ano = $2 AND mes = $3
       RETURNING id, matricula, ano, mes, faltas, horas_extras, obs, payload, updated_at`,
      [matricula, ano, mes, faltas, horas_extras, obs]
    );

    res.json({ folha: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// =========================
// Folha (página de folha) -> salvar/atualizar dados do funcionário do mês
// =========================
// esperado:
// {
//   matricula: "358",
//   ano: 2026,
//   mes: 2,
//   faltas: 0,
//   horas_extras: 5.5,
//   obs: "....",
//   payload: { qualquer_coisa_da_folha: ... }
// }
app.post("/api/folha/upsert", async (req, res) => {
  try {
    const { matricula, ano, mes, faltas, horas_extras, obs, payload } = req.body || {};
    if (!matricula) return res.status(400).json({ error: "matricula obrigatória" });

    const A = toInt(ano, new Date().getFullYear());
    const M = normMes(mes);
    if (!M) return res.status(400).json({ error: "mes inválido (1..12)" });

    // garante funcionário existente (se não existir, cria com padrão SEMEC e campos vazios)
    await pool.query(
      `INSERT INTO funcionarios (matricula, nome, funcao, vinculo, carga, escola)
       VALUES ($1, '', '', '', '', 'SEMEC')
       ON CONFLICT (matricula) DO NOTHING`,
      [String(matricula)]
    );

    const r = await pool.query(
      `INSERT INTO folhas (matricula, ano, mes, faltas, horas_extras, obs, payload, updated_at)
       VALUES ($1, $2, $3, COALESCE($4,0), COALESCE($5,0), COALESCE($6,''), COALESCE($7,'{}'::jsonb), NOW())
       ON CONFLICT (matricula, ano, mes)
       DO UPDATE SET
         faltas = COALESCE(EXCLUDED.faltas, folhas.faltas),
         horas_extras = COALESCE(EXCLUDED.horas_extras, folhas.horas_extras),
         obs = COALESCE(EXCLUDED.obs, folhas.obs),
         payload = COALESCE(EXCLUDED.payload, folhas.payload),
         updated_at = NOW()
       RETURNING id, matricula, ano, mes, faltas, horas_extras, obs, payload, updated_at`,
      [
        String(matricula),
        A,
        M,
        faltas ?? 0,
        horas_extras ?? 0,
        obs ?? "",
        payload ? JSON.stringify(payload) : JSON.stringify({}),
      ]
    );

    res.json({ ok: true, folha: r.rows[0] });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

// =========================
// Start
// =========================
ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log(`✅ API rodando em http://localhost:${PORT}`));
  })
  .catch((e) => {
    console.error("❌ Erro no schema:", e);
    process.exit(1);
  });
