import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pkg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

// ================= BANCO =================
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function dbQuery(q, params=[]){
  const r = await pool.query(q, params);
  return r;
}

// ================= TABELAS =================
async function criarTabelas(){
  await dbQuery(`
  create table if not exists funcionarios(
    matricula text primary key,
    nome text,
    funcao text,
    vinculo text,
    carga text,
    escola text
  )
  `);

  await dbQuery(`
  create table if not exists folhas(
    id serial primary key,
    periodo text,
    matricula text,
    faltas int default 0,
    falta_com_atestado int default 0,
    horas_extras int default 0,
    observacoes text,
    unique(periodo, matricula)
  )
  `);

  console.log("✅ Banco pronto");
}
criarTabelas();

// ================= LOGIN ADMIN =================
app.post("/api/login",(req,res)=>{
  if(req.body.password !== ADMIN_PASSWORD){
    return res.status(401).json({ok:false});
  }
  const token = jwt.sign({admin:true}, JWT_SECRET);
  res.json({ok:true, token});
});

function requireAdmin(req,res,next){
  const auth = req.headers.authorization;
  if(!auth) return res.status(401).json({ok:false});

  const token = auth.split(" ")[1];
  try{
    jwt.verify(token, JWT_SECRET);
    next();
  }catch{
    res.status(401).json({ok:false});
  }
}

// ================= FUNCIONARIOS PUBLICO (FOLHA) =================
app.get("/api/funcionarios", async (req,res)=>{
  try{
    const r = await dbQuery(`
      select matricula,nome,funcao,vinculo,carga,escola
      from funcionarios
      order by nome
    `);
    res.json({ok:true, funcionarios:r.rows});
  }catch(e){
    console.log(e);
    res.status(500).json({ok:false});
  }
});

// ================= ENVIAR FOLHA =================
app.post("/api/folha/enviar", async (req,res)=>{
  try{
    const b = req.body;

    const periodo = b.periodo;
    const matricula = b.matricula;

    if(!periodo || !matricula){
      return res.status(400).json({ok:false});
    }

    const faltas = Number(b.faltas||0);
    const faltaCom = Number(b.falta_com_atestado||0);
    const he = Number(b.horas_extras||0);

    // garante funcionario cadastrado
    await dbQuery(`
    insert into funcionarios(matricula,nome,funcao,vinculo,carga,escola)
    values($1,$2,$3,$4,$5,$6)
    on conflict(matricula) do nothing
    `,[matricula,b.nome,b.funcao,b.vinculo,b.carga,b.escola]);

    // grava folha
    await dbQuery(`
    insert into folhas(
      periodo,matricula,faltas,falta_com_atestado,horas_extras,observacoes
    )
    values($1,$2,$3,$4,$5,$6)
    on conflict(periodo,matricula)
    do update set
      faltas=excluded.faltas,
      falta_com_atestado=excluded.falta_com_atestado,
      horas_extras=excluded.horas_extras,
      observacoes=excluded.observacoes
    `,[
      periodo,
      matricula,
      faltas,
      faltaCom,
      he,
      b.observacoes||""
    ]);

    res.json({ok:true});
  }catch(e){
    console.log(e);
    res.status(500).json({ok:false});
  }
});

// ================= ADMIN LISTAR FUNCIONARIOS =================
app.get("/api/admin/funcionarios", requireAdmin, async (req,res)=>{
  const r = await dbQuery("select * from funcionarios order by nome");
  res.json({ok:true, funcionarios:r.rows});
});

// ================= ADMIN MES =================
app.get("/api/admin/mes", requireAdmin, async (req,res)=>{
  const periodo = req.query.periodo;

  const r = await dbQuery(`
  select 
    f.escola,
    f.matricula,
    f.nome,
    f.funcao,
    f.vinculo,
    f.carga,
    $1 as periodo,
    coalesce(fl.faltas,0) faltas,
    coalesce(fl.falta_com_atestado,0) falta_com_atestado,
    coalesce(fl.horas_extras,0) horas_extras,
    coalesce(fl.observacoes,'') observacoes
  from funcionarios f
  left join folhas fl
  on fl.matricula=f.matricula and fl.periodo=$1
  order by f.nome
  `,[periodo]);

  // 🔴 IMPORTANTE: admin.html usa REGISTROS
  res.json({ok:true, registros:r.rows});
});

// ================= STATIC =================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname,"public")));

app.listen(PORT, ()=>console.log("🚀 Servidor ON"));
