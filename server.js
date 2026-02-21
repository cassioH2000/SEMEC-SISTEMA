import express from "express";
import pkg from "pg";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// =============================
// CONFIGURAR CAMINHO PUBLIC
// =============================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

// =============================
// BANCO
// =============================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// =============================
// CRIAR TABELAS AUTOMATICO
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

    console.log("Tabelas OK");
  } catch (err) {
    console.log("Erro no schema:", err);
    process.exit(1);
  }
}

await ensureSchema();

// =============================
// ROTAS HTML
// =============================

// Página principal
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Admin
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Folha
app.get("/folha", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "folha.html"));
});

// =============================
// API
// =============================

app.get("/api/admin/funcionarios", async (req,res)=>{
  const r = await pool.query("SELECT * FROM funcionarios ORDER BY nome");
  res.json(r.rows);
});

app.post("/api/folha", async (req,res)=>{
  const { matricula,nome,mes,ano,faltas,extras,obs } = req.body;

  await pool.query(`
    INSERT INTO folhas
    (matricula,nome,mes,ano,faltas,extras,obs)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
  `,[matricula,nome,mes,ano,faltas,extras,obs]);

  res.json({ok:true});
});

app.get("/api/admin/folhas", async (req,res)=>{
  const r = await pool.query("SELECT * FROM folhas ORDER BY id DESC");
  res.json(r.rows);
});

app.put("/api/admin/folha/:id", async (req,res)=>{
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
});

// =============================
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log("Servidor rodando"));
