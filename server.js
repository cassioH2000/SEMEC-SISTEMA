/**
 * server.js — SEMEC SISTEMA (Render + Supabase)
 * Requisitos:
 * - Node 18+ (Render)
 * - Variáveis no Render:
 *   DATABASE_URL = postgresql://...pooler.supabase.com:6543/postgres?sslmode=require
 *   ADMIN_PASSWORD = semec2026   (ou sua senha)
 *   JWT_SECRET = uma_string_grande_aleatoria
 *
 * Estrutura esperada:
 * /public
 *   index.html
 *   folha.html
 *   admin.html
 *   logo.png (opcional)
 */

import express from "express";
import pg from "pg";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ========= Config =========
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const JWT_SECRET = process.env.JWT_SECRET || "";

if (!DATABASE_URL) console.warn("⚠️ DATABASE_URL não configurado no Render.");
if (!ADMIN_PASSWORD) console.warn("⚠️ ADMIN_PASSWORD não configurado no Render.");
if (!JWT_SECRET) console.warn("⚠️ JWT_SECRET não configurado no Render.");

const pool = new Pool({
  connectionString: DATABASE_URL,
  // Supabase costuma exigir SSL em produção
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000,
});

// ====== (Opcional) proteção contra PREPARE no pooler ======
// O "transaction pooler" não gosta de queries com "name" (prepared statements).
// Aqui removemos "name" se alguém acidentalmente passar query config.
pool.on("connect", (client) => {
  const origQuery = client.query.bind(client);
  client.query = (text, params, cb) => {
    if (typeof text === "object" && text !== null) {
      const { name, ...rest } = text; // remove prepared name
      return origQuery(rest, params, cb);
    }
    return origQuery(text, params, cb);
  };
});

// ========= Static (public) =========
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// ========= Helpers =========
function ok(res, payload = {}) {
  res.json({ ok: true, ...payload });
}
function bad(res, message = "Erro", status = 400, extra = {}) {
  res.status(status).json({ ok: false, message, ...extra });
}

function normalizePeriodo(p) {
  // Aceita "2026-02"
  if (!p) return null;
  const s = String(p).trim();
  if (!/^\d{4}-\d{2}$/.test(s)) return null;
  return s;
}

function toInt(n, def = 0) {
  const v = Number(n);
  if (!Number.isFinite(v)) return def;
  return Math.trunc(v);
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return bad(res, "Sem token.", 401);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (e) {
    return bad(res, "Token inválido.", 401);
  }
}

// ========= Schema =========
async function ensureSchema() {
  // Tabelas:
  // funcionarios: cadastro mestre (matricula, nome, funcao, vinculo, carga)
  // registros: envios por escola/mês/funcionário (upsert por periodo+escola+matricula)
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS funcionarios (
        matricula TEXT PRIMARY KEY,
        nome TEXT NOT NULL DEFAULT '',
        funcao TEXT NOT NULL DEFAULT '',
        vinculo TEXT NOT NULL DEFAULT '',
        carga TEXT NOT NULL DEFAULT ''
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS registros (
        id BIGSERIAL PRIMARY KEY,
        escola TEXT NOT NULL DEFAULT '',
        periodo TEXT NOT NULL, -- YYYY-MM
        matricula TEXT NOT NULL REFERENCES funcionarios(matricula) ON DELETE CASCADE,
        nome TEXT NOT NULL DEFAULT '',
        horas INTEGER NOT NULL DEFAULT 0,
        falta_atestado INTEGER NOT NULL DEFAULT 0,
        falta_sem_atestado INTEGER NOT NULL DEFAULT 0,
        obs TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'registros_unique_periodo_escola_matricula'
        ) THEN
          ALTER TABLE registros
          ADD CONSTRAINT registros_unique_periodo_escola_matricula
          UNIQUE (periodo, escola, matricula);
        END IF;
      END$$;
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_registros_periodo ON registros(periodo);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_registros_matricula ON registros(matricula);`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_registros_escola ON registros(escola);`);
  } finally {
    client.release();
  }
}

