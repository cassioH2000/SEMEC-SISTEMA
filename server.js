// server.js (ESM) - SEMEC SISTEMA
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import path from "path";
import { fileURLToPath } from "url";
import pkg from "pg";
const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ====== CONFIG ======
const PORT = process.env.PORT || 10000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_NOW";

// ====== STATIC (public) ======
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, "public");
app.use(express.static(PUBLIC_DIR));

// ====== DB ======
if (!DATABASE_URL) {
  console.warn("⚠️ DATABASE_URL não configurada. Configure no Render.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false, // ✅ Corrige SSL do Supabase no Render
});

// ====== HELPERS ======
function monthToPeriod(ym) {
  // aceita "YYYY-MM" ou "YYYY-MM-DD" -> retorna "YYYY-MM"
  if (!ym) return null;
  const s = String(ym).trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.slice(0, 7);
  return null;
}

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ ok: false, error: "Sem token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload || payload.role !== "admin") {
      return res.status(403).json({ ok: false, error: "Sem permissão" });
    }
    req.admin = payload;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }
}

async function dbOk() {
  try {
    const r = await pool.query("select 1 as ok");
    return !!r?.rows?.[0]?.ok;
  } catch {
    return false;
  }
}

// ====== SCHEMA ======
async function ensureSchema() {
  if (!DATABASE_URL) return;

  // Tabelas:
  // - funcionarios: cadastro único por matricula (sempre aparece no admin)
  // - registros: envio mensal por funcionario + periodo + escola (upsert)
  const sql = `
  create table if not exists funcionarios (
    matricula text primary key,
    nome text default '',
    funcao text default '',
    vinculo text default '',
    carga text default '',
    created_at timestamptz default now(),
    updated_at timestamptz default now()
  );

  create table if not exists registros (
    id bigserial primary key,
    periodo text not null,               -- "YYYY-MM"
    escola text default '',
    matricula text not null references funcionarios(matricula) on delete cascade,

    faltas integer default 0,
    horas_extras numeric default 0,
    observacao text default '',

    payload jsonb default '{}'::jsonb,   -- guarda campos extras se você quiser
    updated_at timestamptz default now(),
    created_at timestamptz default now(),

    unique (periodo, matricula, escola)
  );

  create index if not exists idx_registros_periodo on registros(periodo);
  create index if not exists idx_registros_escola on registros(escola);

  -- trigger simples para updated_at (sem precisar extensão)
  `;
  await pool.query(sql);
}

async function ensureFuncionario(matricula, dados = {}) {
  const m = String(matricula || "").trim();
  if (!m) return;

  const nome = (dados.nome ?? "").toString();
  const funcao = (dados.funcao ?? "").toString();
  const vinculo = (dados.vinculo ?? "").toString();
  const carga = (dados.carga ?? "").toString();

  await pool.query(
    `
    insert into funcionarios (matricula, nome, funcao, vinculo, carga, updated_at)
    values ($1,$2,$3,$4,$5, now())
    on conflict (matricula)
    do update set
      nome = coalesce(nullif(excluded.nome,''), funcionarios.nome),
      funcao = coalesce(nullif(excluded.funcao,''), funcionarios.funcao),
      vinculo = coalesce(nullif(excluded.vinculo,''), funcionarios.vinculo),
      carga = coalesce(nullif(excluded.carga,''), funcionarios.carga),
      updated_at = now()
    `,
    [m, nome, funcao, vinculo, carga]
  );
}

async function upsertRegistro({ periodo, escola, matricula, faltas, horas_extras, observacao, payload }) {
  const p = monthToPeriod(periodo);
  if (!p) throw new Error("Período inválido (use YYYY-MM)");
  const m = String(matricula || "").trim();
  if (!m) throw new Error("Matrícula obrigatória");

  const esc = (escola ?? "").toString().trim(); // pode ser vazio
  const f = Number.isFinite(Number(faltas)) ? Number(faltas) : 0;
  const he = Number.isFinite(Number(horas_extras)) ? Number(horas_extras) : 0;
  const obs = (observacao ?? "").toString();

  const pay = payload && typeof payload === "object" ? payload : {};

  const r = await pool.query(
    `
    insert into registros (periodo, escola, matricula, faltas, horas_extras, observacao, payload, updated_at)
    values ($1,$2,$3,$4,$5,$6,$7::jsonb, now())
    on conflict (periodo, matricula, escola)
    do update set
      faltas = excluded.faltas,
      horas_extras = excluded.horas_extras,
      observacao = excluded.observacao,
      payload = excluded.payload,
      updated_at = now()
    returning *
    `,
    [p, esc, m, f, he, obs, JSON.stringify(pay)]
  );

  return r.rows[0];
}

