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
  ssl: DATABASE_URL?.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
});

// evita prepared statements (supabase pooler pode reclamar)
async function dbQuery(text, values = []) {
  return pool.query({ text, values, queryMode: "simple" });
}

// ================= TABELAS + MIGRAÇÃO =================
async function criarTabelas() {
  await dbQuery(`
    create table if not exists funcionarios(
      matricula text primary key,
      nome text,
      funcao text,
      vinculo text,
      carga text,
      escola text,
      atualizado_em timestamptz default now()
    )
  `);

  await dbQuery(`
    create table if not exists folhas(
      id bigserial primary key,
      periodo text not null,
      matricula text not null references funcionarios(matricula) on delete cascade,
      faltas int default 0,
      falta_sem_atestado int default 0,
      horas_extras int default 0,
      observacoes text,
      atualizado_em timestamptz default now(),
      unique(periodo, matricula)
    )
  `);

  // ✅ novo campo (sem quebrar nada antigo)
  await dbQuery(`alter table folhas add column if not exists falta_com_atestado int default 0;`);

  console.log("✅ Banco pronto");
}
criarTabelas().catch((e) => console.log("❌ criarTabelas erro:", e));

// ================= STATIC =================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, "public")));

// ================= LOGIN ADMIN =================
app.post("/api/login", (req, res) => {
  const pass = req.body?.password;
  if (!ADMIN_PASSWORD || !JWT_SECRET) {
    return res.status(500).json({ ok: false, error: "Falta ADMIN_PASSWORD/JWT_SECRET no Render." });
  }
  if (pass !== ADMIN_PASSWORD) {
    return res.status(401).json({ ok: false, error: "Senha inválida" });
  }
  const token = jwt.sign({ role: "admin" }, JWT_SECRET, { expiresIn: "7d" });
  return res.json({ ok: true, token });
});

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Sem token" });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload?.role !== "admin") return res.status(403).json({ ok: false, error: "Acesso negado" });
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Token inválido" });
  }
}

// ================= FUNCIONÁRIOS PÚBLICO (FOLHA) =================
app.get("/api/funcionarios", async (req, res) => {
  try {
    const r = await dbQuery(`
      select matricula, nome, funcao, vinculo, carga, escola
      from funcionarios
      order by nome nulls last, matricula
    `);
    res.json({ ok: true, funcionarios: r.rows });
  } catch (e) {
    console.log(e);
    res.status(500).json({ ok: false, error: e?.message || "Erro interno" });
  }
});

// ================= ENVIAR FOLHA =================
app.post("/api/folha/enviar", async (req, res) => {
  try {
    const b = req.body || {};
    const periodo = String(b.periodo || "").trim();
    const matricula = String(b.matricula || "").trim();

    if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
      return res.status(400).json({ ok: false, error: "Período inválido (use YYYY-MM)" });
    }
    if (!matricula) return res.status(400).json({ ok: false, error: "Matrícula obrigatória" });

    const faltas = Number.isFinite(+b.faltas) ? +b.faltas : 0;
    const faltaCom = Number.isFinite(+b.falta_com_atestado)
      ? +b.falta_com_atestado
      : (Number.isFinite(+b.falta_sem_atestado) ? +b.falta_sem_atestado : 0);

    const he = Number.isFinite(+b.horas_extras) ? +b.horas_extras : 0;
    const obs = (b.observacoes ?? "").toString();

    // garante que funcionário existe (não altera cadastro do admin se já existir)
    await dbQuery(
      `
      insert into funcionarios(matricula, nome, funcao, vinculo, carga, escola, atualizado_em)
      values($1,$2,$3,$4,$5,$6, now())
      on conflict(matricula) do update set
        atualizado_em = now()
      `,
      [matricula, b.nome ?? null, b.funcao ?? null, b.vinculo ?? null, b.carga ?? null, b.escola ?? null]
    );

    // ✅ IMPORTANTE: NÃO repetir o mesmo parâmetro ($4) para evitar "inconsistent types"
    await dbQuery(
      `
      insert into folhas(
        periodo, matricula,
        faltas, falta_com_atestado, falta_sem_atestado,
        horas_extras, observacoes, atualizado_em
      )
      values($1,$2,$3,$4,$5,$6,$7, now())
      on conflict(periodo, matricula)
      do update set
        faltas=excluded.faltas,
        falta_com_atestado=excluded.falta_com_atestado,
        falta_sem_atestado=excluded.falta_sem_atestado,
        horas_extras=excluded.horas_extras,
        observacoes=excluded.observacoes,
        atualizado_em=now()
      `,
      [periodo, matricula, faltas, faltaCom, faltaCom, he, obs]
    );

    res.json({ ok: true });
  } catch (e) {
    console.log(e);
    res.status(500).json({ ok: false, error: e?.message || "Erro interno" });
  }
});

