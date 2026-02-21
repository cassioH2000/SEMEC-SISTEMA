// server.js (ESM) - SEMEC Sistema
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

// ========================
// Config / Helpers
// ========================
const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cors({ origin: true, credentials: true }));

const PORT = process.env.PORT || 10000;

// Render: serve arquivos estáticos (coloque seus html/css/js em /public)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// Health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ========================
// ENV Obrigatórias
// ========================
const {
  DATABASE_URL,
  ADMIN_PASSWORD,
  JWT_SECRET,
} = process.env;

if (!JWT_SECRET) {
  console.warn("⚠️ JWT_SECRET não definido. Defina no Render (Environment).");
}
if (!ADMIN_PASSWORD) {
  console.warn("⚠️ ADMIN_PASSWORD não definido. Defina no Render (Environment).");
}
if (!DATABASE_URL) {
  console.warn("⚠️ DATABASE_URL não definido. Defina no Render (Environment).");
}

// ========================
// Postgres (pg)
// ========================
const { Pool } = pg;

// Observação importante:
// - Para Supabase direct connection (5432), use ssl: { rejectUnauthorized: false }.
// - Isso evita o erro de certificado. (no Supabase costuma ser necessário)
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : undefined,
});

// Cria schema/tabelas (se ainda não existir)
async function ensureSchema() {
  if (!DATABASE_URL) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS funcionarios (
      matricula TEXT PRIMARY KEY,
      nome TEXT,
      funcao TEXT,
      vinculo TEXT,
      carga TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS envios (
      id BIGSERIAL PRIMARY KEY,
      periodo TEXT NOT NULL,             -- ex: 2026-02
      matricula TEXT NOT NULL,
      escola TEXT,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (periodo, matricula)
    );
  `);

  // Index para filtros
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_envios_periodo ON envios(periodo);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_envios_escola ON envios(escola);`);

  console.log("✅ Banco preparado (schema ok).");
}

// Faz bootstrap sem derrubar o servidor se falhar
ensureSchema().catch((err) => {
  console.error("❌ Falha ao preparar o banco (ensureSchema):", err?.message || err);
});

// ========================
// Auth (JWT)
// ========================
function signAdminToken() {
  const secret = JWT_SECRET || "dev-secret-change-me";
  return jwt.sign({ role: "admin" }, secret, { expiresIn: "12h" });
}

function requireAdmin(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Sem token" });

    const secret = JWT_SECRET || "dev-secret-change-me";
    const decoded = jwt.verify(token, secret);
    if (decoded?.role !== "admin") return res.status(403).json({ error: "Acesso negado" });

    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Token inválido" });
  }
}

// ========================
// Rotas API
// ========================

// Login admin
app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: "Informe a senha" });

  // ADMIN_PASSWORD é a senha que você define no Render
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Senha inválida" });
  }

  const token = signAdminToken();
  return res.json({ token });
});

