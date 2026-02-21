
/**
 * server.js - SEMEC SISTEMA
 * Requisitos:
 *   npm i express cors dotenv @supabase/supabase-js
 *
 * Variáveis de ambiente (Render / .env):
 *   SUPABASE_URL=https://xxxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY=xxxxx   (ou ANON se não precisar escrever)
 *   ADMIN_TOKEN=um_token_forte_aqui   (protege rotas /api/admin/*)
 *   PORT=10000
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const dns = require("dns");
const { createClient } = require("@supabase/supabase-js");

// ✅ Força IPv4 (resolve problema de IPv6 no Render)
try {
  dns.setDefaultResultOrder("ipv4first");
} catch (e) {
  // versões antigas do node podem não ter isso
}

const app = express();

// ====== CONFIG ======
app.use(cors());
app.use(express.json({ limit: "10mb" }));

// Servir arquivos estáticos
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// ====== SUPABASE ======
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("❌ Configure SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY (ou SUPABASE_ANON_KEY) no ambiente.");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ====== AUTH (ADMIN) ======
function requireAdmin(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query.admin_token;
  if (!process.env.ADMIN_TOKEN) {
    return res.status(500).json({ ok: false, error: "ADMIN_TOKEN não configurado no servidor." });
  }
  if (token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Não autorizado (admin)." });
  }
  next();
}

// ====== HELPERS ======
function onlyAllowed(obj, allowed) {
  const out = {};
  for (const k of allowed) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function toIntOrNull(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ====== ROUTES ======
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "semec-sistema", time: new Date().toISOString() });
});

/**
 * Funcionários
 * GET /api/funcionarios?escola=SEMEC
 */
app.get("/api/funcionarios", async (req, res) => {
  try {
    const escola = (req.query.escola || "SEMEC").toString();

    const { data, error } = await supabase
      .from("funcionarios")
      .select("matricula,nome,funcao,vinculo,carga,escola")
      .eq("escola", escola)
      .order("nome", { ascending: true });

    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.json({ ok: true, funcionarios: data || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/**
 * Folhas (para página da folha do mês)
 * GET /api/folhas?mes=2026-02&escola=SEMEC
 */
app.get("/api/folhas", async (req, res) => {
  try {
    const mes = (req.query.mes || "").toString();      // "2026-02"
    const escola = (req.query.escola || "SEMEC").toString();

    if (!mes) return res.status(400).json({ ok: false, error: "Informe ?mes=YYYY-MM" });

    const { data, error } = await supabase
      .from("folhas")
      .select("*")
      .eq("mes", mes)
      .eq("escola", escola)
      .order("nome", { ascending: true });

    if (error) return res.status(400).json({ ok: false, error: error.message });

    return res.json({ ok: true, folhas: data || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/**
 * Criar/atualizar folha do mês (usuário na página "Folha de Ponto")
 * POST /api/folhas
 * body: { matricula, nome, funcao, vinculo, carga, escola, mes, faltas, horas_extras, obs }
 *
 * -> Faz UPSERT por (matricula, mes, escola)
 * OBS: No Supabase, crie um UNIQUE em (matricula, mes, escola) pra garantir.
 */
app.post("/api/folhas", async (req, res) => {
  try {
    const body = req.body || {};

    const payload = {
      matricula: body.matricula?.toString(),
      nome: body.nome?.toString() || "",
      funcao: body.funcao?.toString() || "",
      vinculo: body.vinculo?.toString() || "",
      carga: body.carga?.toString() || "",
      escola: (body.escola?.toString() || "SEMEC"),
      mes: body.mes?.toString(), // "2026-02"
      faltas: toIntOrNull(body.faltas),
      horas_extras: toIntOrNull(body.horas_extras),
      obs: body.obs !== undefined ? String(body.obs) : null,

      // ✅ precisa ser timestamptz no banco (recomendado)
      atualizado_em: new Date().toISOString(),
    };

    if (!payload.matricula) return res.status(400).json({ ok: false, error: "matricula é obrigatório" });
    if (!payload.mes) return res.status(400).json({ ok: false, error: "mes é obrigatório (YYYY-MM)" });

    // UPSERT
    const { data, error } = await supabase
      .from("folhas")
      .upsert(payload, { onConflict: "matricula,mes,escola" })
      .select()
      .single();

    if (error) return res.status(400).json({ ok: false, error: error.message });

    return res.json({ ok: true, folha: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/**
 * ADMIN: listar folhas (admin.html)
 * GET /api/admin/folhas?mes=2026-02&escola=SEMEC
 */
app.get("/api/admin/folhas", requireAdmin, async (req, res) => {
  try {
    const mes = (req.query.mes || "").toString();
    const escola = (req.query.escola || "SEMEC").toString();
    if (!mes) return res.status(400).json({ ok: false, error: "Informe ?mes=YYYY-MM" });

    const { data, error } = await supabase
      .from("folhas")
      .select("*")
      .eq("mes", mes)
      .eq("escola", escola)
      .order("nome", { ascending: true });

    if (error) return res.status(400).json({ ok: false, error: error.message });

    return res.json({ ok: true, folhas: data || [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

/**
 * ADMIN: editar faltas, horas extras e obs
 * PUT /api/admin/folhas/:id
 * header: x-admin-token: SEU_ADMIN_TOKEN
 * body: { faltas, horas_extras, obs }
 */
app.put("/api/admin/folhas/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const body = req.body || {};
    const allowed = onlyAllowed(body, ["faltas", "horas_extras", "obs"]);

    const payload = {};
    if (allowed.faltas !== undefined) payload.faltas = toIntOrNull(allowed.faltas);
    if (allowed.horas_extras !== undefined) payload.horas_extras = toIntOrNull(allowed.horas_extras);
    if (allowed.obs !== undefined) payload.obs = allowed.obs === "" ? null : String(allowed.obs);

    payload.atualizado_em = new Date().toISOString();

    const { data, error } = await supabase
      .from("folhas")
      .update(payload)
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(400).json({ ok: false, error: error.message });
    return res.json({ ok: true, folha: data });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// Fallback: abrir index.html se rota não existir (SPA simples)
app.get("*", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ====== START ======
const PORT = Number(process.env.PORT || 10000);
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
});
