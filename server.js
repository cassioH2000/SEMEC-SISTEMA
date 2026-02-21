// server.js (ESM) - SEMEC Sistema
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pg from "pg";
import dns from "dns";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ====== STATIC (public/) ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// ====== ENV ======
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const JWT_SECRET = process.env.JWT_SECRET || "";

if (!DATABASE_URL) console.warn("⚠️ DATABASE_URL não definida no Render.");
if (!ADMIN_PASSWORD) console.warn("⚠️ ADMIN_PASSWORD não definida no Render.");
if (!JWT_SECRET) console.warn("⚠️ JWT_SECRET não definida no Render.");

// ====== HELPERS ======
function sendErr(res, status, msg, details) {
  return res.status(status).json({ ok: false, error: msg, details });
}

function signAdminToken() {
  return jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "7d" });
}

function requireAdmin(req, res, next) {
  try {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return sendErr(res, 401, "Token ausente");
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload?.role !== "admin") return sendErr(res, 403, "Sem permissão");
    req.user = payload;
    next();
  } catch (e) {
    return sendErr(res, 401, "Token inválido ou expirado");
  }
}

// ====== FORCE IPV4 POOL ======
// Isso resolve o host do DATABASE_URL em IPv4 e usa hostaddr (ignora IPv6)
async function createPoolForSupabaseIPv4(databaseUrl) {
  // força ordem ipv4 no node
  dns.setDefaultResultOrder?.("ipv4first");

  const u = new URL(databaseUrl);

  const host = u.hostname; // db.xxxxx.supabase.co
  let ipv4 = null;

  try {
    const addrs = await dns.promises.resolve4(host);
    ipv4 = addrs?.[0] || null;
  } catch (e) {
    console.warn("⚠️ Não consegui resolver IPv4 do host:", host, e?.message);
  }

  const config = {
    // Se temos ipv4, usamos hostaddr e mantemos host como nome (SNI/cert)
    host: host,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace("/", "") || "postgres",
    port: Number(u.port || 5432),
    ssl: { rejectUnauthorized: false }, // evita problemas de certificado em alguns ambientes
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  };

  // hostaddr é suportado pelo libpq, o pg passa options pro driver
  // No node-postgres, a forma mais segura é "options" com -c, MAS aqui usamos workaround:
  // Se ipv4 existir, conectamos diretamente pelo IPv4 no "host" (e ignoramos o nome).
  // Mantemos o SNI via sslServername quando possível.
  if (ipv4) {
    config.host = ipv4; // conecta pelo IPv4
    config.ssl = { rejectUnauthorized: false, servername: host }; // SNI para o certificado
    console.log("✅ DB via IPv4:", ipv4, "(SNI:", host + ")");
  } else {
    console.log("⚠️ DB sem IPv4 fixo, tentando host normal:", host);
  }

  return new Pool(config);
}

const pool = await createPoolForSupabaseIPv4(DATABASE_URL);