// Lista funcionários (admin)
app.get("/api/funcionarios", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT matricula, nome, funcao, vinculo, carga
       FROM funcionarios
       ORDER BY nome ASC NULLS LAST`
    );
    res.json({ funcionarios: r.rows });
  } catch (e) {
    res.status(500).json({ error: "Erro ao listar funcionarios" });
  }
});

// Upsert funcionário (admin) - (para manter cadastro atualizado)
app.post("/api/funcionarios", requireAdmin, async (req, res) => {
  try {
    const { matricula, nome, funcao, vinculo, carga } = req.body || {};
    if (!matricula) return res.status(400).json({ error: "matricula é obrigatória" });

    await pool.query(
      `INSERT INTO funcionarios (matricula, nome, funcao, vinculo, carga)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (matricula) DO UPDATE SET
         nome = EXCLUDED.nome,
         funcao = EXCLUDED.funcao,
         vinculo = EXCLUDED.vinculo,
         carga = EXCLUDED.carga`,
      [matricula, nome || "", funcao || "", vinculo || "", carga || ""]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erro ao salvar funcionario" });
  }
});

// Envio da folha (página folha -> servidor)
// Salva/atualiza por (periodo, matricula)
app.post("/api/folha/enviar", async (req, res) => {
  try {
    const { periodo, matricula, escola, payload } = req.body || {};
    if (!periodo || !matricula || !payload) {
      return res.status(400).json({ error: "periodo, matricula e payload são obrigatórios" });
    }

    // se o funcionario não existir, cria um registro básico
    await pool.query(
      `INSERT INTO funcionarios (matricula, nome, funcao, vinculo, carga)
       VALUES ($1,'','','','')
       ON CONFLICT (matricula) DO NOTHING`,
      [String(matricula)]
    );

    await pool.query(
      `INSERT INTO envios (periodo, matricula, escola, payload, updated_at)
       VALUES ($1,$2,$3,$4, NOW())
       ON CONFLICT (periodo, matricula) DO UPDATE SET
         escola = EXCLUDED.escola,
         payload = EXCLUDED.payload,
         updated_at = NOW()`,
      [String(periodo), String(matricula), escola || "", payload]
    );

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: "Erro ao enviar folha" });
  }
});

// Admin: resumo do mês (total envios / horas extras etc. se tiver no payload)
app.get("/api/admin/mes", requireAdmin, async (req, res) => {
  try {
    const { periodo, escola } = req.query || {};
    if (!periodo) return res.status(400).json({ error: "periodo é obrigatório (ex: 2026-02)" });

    const params = [String(periodo)];
    let where = `WHERE e.periodo = $1`;

    if (escola && escola !== "Todas" && escola !== "todas" && escola !== "Todas as escolas") {
      params.push(String(escola));
      where += ` AND e.escola = $${params.length}`;
    }

    const r = await pool.query(
      `SELECT
         e.periodo,
         e.matricula,
         e.escola,
         e.payload,
         e.updated_at,
         f.nome,
         f.funcao,
         f.vinculo,
         f.carga
       FROM envios e
       LEFT JOIN funcionarios f ON f.matricula = e.matricula
       ${where}
       ORDER BY f.nome ASC NULLS LAST, e.updated_at DESC`,
      params
    );

    // total de envios
    const totalEnvios = r.rows.length;

    // exemplo: somar horas extras se existir payload.horasExtras (numero)
    let somaHorasExtras = 0;
    for (const row of r.rows) {
      const he = Number(row?.payload?.horasExtras || 0);
      if (!Number.isNaN(he)) somaHorasExtras += he;
    }

    res.json({
      periodo: String(periodo),
      totalEnvios,
      somaHorasExtras,
      registros: r.rows,
    });
  } catch (e) {
    // Se a rota não existir no seu server antigo, você via 404 no admin
    res.status(500).json({ error: "Erro ao buscar dados do mês" });
  }
});

// Admin: lista funcionários + status no mês (mesmo sem envio)
app.get("/api/admin/funcionarios-mes", requireAdmin, async (req, res) => {
  try {
    const { periodo } = req.query || {};
    if (!periodo) return res.status(400).json({ error: "periodo é obrigatório (ex: 2026-02)" });

    const r = await pool.query(
      `SELECT
         f.matricula, f.nome, f.funcao, f.vinculo, f.carga,
         e.updated_at,
         (e.matricula IS NOT NULL) AS enviado,
         e.escola,
         e.payload
       FROM funcionarios f
       LEFT JOIN envios e
         ON e.matricula = f.matricula
        AND e.periodo = $1
       ORDER BY f.nome ASC NULLS LAST`,
      [String(periodo)]
    );

    res.json({ periodo: String(periodo), funcionarios: r.rows });
  } catch (e) {
    res.status(500).json({ error: "Erro ao buscar funcionarios do mês" });
  }
});

// Fallback: abre index.html
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(PORT, () => {
  console.log("🟩 Iniciando servidor...");
  console.log("📁 Public dir:", publicDir);
  console.log(`🚀 Servidor rodando na porta ${PORT}`);
});
