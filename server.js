require("dotenv").config()
const express = require("express")
const cors = require("cors")
const { Pool } = require("pg")

const app = express()
app.use(cors())
app.use(express.json())
app.use(express.static("public"))

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

/* ===========================
   CRIAR TABELAS SE NÃO EXISTIREM
=========================== */

async function criarTabelas() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS funcionarios (
      matricula VARCHAR(20) PRIMARY KEY,
      nome TEXT,
      funcao TEXT
    )
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS folhas (
      id SERIAL PRIMARY KEY,
      matricula VARCHAR(20),
      mes VARCHAR(20),
      faltas INTEGER DEFAULT 0,
      atestados INTEGER DEFAULT 0,
      horas_extras INTEGER DEFAULT 0,
      observacoes TEXT DEFAULT '',
      UNIQUE (matricula, mes)
    )
  `)

  console.log("Tabelas verificadas ✅")
}

criarTabelas()

/* ===========================
   LISTAR FUNCIONÁRIOS
=========================== */

app.get("/api/funcionarios", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM funcionarios ORDER BY nome ASC"
    )
    res.json(result.rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ erro: "Erro ao buscar funcionários" })
  }
})

/* ===========================
   CARREGAR FOLHA DO MÊS
=========================== */

app.get("/api/folhas/:mes", async (req, res) => {
  const mes = req.params.mes

  try {
    const result = await pool.query(`
      SELECT f.matricula, f.nome, f.funcao,
      COALESCE(fl.faltas,0) as faltas,
      COALESCE(fl.atestados,0) as atestados,
      COALESCE(fl.horas_extras,0) as horas_extras,
      COALESCE(fl.observacoes,'') as observacoes
      FROM funcionarios f
      LEFT JOIN folhas fl
      ON f.matricula = fl.matricula AND fl.mes = $1
      ORDER BY f.nome ASC
    `, [mes])

    res.json(result.rows)
  } catch (err) {
    console.error(err)
    res.status(500).json({ erro: "Erro ao carregar folha" })
  }
})

/* ===========================
   SALVAR OU ATUALIZAR FOLHA
=========================== */

app.post("/api/folhas", async (req, res) => {
  const { matricula, mes, faltas, atestados, horas_extras, observacoes } = req.body

  try {
    await pool.query(`
      INSERT INTO folhas (matricula, mes, faltas, atestados, horas_extras, observacoes)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (matricula, mes)
      DO UPDATE SET
        faltas = EXCLUDED.faltas,
        atestados = EXCLUDED.atestados,
        horas_extras = EXCLUDED.horas_extras,
        observacoes = EXCLUDED.observacoes
    `, [matricula, mes, faltas, atestados, horas_extras, observacoes])

    res.json({ sucesso: true })
  } catch (err) {
    console.error(err)
    res.status(500).json({ erro: "Erro ao salvar folha" })
  }
})

/* ===========================
   LOGIN ADMIN SIMPLES
=========================== */

app.post("/api/login", (req, res) => {
  const { senha } = req.body

  if (senha === process.env.ADMIN_PASSWORD) {
    return res.json({ sucesso: true })
  }

  res.status(401).json({ erro: "Senha incorreta" })
})

/* ===========================
   SERVIDOR
=========================== */

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log("Servidor rodando na porta " + PORT)
})