// ========= Rotas =========

// Health check
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1 as ok");
    ok(res, { db: true });
  } catch (e) {
    bad(res, "Banco indisponível.", 500, { error: e?.message });
  }
});

// Login admin
app.post("/api/login", async (req, res) => {
  const senha = String(req.body?.senha || "");
  if (!ADMIN_PASSWORD) return bad(res, "ADMIN_PASSWORD não configurado.", 500);
  if (!JWT_SECRET) return bad(res, "JWT_SECRET não configurado.", 500);

  if (senha !== ADMIN_PASSWORD) return bad(res, "Senha inválida.", 401);

  const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "12h" });
  ok(res, { token });
});

// ===== Funcionários (leitura) =====
app.get("/api/funcionarios", async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase();
  const limit = Math.min(Math.max(toInt(req.query.limit, 30), 1), 200);

  try {
    if (!q) {
      const r = await pool.query(
        `SELECT matricula, nome, funcao, vinculo, carga
         FROM funcionarios
         ORDER BY nome ASC
         LIMIT $1`,
        [limit]
      );
      return ok(res, { rows: r.rows });
    }

    const r = await pool.query(
      `SELECT matricula, nome, funcao, vinculo, carga
       FROM funcionarios
       WHERE LOWER(nome) LIKE $1 OR matricula LIKE $2
       ORDER BY nome ASC
       LIMIT $3`,
      [`${q}%`, `${q}%`, limit]
    );
    ok(res, { rows: r.rows });
  } catch (e) {
    bad(res, "Erro ao listar funcionários.", 500, { error: e?.message });
  }
});

// ===== Importar/atualizar cadastro mestre (opcional / protegido) =====
// Você pode usar isso para "subir" todos os funcionários no banco 1 vez.
// Não é para o usuário comum. Só admin.
app.post("/api/admin/funcionarios/import", requireAdmin, async (req, res) => {
  const list = req.body?.funcionarios;
  if (!Array.isArray(list)) return bad(res, "Envie { funcionarios: [...] }");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const f of list) {
      const matricula = String(f?.matricula || "").trim();
      if (!matricula) continue;

      const nome = String(f?.nome || "");
      const funcao = String(f?.funcao || "");
      const vinculo = String(f?.vinculo || "");
      const carga = String(f?.carga || "");

      await client.query(
        `INSERT INTO funcionarios (matricula, nome, funcao, vinculo, carga)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (matricula) DO UPDATE SET
           nome=EXCLUDED.nome,
           funcao=EXCLUDED.funcao,
           vinculo=EXCLUDED.vinculo,
           carga=EXCLUDED.carga`,
        [matricula, nome, funcao, vinculo, carga]
      );
    }
    await client.query("COMMIT");
    ok(res, { message: "Importação concluída." });
  } catch (e) {
    await client.query("ROLLBACK");
    bad(res, "Erro ao importar funcionários.", 500, { error: e?.message });
  } finally {
    client.release();
  }
});

