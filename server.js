import express from "express";
import cors from "cors";
import pkg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ===== SERVIR PASTA public =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// ===== BANCO (SUPABASE) =====
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL não definida nas Environment Variables do Render.");
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== FUNÇÕES ÚTEIS =====
function nInt(v) {
  const x = Number(v);
  return Number.isFinite(x) ? Math.trunc(x) : 0;
}
function t(v) {
  return String(v ?? "").trim();
}

// ===== CRIAR/ATUALIZAR TABELA =====
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.registros (
      id BIGSERIAL PRIMARY KEY,
      escola TEXT,
      matricula TEXT,
      nome TEXT,
      funcao TEXT,
      vinculo TEXT,
      carga TEXT,
      periodo TEXT,
      horas INTEGER DEFAULT 0,
      falta_atestado INTEGER DEFAULT 0,
      falta_sem_atestado INTEGER DEFAULT 0,
      obs TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // garante colunas caso a tabela já exista
  await pool.query(`ALTER TABLE public.registros ADD COLUMN IF NOT EXISTS escola TEXT;`);
  await pool.query(`ALTER TABLE public.registros ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();`);

  // índices para performance
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_registros_periodo ON public.registros (periodo);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_registros_escola ON public.registros (escola);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_registros_matricula ON public.registros (matricula);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_registros_created_at ON public.registros (created_at);`);
}

// ===== HEALTH =====
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== AUTH ADM (TOKEN) =====
const adminTokens = new Set();

function adminAuth(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// ===== LOGIN ADM (retorna token) =====
app.post("/api/login", (req, res) => {
  const { senha } = req.body || {};
  if (!process.env.ADMIN_PASSWORD) {
    return res.status(500).json({ ok: false, error: "ADMIN_PASSWORD_not_set" });
  }
  if (senha !== process.env.ADMIN_PASSWORD) return res.status(401).json({ ok: false });

  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  adminTokens.add(token);

  res.json({ ok: true, token });
});

// ===== RECEBER RELATÓRIO (NOVO - recomendado) =====
// Body: { source: "Escola X", records: [...] }
app.post("/api/reports", async (req, res) => {
  try {
    const { source, records } = req.body || {};
    if (!source || !Array.isArray(records)) {
      return res.status(400).json({ ok: false, error: "bad_payload" });
    }

    const escola = t(source) || "(sem escola)";

    const ins = `
      INSERT INTO public.registros
      (escola, matricula, nome, funcao, vinculo, carga, periodo, horas, falta_atestado, falta_sem_atestado, obs)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `;

    for (const r of records) {
      await pool.query(ins, [
        escola,
        t(r.matricula),
        t(r.nome),
        t(r.funcao),
        t(r.vinculo),
        t(r.carga),
        t(r.period ?? r.periodo),
        nInt(r.horas_extras ?? r.horas),
        nInt(r.falta_atestado ?? r.faltaA),
        nInt(r.falta_sem_atestado ?? r.faltaS),
        t(r.obs)
      ]);
    }

    res.json({ ok: true });
  } catch (e) {
    console.log(e);
    res.status(500).json({ ok: false, error: "db_error", detail: String(e?.message || e) });
  }
});

// ===== COMPATÍVEL COM O ANTIGO =====
// Body: array de registros (sem escola) -> salva "(sem escola)"
app.post("/api/enviar", async (req, res) => {
  try {
    const dados = req.body;
    if (!Array.isArray(dados)) return res.status(400).json({ ok: false, error: "bad_payload" });

    const ins = `
      INSERT INTO public.registros
      (escola, matricula, nome, funcao, vinculo, carga, periodo, horas, falta_atestado, falta_sem_atestado, obs)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `;

    for (const r of dados) {
      await pool.query(ins, [
        "(sem escola)",
        t(r.matricula),
        t(r.nome),
        t(r.funcao),
        t(r.vinculo),
        t(r.carga),
        t(r.periodo),
        nInt(r.horas),
        nInt(r.faltaA),
        nInt(r.faltaS),
        t(r.obs)
      ]);
    }

    res.json({ ok: true });
  } catch (e) {
    console.log(e);
    res.status(500).json({ ok: false, error: "erro_ao_salvar" });
  }
});

// ===== LISTAR REGISTROS =====
app.get("/api/registros", async (req, res) => {
  try {
    const periodo = req.query.periodo ? t(req.query.periodo) : null;
    const escola = req.query.escola ? t(req.query.escola) : null;

    const where = [];
    const params = [];
    if (periodo) { params.push(periodo); where.push(`periodo = $${params.length}`); }
    if (escola)  { params.push(escola);  where.push(`escola = $${params.length}`); }

    const sql = `
      SELECT * FROM public.registros
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY id DESC
    `;
    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) {
    console.log(e);
    res.status(500).json({ ok: false, error: "erro_banco" });
  }
});

// ===== BALANÇO GERAL =====
app.get("/api/balanco/geral", async (req, res) => {
  try {
    const periodo = req.query.periodo ? t(req.query.periodo) : null;

    const sql = periodo
      ? `
        SELECT
          COUNT(*)::int AS registros,
          COALESCE(SUM(horas),0)::int AS horas,
          COALESCE(SUM(falta_atestado),0)::int AS falta_atestado,
          COALESCE(SUM(falta_sem_atestado),0)::int AS falta_sem_atestado
        FROM public.registros
        WHERE periodo = $1
      `
      : `
        SELECT
          COUNT(*)::int AS registros,
          COALESCE(SUM(horas),0)::int AS horas,
          COALESCE(SUM(falta_atestado),0)::int AS falta_atestado,
          COALESCE(SUM(falta_sem_atestado),0)::int AS falta_sem_atestado
        FROM public.registros
      `;

    const r = periodo ? await pool.query(sql, [periodo]) : await pool.query(sql);
    const row = r.rows[0] || { registros: 0, horas: 0, falta_atestado: 0, falta_sem_atestado: 0 };
    res.json({ ...row, total_faltas: row.falta_atestado + row.falta_sem_atestado });
  } catch (e) {
    console.log(e);
    res.status(500).json({ ok: false, error: "erro_balanco" });
  }
});

// ===== BALANÇO POR ESCOLA =====
app.get("/api/balanco/escolas", async (req, res) => {
  try {
    const periodo = req.query.periodo ? t(req.query.periodo) : null;

    const sql = periodo
      ? `
        SELECT
          COALESCE(escola,'(sem escola)') AS escola,
          COUNT(*)::int AS registros,
          COALESCE(SUM(horas),0)::int AS horas,
          COALESCE(SUM(falta_atestado),0)::int AS falta_atestado,
          COALESCE(SUM(falta_sem_atestado),0)::int AS falta_sem_atestado
        FROM public.registros
        WHERE periodo = $1
        GROUP BY COALESCE(escola,'(sem escola)')
        ORDER BY escola ASC
      `
      : `
        SELECT
          COALESCE(escola,'(sem escola)') AS escola,
          COUNT(*)::int AS registros,
          COALESCE(SUM(horas),0)::int AS horas,
          COALESCE(SUM(falta_atestado),0)::int AS falta_atestado,
          COALESCE(SUM(falta_sem_atestado),0)::int AS falta_sem_atestado
        FROM public.registros
        GROUP BY COALESCE(escola,'(sem escola)')
        ORDER BY escola ASC
      `;

    const r = periodo ? await pool.query(sql, [periodo]) : await pool.query(sql);
    res.json({ escolas: r.rows });
  } catch (e) {
    console.log(e);
    res.status(500).json({ ok: false, error: "erro_escolas" });
  }
});

// ===== RELATÓRIO GERAL (CONSOLIDADO POR FUNCIONÁRIO) =====
app.get("/api/relatorio/geral", async (req, res) => {
  try {
    const periodo = req.query.periodo ? t(req.query.periodo) : null;

    const sql = periodo
      ? `
        SELECT
          matricula,
          MAX(nome) AS nome,
          MAX(funcao) AS funcao,
          MAX(vinculo) AS vinculo,
          MAX(carga) AS carga,
          COALESCE(SUM(horas),0)::int AS horas_extras,
          COALESCE(SUM(falta_atestado),0)::int AS falta_atestado,
          COALESCE(SUM(falta_sem_atestado),0)::int AS falta_sem_atestado,
          COUNT(*)::int AS envios,
          STRING_AGG(DISTINCT COALESCE(escola,'(sem escola)'), ', ' ORDER BY COALESCE(escola,'(sem escola)')) AS escolas,
          STRING_AGG(DISTINCT NULLIF(TRIM(COALESCE(obs,'')),''), ' | ') AS obs_consolidada
        FROM public.registros
        WHERE periodo = $1
        GROUP BY matricula
        ORDER BY nome ASC NULLS LAST
      `
      : `
        SELECT
          matricula,
          MAX(nome) AS nome,
          MAX(funcao) AS funcao,
          MAX(vinculo) AS vinculo,
          MAX(carga) AS carga,
          COALESCE(SUM(horas),0)::int AS horas_extras,
          COALESCE(SUM(falta_atestado),0)::int AS falta_atestado,
          COALESCE(SUM(falta_sem_atestado),0)::int AS falta_sem_atestado,
          COUNT(*)::int AS envios,
          STRING_AGG(DISTINCT COALESCE(escola,'(sem escola)'), ', ' ORDER BY COALESCE(escola,'(sem escola)')) AS escolas,
          STRING_AGG(DISTINCT NULLIF(TRIM(COALESCE(obs,'')),''), ' | ') AS obs_consolidada
        FROM public.registros
        GROUP BY matricula
        ORDER BY nome ASC NULLS LAST
      `;

    const r = periodo ? await pool.query(sql, [periodo]) : await pool.query(sql);
    res.json({ periodo: periodo || null, rows: r.rows });
  } catch (e) {
    console.log(e);
    res.status(500).json({ ok: false, error: "erro_relatorio_geral" });
  }
});

// ===== RESUMO POR MATRÍCULA =====
app.get("/api/resumo/:mat", async (req, res) => {
  try {
    const mat = t(req.params.mat);

    const r = await pool.query(`
      SELECT
        MAX(nome) AS nome,
        MAX(funcao) AS funcao,
        MAX(vinculo) AS vinculo,
        MAX(carga) AS carga,
        COALESCE(SUM(horas),0)::int AS horas,
        COALESCE(SUM(falta_atestado),0)::int AS falta_atestado,
        COALESCE(SUM(falta_sem_atestado),0)::int AS falta_sem_atestado
      FROM public.registros
      WHERE matricula = $1
    `, [mat]);

    res.json(r.rows[0] || {});
  } catch (e) {
    console.log(e);
    res.status(500).json({ ok: false, error: "erro_resumo" });
  }
});

// ===== EDITAR REGISTRO (SOMENTE ADM) =====
app.put("/api/registros/:id", adminAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const r = req.body || {};

    await pool.query(`
      UPDATE public.registros SET
        escola=$1,
        matricula=$2,
        nome=$3,
        funcao=$4,
        vinculo=$5,
        carga=$6,
        periodo=$7,
        horas=$8,
        falta_atestado=$9,
        falta_sem_atestado=$10,
        obs=$11
      WHERE id=$12
    `, [
      t(r.escola) || null,
      t(r.matricula) || null,
      t(r.nome) || null,
      t(r.funcao) || null,
      t(r.vinculo) || null,
      t(r.carga) || null,
      t(r.periodo) || null,
      nInt(r.horas),
      nInt(r.falta_atestado),
      nInt(r.falta_sem_atestado),
      t(r.obs) || null,
      id
    ]);

    res.json({ ok: true });
  } catch (e) {
    console.log(e);
    res.status(500).json({ ok: false, error: "erro_editar" });
  }
});

// ===== APAGAR REGISTRO (SOMENTE ADM) =====
app.delete("/api/registros/:id", adminAuth, async (req, res) => {
  try {
    const id = req.params.id;
    await pool.query(`DELETE FROM public.registros WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.log(e);
    res.status(500).json({ ok: false, error: "erro_deletar" });
  }
});

// ===== START =====
const PORT = process.env.PORT || 10000;

ensureSchema()
  .then(() => {
    app.listen(PORT, () => console.log("✅ Servidor rodando na porta", PORT));
  })
  .catch((e) => {
    console.error("❌ Falha ao preparar o banco (ensureSchema):", e);
    process.exit(1);
  });
