import express from "express";
import cors from "cors";
import pkg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// ===== SERVIR A PASTA PUBLIC =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// ===== BANCO (SUPABASE) =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== HEALTH =====
app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== LOGIN ADM =====
// Guarda tokens válidos em memória (reinicia quando o Render reinicia)
const adminTokens = new Set();

function adminAuth(req, res, next){
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if(!token || !adminTokens.has(token)) {
    return res.status(401).json({ ok:false, error:"unauthorized" });
  }
  next();
}

// LOGIN ADM (agora retorna token)
app.post("/api/login", (req, res) => {
  const { senha } = req.body || {};
  if (senha !== process.env.ADMIN_PASSWORD) return res.status(401).json({ ok: false });

  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  adminTokens.add(token);

  return res.json({ ok: true, token });
});

});

// ===== GARANTE COLUNAS (seguro) =====
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS registros (
      id BIGSERIAL PRIMARY KEY,
      escola TEXT,
      matricula TEXT,
      nome TEXT,
      funcao TEXT,
      vinculo TEXT,
      carga TEXT,
      periodo TEXT,
      horas INT DEFAULT 0,
      falta_atestado INT DEFAULT 0,
      falta_sem_atestado INT DEFAULT 0,
      obs TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);

  // se a tabela já existia, garante colunas novas
  await pool.query(`ALTER TABLE registros ADD COLUMN IF NOT EXISTS escola TEXT;`);
  await pool.query(`ALTER TABLE registros ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();`);
}

function nInt(v) {
  const x = Number(v);
  return Number.isFinite(x) ? Math.trunc(x) : 0;
}

// ===== NOVO ENDPOINT (RECOMENDADO): /api/reports =====
// Body: { source: "Escola X", records: [...] }
app.post("/api/reports", async (req, res) => {
  try {
    const { source, records } = req.body || {};
    if (!source || !Array.isArray(records)) return res.status(400).json({ error: "bad_payload" });

    const escola = String(source).trim();

    const ins = `
      INSERT INTO registros
      (escola, matricula, nome, funcao, vinculo, carga, periodo, horas, falta_atestado, falta_sem_atestado, obs)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `;

    for (const r of records) {
      await pool.query(ins, [
        escola,
        String(r.matricula ?? ""),
        String(r.nome ?? ""),
        String(r.funcao ?? ""),
        String(r.vinculo ?? ""),
        String(r.carga ?? ""),
        String(r.period ?? r.periodo ?? ""),
        nInt(r.horas_extras ?? r.horas ?? 0),
        nInt(r.falta_atestado ?? r.faltaA ?? 0),
        nInt(r.falta_sem_atestado ?? r.faltaS ?? 0),
        String(r.obs ?? "")
      ]);
    }

    res.json({ ok: true });
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: "db_error", detail: String(e?.message || e) });
  }
});

// ===== COMPATÍVEL COM O ANTIGO: /api/enviar =====
// Body: array de registros (sem escola) -> salva escola="(sem escola)"
app.post("/api/enviar", async (req, res) => {
  try {
    const dados = req.body;
    if (!Array.isArray(dados)) return res.status(400).json({ error: "bad_payload" });

    const ins = `
      INSERT INTO registros
      (escola, matricula, nome, funcao, vinculo, carga, periodo, horas, falta_atestado, falta_sem_atestado, obs)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    `;

    for (const r of dados) {
      await pool.query(ins, [
        "(sem escola)",
        String(r.matricula ?? ""),
        String(r.nome ?? ""),
        String(r.funcao ?? ""),
        String(r.vinculo ?? ""),
        String(r.carga ?? ""),
        String(r.periodo ?? ""),
        nInt(r.horas ?? 0),
        nInt(r.faltaA ?? 0),
        nInt(r.faltaS ?? 0),
        String(r.obs ?? "")
      ]);
    }

    res.json({ ok: true });
  } catch (e) {
    console.log(e);
    res.status(500).json({ erro: "erro ao salvar" });
  }
});

// ===== LISTAR REGISTROS (ADM) - com filtros opcionais =====
app.get("/api/registros", async (req, res) => {
  try {
    const periodo = req.query.periodo ? String(req.query.periodo) : null;
    const escola = req.query.escola ? String(req.query.escola) : null;

    const where = [];
    const params = [];
    if (periodo) { params.push(periodo); where.push(`periodo = $${params.length}`); }
    if (escola) { params.push(escola); where.push(`escola = $${params.length}`); }

    const sql = `
      SELECT * FROM registros
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY id DESC
    `;

    const r = await pool.query(sql, params);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ erro: "erro banco" });
  }
});

// ===== BALANÇO GERAL =====
app.get("/api/balanco/geral", async (req, res) => {
  try {
    const periodo = req.query.periodo ? String(req.query.periodo) : null;

    const sql = periodo
      ? `
        SELECT
          COUNT(*)::int AS registros,
          COALESCE(SUM(horas),0)::int AS horas,
          COALESCE(SUM(falta_atestado),0)::int AS falta_atestado,
          COALESCE(SUM(falta_sem_atestado),0)::int AS falta_sem_atestado
        FROM registros
        WHERE periodo = $1
      `
      : `
        SELECT
          COUNT(*)::int AS registros,
          COALESCE(SUM(horas),0)::int AS horas,
          COALESCE(SUM(falta_atestado),0)::int AS falta_atestado,
          COALESCE(SUM(falta_sem_atestado),0)::int AS falta_sem_atestado
        FROM registros
      `;

    const r = periodo ? await pool.query(sql, [periodo]) : await pool.query(sql);
    const row = r.rows[0] || { registros: 0, horas: 0, falta_atestado: 0, falta_sem_atestado: 0 };
    res.json({ ...row, total_faltas: row.falta_atestado + row.falta_sem_atestado });
  } catch (e) {
    res.status(500).json({ error: "erro_balanco" });
  }
});