// ===== Envio da folha (pela página folha.html) =====
// Espera algo como:
// {
//   escola: "ESCOLA X",
//   periodo: "2026-02",
//   itens: [
//     { matricula:"396", nome:"...", horas:2, falta_atestado:0, falta_sem_atestado:1, obs:"..." },
//     ...
//   ]
// }
app.post("/api/folha/enviar", async (req, res) => {
  const escola = String(req.body?.escola || "").trim();
  const periodo = normalizePeriodo(req.body?.periodo);

  if (!escola) return bad(res, "Informe a escola.");
  if (!periodo) return bad(res, "Período inválido. Use YYYY-MM.");

  const itens = req.body?.itens;
  if (!Array.isArray(itens) || itens.length === 0) return bad(res, "Nenhum item enviado.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const it of itens) {
      const matricula = String(it?.matricula || "").trim();
      if (!matricula) continue;

      const nome = String(it?.nome || "");
      const horas = Math.max(0, toInt(it?.horas, 0));
      const fa = Math.min(15, Math.max(0, toInt(it?.falta_atestado, 0)));
      const fs = Math.min(15, Math.max(0, toInt(it?.falta_sem_atestado, 0)));
      const obs = String(it?.obs || "");

      // garante que o funcionário exista no cadastro mestre
      await client.query(
        `INSERT INTO funcionarios (matricula, nome)
         VALUES ($1,$2)
         ON CONFLICT (matricula) DO UPDATE SET nome = COALESCE(NULLIF(EXCLUDED.nome,''), funcionarios.nome)`,
        [matricula, nome]
      );

      // upsert do registro (por mês+escola+matricula)
      await client.query(
        `INSERT INTO registros (escola, periodo, matricula, nome, horas, falta_atestado, falta_sem_atestado, obs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (periodo, escola, matricula) DO UPDATE SET
           nome = EXCLUDED.nome,
           horas = EXCLUDED.horas,
           falta_atestado = EXCLUDED.falta_atestado,
           falta_sem_atestado = EXCLUDED.falta_sem_atestado,
           obs = EXCLUDED.obs,
           updated_at = NOW()`,
        [escola, periodo, matricula, nome, horas, fa, fs, obs]
      );
    }

    await client.query("COMMIT");
    ok(res, { message: "Folha enviada e atualizada no admin." });
  } catch (e) {
    await client.query("ROLLBACK");
    bad(res, "Erro ao salvar folha.", 500, { error: e?.message });
  } finally {
    client.release();
  }
});

// ===== ADMIN: Resumo do mês (todos funcionários + soma de envios) =====
// Retorna TODOS os funcionários do cadastro mestre, mesmo sem envio (0)
app.get("/api/admin/mes", async (req, res) => {
  const periodo = normalizePeriodo(req.query.periodo);
  if (!periodo) return bad(res, "Período inválido. Use YYYY-MM.");

  try {
    const r = await pool.query(
      `
      WITH agg AS (
        SELECT
          matricula,
          SUM(horas) AS horas,
          SUM(falta_atestado) AS falta_atestado,
          SUM(falta_sem_atestado) AS falta_sem_atestado,
          STRING_AGG(DISTINCT escola, ', ' ORDER BY escola) AS escolas,
          STRING_AGG(DISTINCT NULLIF(TRIM(obs),''), ' | ') AS obs
        FROM registros
        WHERE periodo = $1
        GROUP BY matricula
      )
      SELECT
        f.matricula,
        f.nome,
        f.funcao,
        f.vinculo,
        f.carga,
        COALESCE(a.horas,0)::int AS horas,
        COALESCE(a.falta_atestado,0)::int AS falta_atestado,
        COALESCE(a.falta_sem_atestado,0)::int AS falta_sem_atestado,
        COALESCE(a.escolas,'') AS escolas,
        COALESCE(a.obs,'') AS obs
      FROM funcionarios f
      LEFT JOIN agg a ON a.matricula = f.matricula
      ORDER BY f.nome ASC
      `,
      [periodo]
    );

    ok(res, { rows: r.rows });
  } catch (e) {
    bad(res, "Erro ao gerar resumo do mês.", 500, { error: e?.message });
  }
});

// ===== ADMIN: Balanço geral do mês =====
app.get("/api/admin/balanco", async (req, res) => {
  const periodo = normalizePeriodo(req.query.periodo);
  if (!periodo) return bad(res, "Período inválido. Use YYYY-MM.");

  try {
    const r = await pool.query(
      `
      SELECT
        COUNT(*)::int AS registros,
        COALESCE(SUM(horas),0)::int AS horas,
        COALESCE(SUM(falta_atestado),0)::int AS falta_atestado,
        COALESCE(SUM(falta_sem_atestado),0)::int AS falta_sem_atestado
      FROM registros
      WHERE periodo = $1
      `,
      [periodo]
    );

    ok(res, r.rows[0] || { registros: 0, horas: 0, falta_atestado: 0, falta_sem_atestado: 0 });
  } catch (e) {
    bad(res, "Erro ao gerar balanço.", 500, { error: e?.message });
  }
});