// ====== ROUTES ======
app.get("/", (req, res) => {
  // se existir index.html em /public, abre
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.get("/api/health", async (req, res) => {
  const ok = await dbOk();
  res.json({ ok: true, db: ok });
});

// LOGIN ADMIN
app.post("/api/login", async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!ADMIN_PASSWORD) {
      return res.status(500).json({ ok: false, error: "ADMIN_PASSWORD não configurada no Render" });
    }
    if (!password || String(password) !== String(ADMIN_PASSWORD)) {
      return res.status(401).json({ ok: false, error: "Senha inválida" });
    }

    const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "12h" });
    return res.json({ ok: true, token });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Erro no login" });
  }
});

// FOLHA -> ENVIAR (UPSERT)
app.post("/api/folha/enviar", async (req, res) => {
  try {
    if (!DATABASE_URL) return res.status(500).json({ ok: false, error: "Sem DATABASE_URL" });

    const body = req.body || {};
    const periodo = monthToPeriod(body.periodo);
    const matricula = body.matricula;
    const escola = body.escola ?? "";
    const dadosFuncionario = body.funcionario || body.dadosFuncionario || {};

    // garante funcionario no cadastro
    await ensureFuncionario(matricula, dadosFuncionario);

    // cria/atualiza registro do mês
    const registro = await upsertRegistro({
      periodo,
      escola,
      matricula,
      faltas: body.faltas ?? 0,
      horas_extras: body.horas_extras ?? 0,
      observacao: body.observacao ?? "",
      payload: body.payload ?? body, // guarda o body inteiro se quiser
    });

    return res.json({ ok: true, registro });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || "Erro ao enviar" });
  }
});

// ADMIN -> LISTAR MÊS (sempre retorna TODOS os funcionários)
// GET /api/admin/mes?periodo=2026-02&escola=EscolaX (opcional)
app.get("/api/admin/mes", requireAdmin, async (req, res) => {
  try {
    if (!DATABASE_URL) return res.status(500).json({ ok: false, error: "Sem DATABASE_URL" });

    const periodo = monthToPeriod(req.query.periodo);
    if (!periodo) return res.status(400).json({ ok: false, error: "Informe periodo=YYYY-MM" });

    const escola = (req.query.escola ?? "").toString().trim();
    const filtraEscola = escola && escola.toLowerCase() !== "todas" && escola.toLowerCase() !== "todas as escolas";

    // Quando filtra por escola, ainda assim queremos todos funcionários
    // mas o registro do mês será daquele filtro de escola.
    const params = filtraEscola ? [periodo, escola] : [periodo];

    const query = filtraEscola
      ? `
        select
          f.matricula, f.nome, f.funcao, f.vinculo, f.carga,
          r.id as registro_id,
          r.periodo, r.escola,
          coalesce(r.faltas,0) as faltas,
          coalesce(r.horas_extras,0) as horas_extras,
          coalesce(r.observacao,'') as observacao,
          r.payload,
          r.updated_at
        from funcionarios f
        left join registros r
          on r.matricula = f.matricula
         and r.periodo = $1
         and r.escola = $2
        order by f.nome asc
      `
      : `
        -- Sem filtro: pode haver múltiplas escolas por funcionário no mês.
        -- Aqui vamos pegar SOMA por funcionário no mês (todas as escolas),
        -- e também manter um "detalhe_escolas" para relatório.
        with base as (
          select
            f.matricula, f.nome, f.funcao, f.vinculo, f.carga,
            r.id, r.escola, r.periodo,
            coalesce(r.faltas,0) as faltas,
            coalesce(r.horas_extras,0) as horas_extras,
            coalesce(r.observacao,'') as observacao,
            r.payload,
            r.updated_at
          from funcionarios f
          left join registros r
            on r.matricula = f.matricula
           and r.periodo = $1
        )
        select
          matricula, nome, funcao, vinculo, carga,
          -- soma do mês (todas escolas)
          coalesce(sum(faltas),0)::int as faltas,
          coalesce(sum(horas_extras),0) as horas_extras,
          -- escolas em que tem registro
          jsonb_agg(
            case when escola is null then null else
              jsonb_build_object(
                'id', id,
                'escola', escola,
                'faltas', faltas,
                'horas_extras', horas_extras,
                'observacao', observacao,
                'updated_at', updated_at,
                'payload', payload
              )
            end
          ) filter (where escola is not null) as detalhe_escolas
        from base
        group by matricula, nome, funcao, vinculo, carga
        order by nome asc
      `;

    const r = await pool.query(query, params);

    // KPIs / resumo
    const rows = r.rows || [];
    let totalFuncionarios = rows.length;

    // total de "envios" = quantidade de registros existentes no mês
    // (com filtro escola: 1 registro por funcionário no máximo)
    const enviosQ = filtraEscola
      ? `select count(*)::int as total from registros where periodo=$1 and escola=$2`
      : `select count(*)::int as total from registros where periodo=$1`;

    const enviosR = await pool.query(enviosQ, params);
    const totalEnvios = enviosR.rows?.[0]?.total ?? 0;

    // somas do mês
    const somaQ = filtraEscola
      ? `select coalesce(sum(faltas),0)::int as faltas, coalesce(sum(horas_extras),0) as horas_extras from registros where periodo=$1 and escola=$2`
      : `select coalesce(sum(faltas),0)::int as faltas, coalesce(sum(horas_extras),0) as horas_extras from registros where periodo=$1`;

    const somaR = await pool.query(somaQ, params);
    const totais = somaR.rows?.[0] || { faltas: 0, horas_extras: 0 };

    return res.json({
      ok: true,
      periodo,
      escola: filtraEscola ? escola : "Todas as escolas",
      kpis: {
        total_funcionarios: totalFuncionarios,
        total_envios: totalEnvios,
        faltas_total: Number(totais.faltas || 0),
        horas_extras_total: Number(totais.horas_extras || 0),
      },
      funcionarios: rows,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "Erro admin mes" });
  }
});

