// server.js (ESM) - Node 18+ (você está em Node 22 no Render)
// Força IPv4 para evitar ENETUNREACH em endereços 2600:... (IPv6)

import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import dns from "dns";
import { Pool } from "pg";
import path from "path";
import { fileURLToPath } from "url";

// ========================
// 1) FORÇAR IPV4 (MUITO IMPORTANTE)
// ========================
try {
  // Node >= 17
  dns.setDefaultResultOrder("ipv4first");
} catch (e) {
  // Ignora se não suportar
}

// Log para confirmar
console.log("NODE_OPTIONS:", process.env.NODE_OPTIONS || "(vazio)");
try {
  console.log("DNS default result order:", dns.getDefaultResultOrder());
} catch {
  console.log("DNS default result order: (não disponível)");
}

// Lookup IPv4 obrigatório para o pg
function ipv4Lookup(hostname, options, callback) {
  // força family 4
  return dns.lookup(hostname, { ...options, family: 4 }, callback);
}

// ========================
// 2) ENV / CONFIG
// ========================
const PORT = process.env.PORT || 10000;

// Defina no Render (Environment):
// DATABASE_URL = postgresql://...:5432/postgres  (preferível DIRECT)
// ADMIN_PASSWORD = sua senha do admin
// JWT_SECRET = uma chave forte (ex: 40+ caracteres)

const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const JWT_SECRET = process.env.JWT_SECRET || "troque_essa_chave_no_render";

// ========================
// 3) APP
// ========================
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// Servir arquivos estáticos (se você tiver /public)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// ========================
// 4) POSTGRES POOL
// ========================
let pool = null;

function buildPool() {
  if (!DATABASE_URL) {
    console.warn("⚠️ DATABASE_URL não definida. Banco ficará desativado.");
    return null;
  }

  // ssl: necessário na maioria dos casos com Supabase
  // rejectUnauthorized false evita erro de chain/self-signed em alguns ambientes
  const p = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    lookup: ipv4Lookup, // <<<<<<<<<< FORÇA IPV4 NO PG
    // keepAlive ajuda estabilidade
    keepAlive: true,
    // timeouts para não travar start
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
  });

  p.on("error", (err) => {
    console.error("❌ Erro inesperado no Pool do Postgres:", err?.message || err);
  });

  return p;
}

pool = buildPool();

// ========================
// 5) SCHEMA (ajuste para o seu sistema)
// ========================
async function ensureSchema() {
  if (!pool) return;

  // Teste de conexão rápido
  const client = await pool.connect();
  try {
    await client.query("select 1 as ok");
  } finally {
    client.release();
  }

  // Aqui você cria tabelas mínimas. Ajuste conforme seu banco real.
  // Exemplo: funcionários e envios/mês
  await pool.query(`
    create table if not exists funcionarios (
      id serial primary key,
      matricula text unique not null,
      nome text,
      funcao text,
      vinculo text,
      carga text,
      escola text,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    );
  `);

  await pool.query(`
    create table if not exists folha_envios (
      id serial primary key,
      matricula text not null,
      periodo text not null, -- YYYY-MM
      payload jsonb not null,
      created_at timestamptz default now(),
      updated_at timestamptz default now(),
      unique (matricula, periodo)
    );
  `);

  console.log("✅ Banco preparado (schema ok).");
}

// Rodar schema sem derrubar o servidor se falhar
(async () => {
  try {
    if (pool) {
      await ensureSchema();
    }
  } catch (err) {
    console.error("❌ Falha ao preparar o banco (ensureSchema):", err?.message || err);
    // Não dar throw para não matar o Render. O serviço sobe e você vê o erro.
  }
})();

// ========================
// 6) AUTH (ADMIN)
// ========================
function signAdminToken() {
  return jwt.sign(
    { role: "admin" },
    JWT_SECRET,
    { expiresIn: "12h" }
  );
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Sem token" });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded?.role !== "admin") return res.status(403).json({ error: "Sem permissão" });
    req.user = decoded;
    return next();
  } catch {
    return res.status(401).json({ error: "Token inválido/expirado" });
  }
}

