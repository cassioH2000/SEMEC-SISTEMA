import express from "express";
import pkg from "pg";
import cors from "cors";
import jwt from "jsonwebtoken";

const { Pool } = pkg;

const app = express();
app.use(cors());
app.use(express.json());

/* ================================
   🔐 SENHA ADMIN
================================ */
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "123456";

/* ================================
   🗄️ CONEXÃO SUPABASE (CORRIGIDA)
================================ */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

/* ================================
   🔧 CRIAR TABELA AUTOMÁTICA
================================ */
async function ensureSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS registros (
        id SERIAL PRIMARY KEY,
        matricula TEXT,
        nome TEXT,
        escola TEXT,
        funcao TEXT,
        carga TEXT,
        horasExtras TEXT,
        faltas TEXT,
        observacao TEXT,
        mes TEXT,
        criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log("Banco pronto");
  } catch (err) {
    console.log("Erro banco:", err);
  }
}
ensureSchema();

/* ================================
   🔐 LOGIN ADMIN
================================ */
app.post("/api/login", (req, res) => {
  const { senha } = req.body;

  if (senha !== ADMIN_PASSWORD) {
    return res.status(401).json({ erro: "Senha inválida" });
  }

  const token = jwt.sign({ admin: true }, "segredo", {
    expiresIn: "8h",
  });

  res.json({ token });
});

/* ================================
   🔒 MIDDLEWARE TOKEN
================================ */
function verificarToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return res.status(403).json({ erro: "Sem token" });

  const token = auth.split(" ")[1];

  try {
    jwt.verify(token, "segredo");
    next();
  } catch {
    res.status(403).json({ erro: "Token inválido" });
  }
}

/* ================================
   📩 ENVIAR DA FOLHA
================================ */
app.post("/api/enviar", async (req, res) => {
  try {
    const {
      matricula,
      nome,
      escola,
      funcao,
      carga,
      horasExtras,
      faltas,
      observacao,
      mes,
    } = req.body;

    await pool.query(
      `
      INSERT INTO registros
      (matricula,nome,escola,funcao,carga,horasExtras,faltas,observacao,mes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      `,
      [
        matricula,
        nome,
        escola,
        funcao,
        carga,
        horasExtras,
        faltas,
        observacao,
        mes,
      ]
    );

    res.json({ ok: true });
  } catch (err) {
    console.log(err);
    res.status(500).json({ erro: "Erro ao salvar" });
  }
});

/* ================================
   📊 VER REGISTROS ADMIN
================================ */
app.get("/api/registros", verificarToken, async (req, res) => {
  try {
    const { mes, escola } = req.query;

    let query = "SELECT * FROM registros WHERE 1=1";
    let valores = [];

    if (mes) {
      valores.push(mes);
      query += ` AND mes=$${valores.length}`;
    }

    if (escola && escola !== "Todas") {
      valores.push(escola);
      query += ` AND escola=$${valores.length}`;
    }

    query += " ORDER BY nome";

    const result = await pool.query(query, valores);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao buscar" });
  }
});

/* ================================
   🗑️ APAGAR REGISTRO
================================ */
app.delete("/api/apagar/:id", verificarToken, async (req, res) => {
  try {
    await pool.query("DELETE FROM registros WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ erro: "Erro ao apagar" });
  }
});

/* ================================
   ✏️ EDITAR REGISTRO
================================ */
app.put("/api/editar/:id", verificarToken, async (req, res) => {
  try {
    const { horasExtras, faltas, observacao } = req.body;

    await pool.query(
      `
      UPDATE registros SET
      horasExtras=$1,
      faltas=$2,
      observacao=$3
      WHERE id=$4
      `,
      [horasExtras, faltas, observacao, req.params.id]
    );

    res.json({ ok: true });
  } catch {
    res.status(500).json({ erro: "Erro ao editar" });
  }
});

/* ================================
   🚀 SERVIDOR
================================ */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Servidor rodando"));