// ADMIN -> EDITAR (UPSERT por matricula + periodo + escola)
// PUT /api/admin/registro
app.put("/api/admin/registro", requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const periodo = monthToPeriod(body.periodo);
    const matricula = body.matricula;
    const escola = body.escola ?? "";

    // garante funcionario no cadastro se vier dados
    if (body.funcionario) await ensureFuncionario(matricula, body.funcionario);

    const registro = await upsertRegistro({
      periodo,
      escola,
      matricula,
      faltas: body.faltas ?? 0,
      horas_extras: body.horas_extras ?? 0,
      observacao: body.observacao ?? "",
      payload: body.payload ?? body,
    });

    return res.json({ ok: true, registro });
  } catch (e) {
    return res.status(400).json({ ok: false, error: e.message || "Erro ao editar" });
  }
});

// ADMIN -> APAGAR POR ID
// DELETE /api/admin/registro/:id
app.delete("/api/admin/registro/:id", requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ ok: false, error: "ID inválido" });

    const r = await pool.query("delete from registros where id=$1 returning id", [id]);
    if (!r.rowCount) return res.status(404).json({ ok: false, error: "Registro não encontrado" });

    return res.json({ ok: true, deleted: id });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message || "Erro ao apagar" });
  }
});

// ADMIN -> LISTAR ESCOLAS DO MÊS (para preencher select)
app.get("/api/admin/escolas", requireAdmin, async (req, res) => {
  try {
    const periodo = monthToPeriod(req.query.periodo);
    if (!periodo) return res.status(400).json({ ok: false, error: "Informe periodo=YYYY-MM" });

    const r = await pool.query(
      `select distinct escola from registros where periodo=$1 and escola <> '' order by escola asc`,
      [periodo]
    );
    res.json({ ok: true, escolas: r.rows.map((x) => x.escola) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Erro escolas" });
  }
});

// ====== BOOT ======
(async () => {
  try {
    console.log("🟦 Iniciando servidor...");
    console.log("📁 Public dir:", PUBLIC_DIR);

    if (DATABASE_URL) {
      await ensureSchema();
      console.log("✅ Schema OK");
    } else {
      console.log("⚠️ Sem DATABASE_URL, rodando sem banco.");
    }
  } catch (e) {
    console.log("❌ Falha ao preparar schema:", e.message);
  }

  app.listen(PORT, () => {
    console.log("✅ Servidor rodando na porta", PORT);
  });
})();