// ====== DB SCHEMA ======
async function ensureSchema() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Funcionários
    await client.query(`
      CREATE TABLE IF NOT EXISTS funcionarios (
        matricula TEXT PRIMARY KEY,
        nome TEXT DEFAULT '',
        funcao TEXT DEFAULT '',
        vinculo TEXT DEFAULT '',
        carga TEXT DEFAULT '',
        escola TEXT DEFAULT '',
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Folhas por mês (um registro por funcionário por período)
    await client.query(`
      CREATE TABLE IF NOT EXISTS folhas (
        id BIGSERIAL PRIMARY KEY,
        matricula TEXT NOT NULL REFERENCES funcionarios(matricula) ON DELETE CASCADE,
        periodo TEXT NOT NULL, -- formato 'YYYY-MM'
        dados JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (matricula, periodo)
      );
    `);

    await client.query("COMMIT");
    console.log("✅ Schema OK");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ Erro ensureSchema:", e);
    throw e;
  } finally {
    client.release();
  }
}

// Não derruba o servidor se schema falhar, mas loga
ensureSchema().catch((e) => console.error("⚠️ Falha ao preparar schema:", e?.message));

// ====== ROUTES ======
app.get("/api/health", async (req, res) => {
  try {
    const r = await pool.query("SELECT 1 AS ok");
    res.json({ ok: true, db: r?.rows?.[0]?.ok === 1 ? "up" : "unknown" });
  } catch (e) {
    res.status(500).json({ ok: false, db: "down", error: e?.message });
  }
});

// LOGIN ADMIN
app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (!JWT_SECRET) return sendErr(res, 500, "JWT_SECRET não configurado no servidor");
  if (!ADMIN_PASSWORD) return sendErr(res, 500, "ADMIN_PASSWORD não configurado no servidor");
  if (!password) return sendErr(res, 400, "Senha ausente");

  if (String(password) !== String(ADMIN_PASSWORD)) {
    return sendErr(res, 401, "Senha inválida");
  }

  const token = signAdminToken();
  res.json({ ok: true, token });
});

// ====== FOLHA: enviar/atualizar dados ======
// Envie: { periodo: "2026-02", funcionario: {matricula,nome,funcao,vinculo,carga,escola}, folha: {...} }
app.post("/api/folha/enviar", async (req, res) => {
  const body = req.body || {};
  const periodo = String(body.periodo || "").trim(); // 'YYYY-MM'
  const func = body.funcionario || {};
  const folha = body.folha || {};

  const matricula = String(func.matricula || "").trim();

  if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
    return sendErr(res, 400, "Período inválido. Use 'YYYY-MM' (ex: 2026-02)");
  }
  if (!matricula) return sendErr(res, 400, "Matrícula obrigatória");

  const nome = String(func.nome || "");
  const funcao = String(func.funcao || "");
  const vinculo = String(func.vinculo || "");
  const carga = String(func.carga || "");
  const escola = String(func.escola || "");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) upsert funcionario (sempre atualiza quando recebe algo da folha)
    await client.query(
      `
      INSERT INTO funcionarios (matricula, nome, funcao, vinculo, carga, escola, atualizado_em)
      VALUES ($1,$2,$3,$4,$5,$6,NOW())
      ON CONFLICT (matricula) DO UPDATE SET
        nome = COALESCE(NULLIF(EXCLUDED.nome,''), funcionarios.nome),
        funcao = COALESCE(NULLIF(EXCLUDED.funcao,''), funcionarios.funcao),
        vinculo = COALESCE(NULLIF(EXCLUDED.vinculo,''), funcionarios.vinculo),
        carga = COALESCE(NULLIF(EXCLUDED.carga,''), funcionarios.carga),
        escola = COALESCE(NULLIF(EXCLUDED.escola,''), funcionarios.escola),
        atualizado_em = NOW()
      `,
      [matricula, nome, funcao, vinculo, carga, escola]
    );

    // 2) upsert folha do mês
    await client.query(
      `
      INSERT INTO folhas (matricula, periodo, dados, updated_at)
      VALUES ($1,$2,$3::jsonb,NOW())
      ON CONFLICT (matricula, periodo) DO UPDATE SET
        dados = EXCLUDED.dados,
        updated_at = NOW()
      `,
      [matricula, periodo, JSON.stringify(folha || {})]
    );

    await client.query("COMMIT");
    return res.json({ ok: true, matricula, periodo });
  } catch (e) {
    await client.query("ROLLBACK");
    return sendErr(res, 500, "Erro ao salvar folha", e?.message);
  } finally {
    client.release();
  }
});

// ====== ADMIN: resumo do mês ======
// GET /api/admin/mes?periodo=2026-02&escola=...
app.get("/api/admin/mes", requireAdmin, async (req, res) => {
  const periodo = String(req.query.periodo || "").trim();
  const escola = String(req.query.escola || "").trim();

  if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
    return sendErr(res, 400, "Período inválido. Use 'YYYY-MM'");
  }

  try {
    // Lista de registros do mês (com filtro opcional por escola)
    const params = [periodo];
    let where = `f.periodo = $1`;
    if (escola && escola !== "Todas as escolas") {
      params.push(escola);
      where += ` AND COALESCE(func.escola,'') = $2`;
    }

    const list = await pool.query(
      `
      SELECT
        f.matricula,
        func.nome,
        func.funcao,
        func.vinculo,
        func.carga,
        func.escola,
        f.periodo,
        f.dados,
        f.updated_at
      FROM folhas f
      JOIN funcionarios func ON func.matricula = f.matricula
      WHERE ${where}
      ORDER BY func.escola ASC, func.nome ASC
      `,
      params
    );

    // Resumo
    const totalEnvios = list.rowCount;

    // tenta somar horas_extras se existir dentro do JSON (horas_extras ou horasExtras)
    let somaHorasExtras = 0;
    for (const r of list.rows) {
      const d = r.dados || {};
      const v = Number(d.horas_extras ?? d.horasExtras ?? 0);
      if (!Number.isNaN(v)) somaHorasExtras += v;
    }

    res.json({
      ok: true,
      periodo,
      escola: escola || "Todas as escolas",
      resumo: {
        total_envios: totalEnvios,
        horas_extras_soma: somaHorasExtras,
      },
      registros: list.rows,
    });
  } catch (e) {
    return sendErr(res, 500, "Erro ao consultar mês", e?.message);
  }
});

// ====== ADMIN: listar funcionários (para aparecerem sempre no admin) ======
// GET /api/admin/funcionarios
app.get("/api/admin/funcionarios", requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `
      SELECT matricula, nome, funcao, vinculo, carga, escola, atualizado_em
      FROM funcionarios
      ORDER BY escola ASC, nome ASC
      `
    );
    res.json({ ok: true, funcionarios: r.rows });
  } catch (e) {
    return sendErr(res, 500, "Erro ao listar funcionários", e?.message);
  }
});

// Fallback SPA simples: se abrir /admin.html etc já é servido pelo static.
// Se quiser, mantém raiz abrindo index.html:
app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.listen(PORT, () => {
  console.log("✅ Servidor rodando na porta", PORT);
  console.log("📁 Public dir:", PUBLIC_DIR);
});
