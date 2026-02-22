import express from "express";
import pkg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pkg;

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;

// ===== BANCO SUPABASE =====
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function dbQuery(q, params=[]){
  const client = await pool.connect();
  try{
    const r = await client.query(q, params);
    return r;
  }finally{
    client.release();
  }
}

// ===== CRIAR TABELAS =====
async function ensureSchema(){
  await dbQuery(`
    create table if not exists funcionarios (
      matricula text primary key,
      nome text,
      funcao text,
      vinculo text,
      carga text,
      escola text
    )
  `);

  await dbQuery(`
    create table if not exists folhas (
      id serial primary key,
      periodo text,
      matricula text,
      nome text,
      funcao text,
      vinculo text,
      carga text,
      escola text,
      faltas int default 0,
      falta_com_atestado int default 0,
      horas_extras int default 0,
      observacoes text,
      unique(periodo, matricula)
    )
  `);

  console.log("✅ Banco pronto");
}
ensureSchema();

// ========================================
// 🟢 LISTA FUNCIONÁRIOS PUBLICO (FOLHA)
// ========================================
app.get("/api/funcionarios", async (req,res)=>{
  try{
    const r = await dbQuery(`
      select matricula, nome, funcao, vinculo, carga, escola
      from funcionarios
      order by nome
    `);
    res.json({ ok:true, funcionarios:r.rows });
  }catch(e){
    console.log(e);
    res.status(500).json({ ok:false });
  }
});

// ========================================
// 🟢 ENVIAR FOLHA
// ========================================
app.post("/api/folha/enviar", async (req,res)=>{
  try{
    const b = req.body;

    const periodo = b.periodo;
    const matricula = b.matricula;

    if(!periodo || !matricula){
      return res.status(400).json({ ok:false, error:"Dados incompletos" });
    }

    const faltas = Number(b.faltas || 0);
    const faltaCom = Number(b.falta_com_atestado || 0);
    const he = Number(b.horas_extras || 0);

    await dbQuery(`
      insert into folhas
      (periodo, matricula, nome, funcao, vinculo, carga, escola,
       faltas, falta_com_atestado, horas_extras, observacoes)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      on conflict (periodo, matricula)
      do update set
      faltas=excluded.faltas,
      falta_com_atestado=excluded.falta_com_atestado,
      horas_extras=excluded.horas_extras,
      observacoes=excluded.observacoes
    `,[
      periodo,
      matricula,
      b.nome,
      b.funcao,
      b.vinculo,
      b.carga,
      b.escola,
      faltas,
      faltaCom,
      he,
      b.observacoes || ""
    ]);

    res.json({ ok:true });

  }catch(e){
    console.log(e);
    res.status(500).json({ ok:false });
  }
});

// ========================================
app.listen(PORT, ()=>{
  console.log("🚀 Servidor rodando na porta", PORT);
});