// ========================
// 7) ROTAS
// ========================
app.get("/api/health", async (req, res) => {
  try {
    if (!pool) return res.status(200).json({ ok: true, db: "disabled" });
    const r = await pool.query("select 1 as ok");
    return res.json({ ok: true, db: r.rows?.[0]?.ok === 1 ? "up" : "?" });
  } catch (e) {
    return res.status(500).json({ ok: false, db: "down", error: e?.message || String(e) });
  }
});

app.post("/api/login", (req, res) => {
  const { password } = req.body || {};
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: "ADMIN_PASSWORD não configurado no Render" });
  }
  if (!password) return res.status(400).json({ error: "Informe a senha" });

  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "Senha inválida" });
  }

  const token = signAdminToken();
  return res.json({ token });
});

// Exemplo de endpoint do admin que seu front chama:
// /api/admin/mes?periodo=2026-02
app.get("/api/admin/mes", requireAdmin, async (req, res) => {
  try {
    const periodo = String(req.query.periodo || "").trim();
    if (!periodo) return res.status(400).json({ error: "periodo é obrigatório (YYYY-MM)" });
    if (!pool) return res.status(500).json({ error: "Banco não configurado" });

    // Resumo geral do mês
    const totalEnvios = await pool.query(
      "select count(*)::int as total from folha_envios where periodo = $1",
      [periodo]
    );

    // Exemplo de soma de horas extras se existir no payload (ajuste conforme seu JSON real)
    // Aqui tenta ler payload->>'horas_extras' como número
    const horasExtras = await pool.query(
      `
      select coalesce(sum( nullif((payload->>'horas_extras'),'')::numeric ),0) as soma
      from folha_envios
      where periodo = $1
      `,
      [periodo]
    );

    return res.json({
      periodo,
      total_envios: totalEnvios.rows[0].total,
      horas_extras_soma: Number(horasExtras.rows[0].soma || 0),
    });
  } catch (e) {
    console.error("Erro /api/admin/mes:", e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// Endpoint para a página de folha "atualizar as informações do funcionário citado"
// exemplo: POST /api/folha/enviar  { matricula, periodo, payload }
app.post("/api/folha/enviar", async (req, res) => {
  try {
    const { matricula, periodo, payload, funcionario } = req.body || {};
    if (!pool) return res.status(500).json({ error: "Banco não configurado" });

    if (!matricula || !periodo || !payload) {
      return res.status(400).json({ error: "matricula, periodo e payload são obrigatórios" });
    }

    // 1) garante funcionário no cadastro (e atualiza dados se vierem)
    if (funcionario && typeof funcionario === "object") {
      const { nome = null, funcao = null, vinculo = null, carga = null, escola = null } = funcionario;

      await pool.query(
        `
        insert into funcionarios (matricula, nome, funcao, vinculo, carga, escola)
        values ($1,$2,$3,$4,$5,$6)
        on conflict (matricula) do update set
          nome = coalesce(excluded.nome, funcionarios.nome),
          funcao = coalesce(excluded.funcao, funcionarios.funcao),
          vinculo = coalesce(excluded.vinculo, funcionarios.vinculo),
          carga = coalesce(excluded.carga, funcionarios.carga),
          escola = coalesce(excluded.escola, funcionarios.escola),
          updated_at = now()
        `,
        [matricula, nome, funcao, vinculo, carga, escola]
      );
    } else {
      // garante pelo menos a matrícula cadastrada
      await pool.query(
        `
        insert into funcionarios (matricula)
        values ($1)
        on conflict (matricula) do nothing
        `,
        [matricula]
      );
    }

    // 2) salva/atualiza envio do mês (um por matrícula + período)
    await pool.query(
      `
      insert into folha_envios (matricula, periodo, payload)
      values ($1,$2,$3)
      on conflict (matricula, periodo) do update set
        payload = excluded.payload,
        updated_at = now()
      `,
      [matricula, periodo, payload]
    );

    return res.json({ ok: true });
  } catch (e) {
    console.error("Erro /api/folha/enviar:", e);
    return res.status(500).json({ error: e?.message || String(e) });
  }
});

// ========================
// 8) START
// ========================
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  console.log("📁 Public dir:", path.join(__dirname, "public"));
});
