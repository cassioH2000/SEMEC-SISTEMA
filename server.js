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
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const JWT_SECRET = process.env.JWT_SECRET;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function dbQuery(text, values = []) {
  return pool.query(text, values);
}

async function criarTabelas() {

  await dbQuery(`
    create table if not exists funcionarios(
      matricula text primary key,
      nome text,
      funcao text,
      vinculo text,
      carga text,
      lotacao text,
      seguimento text,
      categoria text,
      data_admissao date,
      obs_fixas text,
      atualizado_em timestamptz default now()
    )
  `);

  await dbQuery(`
    create table if not exists folhas(
      id bigserial primary key,
      periodo text not null,
      matricula text references funcionarios(matricula) on delete cascade,
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

  console.log("Banco pronto");

}

criarTabelas();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", async (req, res) => {

  try {

    await dbQuery("select 1");

    res.json({ ok: true });

  } catch {

    res.status(500).json({ ok: false });

  }

});

app.post("/api/login", (req, res) => {

  if (req.body.password !== ADMIN_PASSWORD)
    return res.status(401).json({ ok: false });

  const token = jwt.sign(
    { role: "admin" },
    JWT_SECRET,
    { expiresIn: "7d" }
  );

  res.json({ ok: true, token });

});

function requireAdmin(req, res, next) {

  try {

    const token = req.headers.authorization?.replace("Bearer ", "");

    const payload = jwt.verify(token, JWT_SECRET);

    if (payload.role !== "admin") throw "";

    next();

  } catch {

    res.status(401).json({ ok: false });

  }

}

app.get("/api/funcionarios", async (req, res) => {

  try {

    const r = await dbQuery(`
      select
        matricula,
        nome,
        funcao,
        vinculo,
        carga,
        categoria,
        data_admissao,
        obs_fixas,
        coalesce(lotacao,'SEMEC') as lotacao,
        coalesce(seguimento,'') as seguimento
      from funcionarios
      order by nome
    `);

    res.json({
      ok: true,
      funcionarios: r.rows
    });

  } catch {

    res.status(500).json({ ok: false });

  }

});

app.post("/api/folha/enviar", async (req, res) => {

  try {

    const b = req.body;

    await dbQuery(`
      insert into folhas(
        periodo,
        matricula,
        faltas,
        falta_com_atestado,
        horas_extras,
        observacoes
      )
      values($1,$2,$3,$4,$5,$6)
      on conflict(periodo, matricula)
      do update set
        faltas=excluded.faltas,
        falta_com_atestado=excluded.falta_com_atestado,
        horas_extras=excluded.horas_extras,
        observacoes=excluded.observacoes,
        atualizado_em=now()
    `,[
      b.periodo,
      b.matricula,
      b.faltas || 0,
      b.falta_com_atestado || 0,
      b.horas_extras || 0,
      b.observacoes || ""
    ]);

    res.json({ ok:true });

  } catch(e){

    console.log(e);

    res.status(500).json({ ok:false });

  }

});


app.get("/api/folha", async (req, res) => {

  try {

    const periodo = req.query.periodo;
    const lotacao = req.query.lotacao;

    const r = await dbQuery(`
      select
        fl.matricula,
        fl.faltas,
        fl.falta_com_atestado,
        fl.horas_extras,
        fl.observacoes
      from folhas fl
      inner join funcionarios f
        on f.matricula = fl.matricula
      where fl.periodo = $1
        and coalesce(f.lotacao,'SEMEC') = $2
    `,[periodo, lotacao]);

    res.json({
      ok:true,
      registros:r.rows
    });

  } catch(e){

    console.log(e);

    res.status(500).json({ ok:false });

  }

});


app.post("/api/folha/comentario", async (req, res) => {

  try {

    const b = req.body;

    await dbQuery(`
      insert into comentarios_gerais(
        periodo,
        lotacao,
        comentario
      )
      values($1,$2,$3)
    `,[
      b.periodo,
      b.lotacao,
      b.comentario
    ]);

    res.json({ ok:true });

  } catch {

    res.status(500).json({ ok:false });

  }

});


app.get("/api/admin/mes", requireAdmin, async (req, res) => {

  const periodo = req.query.periodo;

  const r = await dbQuery(`
    select
      f.*,
      coalesce(fl.faltas,0) faltas,
      coalesce(fl.falta_com_atestado,0) falta_com_atestado,
      coalesce(fl.horas_extras,0) horas_extras,
      coalesce(fl.observacoes,'') observacoes
    from funcionarios f
    left join folhas fl
      on fl.matricula = f.matricula
     and fl.periodo = $1
    order by f.nome
  `,[periodo]);

  res.json({
    ok:true,
    registros:r.rows
  });

});

// ================= ADMIN FUNCIONARIOS =================

// listar cadastro
app.get("/api/admin/funcionarios", requireAdmin, async (req,res)=>{

  const r = await dbQuery(`
    select
      matricula,
      nome,
      funcao,
      vinculo,
      carga,
      categoria,
      data_admissao,
      obs_fixas,
      coalesce(lotacao,'SEMEC') as lotacao,
      coalesce(seguimento,'') as seguimento
    from funcionarios
    order by nome
  `);

  res.json({
    ok:true,
    funcionarios:r.rows
  });

});


// criar funcionario
app.post("/api/admin/funcionarios", requireAdmin, async (req,res)=>{

  const b = req.body;

  await dbQuery(`
    insert into funcionarios(
      matricula,
      nome,
      funcao,
      vinculo,
      carga,
      lotacao,
      seguimento,
      categoria,
      data_admissao,
      obs_fixas
    )
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
  `,[
    b.matricula,
    b.nome,
    b.funcao,
    b.vinculo,
    b.carga,
    b.lotacao,
    b.seguimento,
    b.categoria,
    b.data_admissao,
    b.obs_fixas || ""
  ]);

  res.json({ ok:true });

});


// editar funcionario
app.put("/api/admin/funcionarios/:matricula", requireAdmin, async (req,res)=>{

  const b = req.body;
  const matricula = req.params.matricula;

  await dbQuery(`
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
      obs_fixas=$9,
      atualizado_em=now()
    where matricula=$10
  `,[
    b.nome,
    b.funcao,
    b.vinculo,
    b.carga,
    b.lotacao,
    b.seguimento,
    b.categoria,
    b.data_admissao,
    b.obs_fixas || "",
    matricula
  ]);

  res.json({ ok:true });

});


// excluir funcionario
app.delete("/api/admin/funcionarios/:matricula", requireAdmin, async (req,res)=>{

  await dbQuery(`
    delete from funcionarios
    where matricula=$1
  `,[req.params.matricula]);

  res.json({ ok:true });

});

app.listen(PORT, () => {

  console.log("Servidor rodando");

});
