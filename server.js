require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

// Ajuste se seus html estão na pasta "public"
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// =========================
// Helpers
// =========================
function getAdminPasswordFromReq(req) {
  // aceita de vários jeitos para compatibilidade com seu admin.html
  return (
    req.headers["x-admin-password"] ||
    req.headers["x-admin-senha"] ||
    (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, "") : "") ||
    (req.body && (req.body.senha || req.body.password)) ||
    (req.query && (req.query.senha || req.query.password)) ||
    ""
  );
}

function requireAdmin(req, res, next) {
  const senha = getAdminPasswordFromReq(req);
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ erro: "ADMIN_PASSWORD não configurada no servidor" });
  }
  if (senha !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ erro: "Não autorizado" });
  }
  next();
}

async function criarTabelas() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funcionarios (
      matricula VARCHAR(20) PRIMARY KEY,
      nome TEXT NOT NULL,
      funcao TEXT DEFAULT ''
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS folhas (
      id SERIAL PRIMARY KEY,
      matricula VARCHAR(20) NOT NULL REFERENCES funcionarios(matricula) ON DELETE CASCADE,
      mes VARCHAR(30) NOT NULL,
      faltas INTEGER DEFAULT 0,
      atestados INTEGER DEFAULT 0,
      horas_extras INTEGER DEFAULT 0,
      observacoes TEXT DEFAULT '',
      UNIQUE (matricula, mes)
    )
  `);

  console.log("✅ Tabelas prontas/checadas");
}

criarTabelas().catch((e) => console.error("Erro criando tabelas:", e));

// =========================
// Rota de teste
// =========================
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, erro: "DB offline", detalhe: String(e) });
  }
});

// =========================
// ROTAS PÚBLICAS (Folha)
// =========================

// Lista funcionários
app.get("/api/funcionarios", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM funcionarios ORDER BY nome ASC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao buscar funcionários" });
  }
});

// Carrega folha do mês (pública)
app.get("/api/folhas/:mes", async (req, res) => {
  const mes = req.params.mes;

  try {
    const result = await pool.query(
      `
      SELECT
        f.matricula, f.nome, f.funcao,
        COALESCE(fl.faltas, 0)      AS faltas,
        COALESCE(fl.atestados, 0)  AS atestados,
        COALESCE(fl.horas_extras,0) AS horas_extras,
        COALESCE(fl.observacoes,'') AS observacoes
      FROM funcionarios f
      LEFT JOIN folhas fl
        ON f.matricula = fl.matricula AND fl.mes = $1
      ORDER BY f.nome ASC
      `,
      [mes]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao carregar folha" });
  }
});

// Salvar/atualizar folha (pública) – usada pela página Folha
app.post("/api/folhas", async (req, res) => {
  const { matricula, mes } = req.body;
  const faltas = Number(req.body.faltas ?? 0);
  const atestados = Number(req.body.atestados ?? 0);
  const horas_extras = Number(req.body.horas_extras ?? 0);
  const observacoes = String(req.body.observacoes ?? "");

  if (!matricula || !mes) {
    return res.status(400).json({ erro: "matricula e mes são obrigatórios" });
  }

  try {
    await pool.query(
      `
      INSERT INTO folhas (matricula, mes, faltas, atestados, horas_extras, observacoes)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (matricula, mes)
      DO UPDATE SET
        faltas = EXCLUDED.faltas,
        atestados = EXCLUDED.atestados,
        horas_extras = EXCLUDED.horas_extras,
        observacoes = EXCLUDED.observacoes
      `,
      [matricula, mes, faltas, atestados, horas_extras, observacoes]
    );

    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao salvar folha" });
  }
});

// =========================
// ROTAS ADMIN (com senha)
// Prefixo que seu admin.html espera: /api/admin
// =========================

// Login admin (compatível com /api/admin/login)
app.post("/api/admin/login", (req, res) => {
  const senha = getAdminPasswordFromReq(req);
  if (senha === process.env.ADMIN_PASSWORD) return res.json({ sucesso: true });
  return res.status(401).json({ erro: "Senha incorreta" });
});

// (Opcional) espelho do login antigo, caso algum arquivo use /api/login
app.post("/api/login", (req, res) => {
  const senha = getAdminPasswordFromReq(req);
  if (senha === process.env.ADMIN_PASSWORD) return res.json({ sucesso: true });
  return res.status(401).json({ erro: "Senha incorreta" });
});

// Admin: listar funcionários
app.get("/api/admin/funcionarios", requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM funcionarios ORDER BY nome ASC");
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao buscar funcionários (admin)" });
  }
});

// Admin: carregar folha do mês (para editar na tabela do admin)
app.get("/api/admin/folhas/:mes", requireAdmin, async (req, res) => {
  const mes = req.params.mes;

  try {
    const result = await pool.query(
      `
      SELECT
        f.matricula, f.nome, f.funcao,
        COALESCE(fl.faltas, 0)      AS faltas,
        COALESCE(fl.atestados, 0)  AS atestados,
        COALESCE(fl.horas_extras,0) AS horas_extras,
        COALESCE(fl.observacoes,'') AS observacoes
      FROM funcionarios f
      LEFT JOIN folhas fl
        ON f.matricula = fl.matricula AND fl.mes = $1
      ORDER BY f.nome ASC
      `,
      [mes]
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao carregar folhas (admin)" });
  }
});

// Admin: salvar/atualizar linha da folha (admin também pode editar tudo)
app.post("/api/admin/folhas", requireAdmin, async (req, res) => {
  const { matricula, mes } = req.body;
  const faltas = Number(req.body.faltas ?? 0);
  const atestados = Number(req.body.atestados ?? 0);
  const horas_extras = Number(req.body.horas_extras ?? 0);
  const observacoes = String(req.body.observacoes ?? "");

  if (!matricula || !mes) {
    return res.status(400).json({ erro: "matricula e mes são obrigatórios" });
  }

  try {
    await pool.query(
      `
      INSERT INTO folhas (matricula, mes, faltas, atestados, horas_extras, observacoes)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (matricula, mes)
      DO UPDATE SET
        faltas = EXCLUDED.faltas,
        atestados = EXCLUDED.atestados,
        horas_extras = EXCLUDED.horas_extras,
        observacoes = EXCLUDED.observacoes
      `,
      [matricula, mes, faltas, atestados, horas_extras, observacoes]
    );

    res.json({ sucesso: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: "Erro ao salvar (admin)" });
  }
});

// =========================
// Páginas (opcional)
// =========================
// Se quiser garantir que / abre index.html:
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// =========================
// Start
// =========================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("✅ Servidor SEMEC rodando na porta " + PORT));