// ===== ADMIN: Registros detalhados (para editar/apagar) =====
app.get("/api/admin/registros", async (req, res) => {
  const periodo = normalizePeriodo(req.query.periodo);
  if (!periodo) return bad(res, "Período inválido. Use YYYY-MM.");

  const escola = String(req.query.escola || "").trim();

  try {
    let q = `
      SELECT
        id, escola, periodo, matricula, nome, horas, falta_atestado, falta_sem_atestado, obs,
        TO_CHAR(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
      FROM registros
      WHERE periodo = $1
    `;
    const params = [periodo];

    if (escola) {
      q += " AND escola = $2";
      params.push(escola);
    }

    q += " ORDER BY escola ASC, nome ASC";

    const r = await pool.query(q, params);
    ok(res, { rows: r.rows });
  } catch (e) {
    bad(res, "Erro ao listar registros.", 500, { error: e?.message });
  }
});

// ===== ADMIN: Editar registro (A) =====
app.put("/api/registros/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return bad(res, "ID inválido.");

  const escola = String(req.body?.escola || "").trim();
  const periodo = normalizePeriodo(req.body?.periodo);
  const horas = Math.max(0, toInt(req.body?.horas, 0));
  const fa = Math.min(15, Math.max(0, toInt(req.body?.falta_atestado, 0)));
  const fs = Math.min(15, Math.max(0, toInt(req.body?.falta_sem_atestado, 0)));
  const obs = String(req.body?.obs || "");

  if (!periodo) return bad(res, "Período inválido. Use YYYY-MM.");
  if (!escola) return bad(res, "Escola é obrigatória.");

  try {
    const r = await pool.query(
      `
      UPDATE registros
      SET escola=$1, periodo=$2, horas=$3, falta_atestado=$4, falta_sem_atestado=$5, obs=$6, updated_at=NOW()
      WHERE id=$7
      RETURNING id
      `,
      [escola, periodo, horas, fa, fs, obs, id]
    );

    if (r.rowCount === 0) return bad(res, "Registro não encontrado.", 404);
    ok(res, { id });
  } catch (e) {
    // pode dar conflito de UNIQUE(periodo, escola, matricula)
    bad(res, "Erro ao editar registro.", 500, { error: e?.message });
  }
});

// ===== ADMIN: Apagar registro (B) =====
app.delete("/api/registros/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id || "").trim();
  if (!id) return bad(res, "ID inválido.");

  try {
    const r = await pool.query(`DELETE FROM registros WHERE id=$1 RETURNING id`, [id]);
    if (r.rowCount === 0) return bad(res, "Registro não encontrado.", 404);
    ok(res, { id });
  } catch (e) {
    bad(res, "Erro ao apagar registro.", 500, { error: e?.message });
  }
});

// Fallback: se acessar "/" e não existir index.html
app.get("/", (req, res) => {
  // Se existir index.html em public, express.static já serve.
  // Aqui é só uma segurança.
  res.sendFile(path.join(PUBLIC_DIR, "index.html"), (err) => {
    if (err) res.status(200).send("SEMEC-SISTEMA online ✅");
  });
});

// ========= Start =========
ensureSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Servidor rodando na porta ${PORT}`);
    });
  })
  .catch((e) => {
    console.error("❌ Falha ao preparar o banco:");
    console.error("Mensagem:", e?.message);
    console.error("Stack:", e?.stack);
    console.error("Erro bruto:", e);
    process.exit(1);
  });