// ================= ADMIN: LISTAR FUNCIONÁRIOS =================
app.get("/api/admin/funcionarios", requireAdmin, async (req, res) => {
  try {
    const r = await dbQuery(`
      select matricula, nome, funcao, vinculo, carga, escola, atualizado_em
      from funcionarios
      order by nome nulls last, matricula
    `);
    res.json({ ok: true, funcionarios: r.rows });
  } catch (e) {
    console.log(e);
    res.status(500).json({ ok: false, error: e?.message || "Erro interno" });
  }
});

// ================= ✅ ADMIN: EDITAR FUNCIONÁRIO (ERA O QUE FALTAVA) =================
app.put("/api/admin/funcionarios/:matricula", requireAdmin, async (req, res) => {
  try {
    const matricula = String(req.params.matricula || "").trim();
    if (!matricula) return res.status(400).json({ ok: false, error: "Matrícula inválida" });

    const b = req.body || {};
    const nome = (b.nome ?? "").toString();
    const funcao = (b.funcao ?? "").toString();
    const vinculo = (b.vinculo ?? "").toString();
    const carga = (b.carga ?? "").toString();
    const escola = (b.escola ?? "").toString();

    const r = await dbQuery(
      `
      insert into funcionarios(matricula, nome, funcao, vinculo, carga, escola, atualizado_em)
      values($1,$2,$3,$4,$5,$6, now())
      on conflict(matricula) do update set
        nome=excluded.nome,
        funcao=excluded.funcao,
        vinculo=excluded.vinculo,
        carga=excluded.carga,
        escola=excluded.escola,
        atualizado_em=now()
      returning matricula, nome, funcao, vinculo, carga, escola, atualizado_em
      `,
      [matricula, nome, funcao, vinculo, carga, escola]
    );

    res.json({ ok: true, funcionario: r.rows[0] });
  } catch (e) {
    console.log(e);
    res.status(500).json({ ok: false, error: e?.message || "Erro interno" });
  }
});

// ================= ADMIN: CARREGAR MÊS (admin.html usa "registros") =================
app.get("/api/admin/mes", requireAdmin, async (req, res) => {
  try {
    const periodo = String(req.query.periodo || "").trim();
    if (!periodo || !/^\d{4}-\d{2}$/.test(periodo)) {
      return res.status(400).json({ ok: false, error: "Período inválido (use YYYY-MM)" });
    }

    const r = await dbQuery(
      `
      select 
        f.escola,
        f.matricula,
        f.nome,
        f.funcao,
        f.vinculo,
        f.carga,
        $1 as periodo,
        coalesce(fl.faltas,0) as faltas,
        coalesce(fl.falta_com_atestado, fl.falta_sem_atestado, 0) as falta_com_atestado,
        coalesce(fl.horas_extras,0) as horas_extras,
        coalesce(fl.observacoes,'') as observacoes
      from funcionarios f
      left join folhas fl
        on fl.matricula=f.matricula and fl.periodo=$1
      order by f.nome nulls last, f.matricula
      `,
      [periodo]
    );

    res.json({ ok: true, registros: r.rows });
  } catch (e) {
    console.log(e);
    res.status(500).json({ ok: false, error: e?.message || "Erro interno" });
  }
});

app.listen(PORT, () => console.log("🚀 Servidor ON na porta", PORT));