// ===== BALANÇO POR ESCOLA =====
app.get("/api/balanco/escolas", async (req, res) => {
  try {
    const periodo = req.query.periodo ? String(req.query.periodo) : null;

    const sql = periodo
      ? `
        SELECT
          COALESCE(escola,'(sem escola)') AS escola,
          COUNT(*)::int AS registros,
          COALESCE(SUM(horas),0)::int AS horas,
          COALESCE(SUM(falta_atestado),0)::int AS falta_atestado,
          COALESCE(SUM(falta_sem_atestado),0)::int AS falta_sem_atestado
        FROM registros
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
        FROM registros
        GROUP BY COALESCE(escola,'(sem escola)')
        ORDER BY escola ASC
      `;

    const r = periodo ? await pool.query(sql, [periodo]) : await pool.query(sql);
    res.json({ escolas: r.rows });
  } catch (e) {
    res.status(500).json({ error: "erro_escolas" });
  }
});

// ===== RESUMO POR MATRÍCULA =====
app.get("/api/resumo/:mat", async (req, res) => {
  try {
    const mat = String(req.params.mat || "").trim();
    const r = await pool.query(`
      SELECT
        MAX(nome) AS nome,
        MAX(funcao) AS funcao,
        MAX(vinculo) AS vinculo,
        MAX(carga) AS carga,
        COALESCE(SUM(horas),0)::int AS horas,
        COALESCE(SUM(falta_atestado),0)::int AS falta_atestado,
        COALESCE(SUM(falta_sem_atestado),0)::int AS falta_sem_atestado
      FROM registros
      WHERE matricula = $1
    `, [mat]);

    res.json(r.rows[0] || {});
  } catch (e) {
    res.status(500).json({ error: "erro_resumo" });
  }
});
// ===== RELATÓRIO GERAL (todas as escolas juntas, consolidado por funcionário) =====
// /api/relatorio/geral?periodo=YYYY-MM   (opcional)
// Retorna 1 linha por matrícula (funcionário)
app.get("/api/relatorio/geral", async (req, res) => {
  try {
    const periodo = req.query.periodo ? String(req.query.periodo) : null;

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
        FROM registros
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
        FROM registros
        GROUP BY matricula
        ORDER BY nome ASC NULLS LAST
      `;

    const r = periodo ? await pool.query(sql, [periodo]) : await pool.query(sql);
    res.json({ periodo: periodo || null, rows: r.rows });
  } catch (e) {
    console.log(e);
    res.status(500).json({ error: "erro_relatorio_geral" });
  }
});

// ===== EDITAR REGISTRO =====
app.put("/api/registros/:id", async (req,res)=>{
  try{
    const id = req.params.id;
    const r = req.body;

    await pool.query(`
      UPDATE registros SET
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
    `,[
      r.escola,
      r.matricula,
      r.nome,
      r.funcao,
      r.vinculo,
      r.carga,
      r.periodo,
      r.horas,
      r.falta_atestado,
      r.falta_sem_atestado,
      r.obs,
      id
    ]);

    res.json({ok:true});
  }catch(e){
    res.status(500).json({erro:"erro editar"});
  }
});


// ===== APAGAR REGISTRO =====
app.delete("/api/registros/:id", async (req,res)=>{
  try{
    const id = req.params.id;
    await pool.query("DELETE FROM registros WHERE id=$1",[id]);
    res.json({ok:true});
  }catch(e){
    res.status(500).json({erro:"erro deletar"});
  }
});
// Guarda em memória tokens válidos (reinicia quando o serviço reinicia)
const adminTokens = new Set();

function adminAuth(req, res, next){
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  if(!token || !adminTokens.has(token)) return res.status(401).json({ ok:false, error:"unauthorized" });
  next();
}

// LOGIN ADM (substitua seu /api/login por este)
app.post("/api/login", (req, res) => {
  const { senha } = req.body || {};
  if (senha !== process.env.ADMIN_PASSWORD) return res.status(401).json({ ok: false });

  // token aleatório simples
  const token = Math.random().toString(36).slice(2) + Date.now().toString(36);
  adminTokens.add(token);
  return res.json({ ok: true, token });
});

// ===== EDITAR REGISTRO (somente ADM) =====
app.put("/api/registros/:id", adminAuth, async (req,res)=>{
  try{
    const id = req.params.id;
    const r = req.body || {};

    await pool.query(`
      UPDATE registros SET
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
    `,[
      r.escola ?? null,
      r.matricula ?? null,
      r.nome ?? null,
      r.funcao ?? null,
      r.vinculo ?? null,
      r.carga ?? null,
      r.periodo ?? null,
      Number(r.horas ?? 0) || 0,
      Number(r.falta_atestado ?? 0) || 0,
      Number(r.falta_sem_atestado ?? 0) || 0,
      r.obs ?? null,
      id
    ]);

    res.json({ok:true});
  }catch(e){
    console.log(e);
    res.status(500).json({ok:false, erro:"erro editar"});
  }
});

// ===== APAGAR REGISTRO (somente ADM) =====
app.delete("/api/registros/:id", adminAuth, async (req,res)=>{
  try{
    const id = req.params.id;
    await pool.query("DELETE FROM registros WHERE id=$1",[id]);
    res.json({ok:true});
  }catch(e){
    console.log(e);
    res.status(500).json({ok:false, erro:"erro deletar"});
  }
});



// ===== START =====
const PORT = process.env.PORT || 10000;
ensureSchema().then(() => {
  app.listen(PORT, () => console.log("Servidor rodando na porta", PORT));
});





