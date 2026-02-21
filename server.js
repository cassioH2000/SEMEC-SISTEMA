import express from "express";
import pkg from "pg";
import cors from "cors";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// conexão postgres render/supabase
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// =============================
// CRIAR TABELAS AUTOMATICAMENTE
// =============================
async function ensureSchema() {
  try {

    await pool.query(`
      CREATE TABLE IF NOT EXISTS funcionarios (
        matricula TEXT PRIMARY KEY,
        nome TEXT,
        funcao TEXT,
        vinculo TEXT,
        carga TEXT,
        escola TEXT
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS folhas (
        id SERIAL PRIMARY KEY,
        matricula TEXT,
        nome TEXT,
        mes TEXT,
        ano TEXT,
        faltas INT DEFAULT 0,
        extras INT DEFAULT 0,
        obs TEXT,
        atualizado_em TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    console.log("Tabelas verificadas");
  } catch (err) {
    console.log("ERRO AO CRIAR TABELAS:", err);
    process.exit(1);
  }
}

await ensureSchema();

// =============================
// STATUS ONLINE
// =============================
app.get("/", (req,res)=>{
  res.send("SERVIDOR SEMEC ONLINE");
});

// =============================
// LISTAR FUNCIONÁRIOS (ADMIN)
// =============================
app.get("/api/admin/funcionarios", async (req,res)=>{
  try{
    const r = await pool.query(`
      SELECT * FROM funcionarios
      ORDER BY nome
    `);
    res.json(r.rows);
  }catch(err){
    console.log(err);
    res.status(500).json({erro:"erro ao buscar"});
  }
});

// =============================
// CADASTRAR FUNCIONÁRIO (ADMIN)
// =============================
app.post("/api/admin/funcionarios", async (req,res)=>{
  try{
    const { matricula,nome,funcao,vinculo,carga,escola } = req.body;

    await pool.query(`
      INSERT INTO funcionarios
      (matricula,nome,funcao,vinculo,carga,escola)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (matricula) DO NOTHING
    `,[matricula,nome,funcao,vinculo,carga,escola]);

    res.json({ok:true});
  }catch(err){
    console.log(err);
    res.status(500).json({erro:"erro salvar"});
  }
});

// =============================
// ENVIAR FOLHA
// =============================
app.post("/api/folha", async (req,res)=>{
  try{
    const { matricula,nome,mes,ano,faltas,extras,obs } = req.body;

    await pool.query(`
      INSERT INTO folhas
      (matricula,nome,mes,ano,faltas,extras,obs)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
    `,[matricula,nome,mes,ano,faltas,extras,obs]);

    res.json({ok:true});
  }catch(err){
    console.log(err);
    res.status(500).json({erro:"erro folha"});
  }
});

// =============================
// VER TODAS AS FOLHAS (ADMIN)
// =============================
app.get("/api/admin/folhas", async (req,res)=>{
  try{
    const r = await pool.query(`
      SELECT * FROM folhas
      ORDER BY id DESC
    `);
    res.json(r.rows);
  }catch(err){
    console.log(err);
    res.status(500).json({erro:"erro buscar folhas"});
  }
});

// =============================
// ADMIN EDITAR FOLHA
// =============================
app.put("/api/admin/folha/:id", async (req,res)=>{
  try{
    const { id } = req.params;
    const { faltas,extras,obs } = req.body;

    await pool.query(`
      UPDATE folhas
      SET faltas=$1,
          extras=$2,
          obs=$3,
          atualizado_em=NOW()
      WHERE id=$4
    `,[faltas,extras,obs,id]);

    res.json({ok:true});
  }catch(err){
    console.log(err);
    res.status(500).json({erro:"erro atualizar"});
  }
});

// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log("Servidor rodando na porta "+PORT));
