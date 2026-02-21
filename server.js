const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   SERVIR HTML
========================= */
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* =========================
   CONEXÃO BANCO (SUPABASE)
========================= */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =========================
   CRIAR TABELA SE NÃO EXISTIR
========================= */
async function criarTabela() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS folhas (
      id SERIAL PRIMARY KEY,
      matricula TEXT,
      nome TEXT,
      funcao TEXT,
      escola TEXT DEFAULT 'SEMEC',
      mes TEXT,
      faltas INT DEFAULT 0,
      atestado INT DEFAULT 0,
      horas_extra INT DEFAULT 0,
      observacoes TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW(),
      atualizado_em BIGINT
    );
  `);
  console.log("TABELA OK");
}
criarTabela();

/* =========================
   LOGIN ADMIN
========================= */
app.post("/api/login", (req, res) => {
  const { senha } = req.body;

  if (senha === "Semec2026") {
    res.json({ ok: true });
  } else {
    res.status(401).json({ erro: "Senha inválida" });
  }
});

/* =========================
   LISTAR ADMIN (POR MÊS)
========================= */
app.get("/api/admin", async (req, res) => {
  try {
    const { mes } = req.query;

    const result = await pool.query(
      `SELECT * FROM folhas WHERE mes=$1 ORDER BY nome ASC`,
      [mes]
    );

    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* =========================
   CRIAR FUNCIONÁRIO NO MÊS
========================= */
app.post("/api/funcionario", async (req, res) => {
  try {
    const { matricula, nome, funcao, escola, mes } = req.body;

    const existe = await pool.query(
      "SELECT * FROM folhas WHERE matricula=$1 AND mes=$2",
      [matricula, mes]
    );

    if (existe.rows.length === 0) {
      await pool.query(`
        INSERT INTO folhas
        (matricula, nome, funcao, escola, mes, faltas, atestado, horas_extra, observacoes, atualizado_em)
        VALUES ($1,$2,$3,$4,$5,0,0,0,'', EXTRACT(EPOCH FROM NOW()))
      `, [matricula, nome, funcao, escola, mes]);
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* =========================
   ADMIN EDITAR
========================= */
app.put("/api/admin/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { faltas, atestado, horas_extra, observacoes } = req.body;

    await pool.query(`
      UPDATE folhas SET
        faltas=$1,
        atestado=$2,
        horas_extra=$3,
        observacoes=$4,
        atualizado_em=EXTRACT(EPOCH FROM NOW())
      WHERE id=$5
    `, [faltas, atestado, horas_extra, observacoes, id]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* =========================
   ATUALIZAR PELA FOLHA
========================= */
app.put("/api/folha/:matricula", async (req, res) => {
  try {
    const { matricula } = req.params;
    const { mes, faltas, atestado, horas_extra, observacoes } = req.body;

    await pool.query(`
      UPDATE folhas SET
        faltas=$1,
        atestado=$2,
        horas_extra=$3,
        observacoes=$4,
        atualizado_em=EXTRACT(EPOCH FROM NOW())
      WHERE matricula=$5 AND mes=$6
    `, [faltas, atestado, horas_extra, observacoes, matricula, mes]);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* =========================
   BUSCAR FUNCIONÁRIO
========================= */
app.get("/api/buscar", async (req, res) => {
  try {
    const { q, mes } = req.query;

    const result = await pool.query(`
      SELECT * FROM folhas
      WHERE mes=$1 AND (matricula ILIKE $2 OR nome ILIKE $2)
      ORDER BY nome
    `, [mes, `%${q}%`]);

    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

/* =========================
   START
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("SERVIDOR SEMEC ONLINE 🚀");
});
