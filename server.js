import express from "express";
import pkg from "pg";
import cors from "cors";
import jwt from "jsonwebtoken";

const { Pool } = pkg;
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 10000;

/* ===============================
   CONEXÃO SUPABASE (CORRIGIDO SSL)
================================ */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* ===============================
   TESTE SERVIDOR
================================ */
app.get("/", (req, res) => {
  res.send("SERVIDOR SEMEC ONLINE 🚀");
});

/* ===============================
   LOGIN ADMIN
================================ */
app.post("/api/login", (req, res) => {
  const { senha } = req.body;

  if (senha === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ admin: true }, "semec123", { expiresIn: "8h" });
    return res.json({ token });
  }

  res.status(401).json({ erro: "Senha inválida" });
});

/* ===============================
   SALVAR REGISTRO
================================ */
app.post("/api/enviar", async (req, res) => {
  try {
    const { nome, escola, horas, data } = req.body;

    await pool.query(`
      INSERT INTO registros (nome, escola, horas, data)
      VALUES ($1,$2,$3,$4)
    `, [nome, escola, horas, data]);

    res.json({ ok: true });
  } catch (err) {
    console.log("Erro salvar:", err);
    res.status(500).json({ erro: "Erro ao salvar" });
  }
});

/* ===============================
   BALANÇO GERAL
================================ */
app.get("/api/registros", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT * FROM registros
      ORDER BY data DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.log("Erro buscar:", err);
    res.status(500).json({ erro: "Erro ao buscar" });
  }
});

/* ===============================
   INICIAR
================================ */
app.listen(PORT, () => {
  console.log("Servidor rodando na porta", PORT);
});
