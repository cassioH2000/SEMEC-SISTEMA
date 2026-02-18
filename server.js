import express from "express";
import cors from "cors";
import pkg from "pg";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

// ===== SERVIR HTML DA PASTA PUBLIC =====
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// ===== BANCO SUPABASE =====
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ===== TESTE ONLINE =====
app.get("/health", (req,res)=>{
  res.json({ok:true, status:"servidor online"});
});

// ===== LOGIN ADMIN =====
app.post("/api/login", (req,res)=>{
  const { senha } = req.body;
  if(senha === process.env.ADMIN_PASSWORD){
    res.json({ok:true});
  } else {
    res.status(401).json({ok:false});
  }
});

// ===== RECEBER RELATÓRIOS DA FOLHA =====
app.post("/api/enviar", async (req,res)=>{
  try{
    const dados = req.body;

    for(let r of dados){
      await pool.query(`
        INSERT INTO registros 
        (matricula,nome,funcao,vinculo,carga,periodo,horas,falta_atestado,falta_sem_atestado,obs)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      `,[
        r.matricula,
        r.nome,
        r.funcao,
        r.vinculo,
        r.carga,
        r.periodo,
        r.horas,
        r.faltaA,
        r.faltaS,
        r.obs
      ]);
    }

    res.json({ok:true});
  }catch(e){
    console.log(e);
    res.status(500).json({erro:"erro ao salvar"});
  }
});

// ===== LISTAR REGISTROS ADM =====
app.get("/api/registros", async (req,res)=>{
  try{
    const r = await pool.query("SELECT * FROM registros ORDER BY id DESC");
    res.json(r.rows);
  }catch(e){
    res.status(500).json({erro:"erro banco"});
  }
});

// ===== RESUMO POR MATRÍCULA =====
app.get("/api/resumo/:mat", async (req,res)=>{
  const mat = req.params.mat;

  const r = await pool.query(`
    SELECT 
    nome,
    SUM(horas) horas,
    SUM(falta_atestado) falta_atestado,
    SUM(falta_sem_atestado) falta_sem_atestado
    FROM registros
    WHERE matricula=$1
    GROUP BY nome
  `,[mat]);

  res.json(r.rows[0] || {});
});

// ===== PORTA RENDER =====
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>{
  console.log("Servidor rodando na porta", PORT);
});
