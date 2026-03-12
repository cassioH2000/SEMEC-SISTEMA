import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const JWT_SECRET = process.env.JWT_SECRET || "";

// ================= BANCO =================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL?.includes("sslmode=")
    ? undefined
    : { rejectUnauthorized: false },
});

async function dbQuery(text, values = []) {
  return pool.query({ text, values, queryMode: "simple" });
}

// ================= CRIAR TABELAS =================
async function criarTabelas() {

  await dbQuery(`
    create table if not exists funcionarios(
      matricula text primary key,
      nome text,
      funcao text,
      vinculo text,
      carga text,
      escola text,
      lotacao text,
      seguimento text,
      categoria text,
      data_admissao date,
      atualizado_em timestamptz default now()
    )
  `);

  await dbQuery(`
    create table if not exists folhas(
      id bigserial primary key,
      periodo text not null,
      matricula text not null references funcionarios(matricula) on delete cascade,
      faltas int default 0,
      falta_com_atestado int default 0,
      horas_extras int default 0,
      observacoes text,
      atualizado_em timestamptz default now(),
      unique(periodo, matricula)
    )
  `);

  await dbQuery(`
    create table if not exists comentarios_gerais(
      id bigserial primary key,
      periodo text not null,
      lotacao text not null,
      comentario text not null,
      criado_em timestamptz default now()
    )
  `);

  console.log("✅ Banco pronto");
}

criarTabelas().catch(e => console.log(e));

// ================= STATIC =================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

// ================= HEALTH =================
app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

// ================= LOGIN =================
app.post("/api/login", (req, res) => {

  const pass = req.body?.password;

  if (pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok:false, error:"Senha inválida" });
  }

  const token = jwt.sign({ role:"admin" }, JWT_SECRET, { expiresIn:"7d" });

  res.json({ ok:true, token });

});

function requireAdmin(req,res,next){

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if(!token){
    return res.status(401).json({ ok:false });
  }

  try{
    const payload = jwt.verify(token, JWT_SECRET);
    if(payload.role !== "admin") throw new Error();
    next();
  }catch{
    res.status(401).json({ ok:false });
  }

}

// ================= LISTAR FUNCIONÁRIOS =================
app.get("/api/admin/funcionarios", requireAdmin, async(req,res)=>{

  try{

    const r = await dbQuery(`
      select
      matricula,
      nome,
      funcao,
      vinculo,
      carga,
      categoria,
      data_admissao,
      coalesce(lotacao, escola,'') as lotacao,
      coalesce(seguimento,'') as seguimento
      from funcionarios
      order by nome
    `);

    res.json({ ok:true, funcionarios:r.rows });

  }catch(e){
    console.log(e);
    res.status(500).json({ ok:false });
  }

});

// ================= CRIAR FUNCIONÁRIO =================
app.post("/api/admin/funcionarios", requireAdmin, async(req,res)=>{

  try{

    const b = req.body || {};

    const matricula = String(b.matricula||"").trim();
    const nome = String(b.nome||"");
    const funcao = String(b.funcao||"");
    const vinculo = String(b.vinculo||"");
    const carga = String(b.carga||"");
    const lotacao = String(b.lotacao||"");
    const seguimento = String(b.seguimento||"");
    const categoria = String(b.categoria||"");
    const data_admissao = b.data_admissao || null;

    const r = await dbQuery(`
      insert into funcionarios(
        matricula,nome,funcao,vinculo,carga,
        lotacao,seguimento,categoria,data_admissao
      )
      values($1,$2,$3,$4,$5,$6,$7,$8,$9)
      returning *
    `,
    [
      matricula,
      nome,
      funcao,
      vinculo,
      carga,
      lotacao,
      seguimento,
      categoria,
      data_admissao
    ]);

    res.json({ ok:true, funcionario:r.rows[0] });

  }catch(e){
    console.log(e);
    res.status(500).json({ ok:false });
  }

});

// ================= EDITAR FUNCIONÁRIO =================
app.put("/api/admin/funcionarios/:matricula", requireAdmin, async(req,res)=>{

  try{

    const matricula = req.params.matricula;
    const b = req.body || {};

    const r = await dbQuery(`
      update funcionarios
      set
        nome=$1,
        funcao=$2,
        vinculo=$3,
        carga=$4,
        lotacao=$5,
        seguimento=$6,
        categoria=$7,
        data_admissao=$8,
        atualizado_em=now()
      where matricula=$9
      returning *
    `,
    [
      b.nome,
      b.funcao,
      b.vinculo,
      b.carga,
      b.lotacao,
      b.seguimento,
      b.categoria,
      b.data_admissao,
      matricula
    ]);

    res.json({ ok:true, funcionario:r.rows[0] });

  }catch(e){
    console.log(e);
    res.status(500).json({ ok:false });
  }

});

// ================= EXCLUIR =================
app.delete("/api/admin/funcionarios/:matricula", requireAdmin, async(req,res)=>{

  try{

    const matricula = req.params.matricula;

    await dbQuery(
      `delete from funcionarios where matricula=$1`,
      [matricula]
    );

    res.json({ ok:true });

  }catch(e){
    console.log(e);
    res.status(500).json({ ok:false });
  }

});

// ================= CARREGAR MÊS =================
app.get("/api/admin/mes", requireAdmin, async(req,res)=>{

  try{

    const periodo = req.query.periodo;

    const r = await dbQuery(`
      select
      f.matricula,
      f.nome,
      f.funcao,
      f.vinculo,
      f.carga,
      f.categoria,
      f.data_admissao,
      coalesce(f.lotacao,f.escola,'') as lotacao,
      coalesce(f.seguimento,'') as seguimento,
      coalesce(fl.faltas,0) as faltas,
      coalesce(fl.falta_com_atestado,0) as falta_com_atestado,
      coalesce(fl.horas_extras,0) as horas_extras,
      coalesce(fl.observacoes,'') as observacoes
      from funcionarios f
      left join folhas fl
      on fl.matricula=f.matricula and fl.periodo=$1
      order by f.nome
    `,[periodo]);

    res.json({ ok:true, registros:r.rows });

  }catch(e){
    console.log(e);
    res.status(500).json({ ok:false });
  }

});

app.listen(PORT, ()=>{
  console.log("🚀 Servidor rodando na porta", PORT);
});
