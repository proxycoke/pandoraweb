// ============================================================
// Pandora Import — Edge Function: submit-complaint
// ============================================================
// Qué hace: reemplaza la llamada directa (pública) al RPC submit_complaint.
// Ahora el formulario del Libro de Reclamaciones Virtual llama a ESTA
// función, que:
//   1. Revisa el campo trampa para bots (honeypot) — si viene lleno, finge
//      éxito sin guardar nada real.
//   2. Verifica el token de Cloudflare Turnstile CONTRA CLOUDFLARE, del lado
//      del servidor (esto es lo importante: el navegador no puede falsear
//      esta verificación, a diferencia del honeypot que es solo JS).
//   3. Aplica un límite simple: no más de 5 reclamos con el mismo correo en
//      la última hora, para frenar abuso aunque alguien resuelva el
//      Turnstile a mano varias veces.
//   4. Recién ahí guarda el reclamo, usando la clave de servicio (no la
//      pública), a través del mismo RPC submit_complaint de siempre.
//
// Por qué hace falta esto: antes, cualquiera podía llamar al RPC
// submit_complaint directo por HTTP (sin pasar por la web ni por el
// honeypot) y generar reclamos falsos ilimitados — y cada uno dispara un
// correo real a la dirección que el que llama elija, lo cual se podía usar
// para mandar spam/phishing "desde" el dominio de Pandora Import. Por eso
// además el RPC ya NO tiene permiso de ejecución para "anon" — solo esta
// función (con la clave de servicio) puede invocarlo.
//
// Cómo se despliega (igual que send-complaint-copy, sin instalar nada):
//   1. Supabase → Edge Functions → Create a new function.
//   2. Nombre exacto: submit-complaint
//   3. Pega todo este archivo como su código y despliega.
//   4. En Secrets, agrega: TURNSTILE_SECRET_KEY = la Secret Key que te da
//      Cloudflare Turnstile (Cloudflare → Turnstile → tu sitio → Secret Key).
//      (SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ya vienen automáticas.)
//
// Requisito de base de datos: correr de nuevo migracion_libro_reclamaciones.sql
// (ya incluye el revoke/grant que le quita el permiso a "anon" sobre el RPC).
// ============================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TURNSTILE_SECRET_KEY = Deno.env.get("TURNSTILE_SECRET_KEY") ?? "";

const EMAIL_RATE_LIMIT_MAX = 5;       // máximo de reclamos por correo...
const EMAIL_RATE_LIMIT_WINDOW_MIN = 60; // ...en esta cantidad de minutos.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function verifyTurnstile(token: string, remoteIp: string | null): Promise<{ ok: boolean; detail?: unknown }> {
  if (!TURNSTILE_SECRET_KEY) return { ok: false, detail: "TURNSTILE_SECRET_KEY no configurado." };
  if (!token) return { ok: false, detail: "Falta el token de verificación." };

  const form = new URLSearchParams();
  form.set("secret", TURNSTILE_SECRET_KEY);
  form.set("response", token);
  if (remoteIp) form.set("remoteip", remoteIp);

  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) return { ok: false, detail: data["error-codes"] || data };
  return { ok: true };
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
      return jsonResponse({ error: "Configuración del servidor incompleta." }, 500);
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return jsonResponse({ error: "Cuerpo de la solicitud inválido." }, 400);
    }

    // 1) Campo trampa para bots: si viene lleno, se finge éxito sin guardar nada real.
    if (isNonEmptyString(body.website)) {
      return jsonResponse({ id: Math.floor(100000 + Math.random() * 900000), created_at: new Date().toISOString() });
    }

    // 2) Verificación de Turnstile (del lado del servidor, no se puede falsear desde el navegador).
    const remoteIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;
    const turnstile = await verifyTurnstile(body.turnstileToken, remoteIp);
    if (!turnstile.ok) {
      return jsonResponse({ error: "No se pudo verificar que eres una persona. Vuelve a intentarlo.", detail: turnstile.detail }, 400);
    }

    // Validación básica de campos obligatorios (evita errores crudos de la base de datos).
    const required = ["tipo", "nombreCompleto", "tipoDocumento", "numeroDocumento", "domicilio", "email", "tipoBien", "descripcionBien", "detalleReclamo", "pedidoConsumidor"];
    for (const field of required) {
      if (!isNonEmptyString(body[field])) {
        return jsonResponse({ error: `Falta el campo obligatorio: ${field}.` }, 400);
      }
    }

    const email = String(body.email).trim();

    // 3) Límite simple por correo, para frenar abuso aunque alguien resuelva el Turnstile varias veces.
    const since = new Date(Date.now() - EMAIL_RATE_LIMIT_WINDOW_MIN * 60 * 1000).toISOString();
    const countRes = await fetch(
      `${SUPABASE_URL}/rest/v1/complaints_book?select=id&email=eq.${encodeURIComponent(email)}&created_at=gte.${encodeURIComponent(since)}`,
      { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}`, Prefer: "count=exact" } }
    );
    const recentRows = await countRes.json().catch(() => []);
    if (Array.isArray(recentRows) && recentRows.length >= EMAIL_RATE_LIMIT_MAX) {
      return jsonResponse({ error: "Se alcanzó el límite de reclamos para este correo en la última hora. Intenta más tarde o escríbenos por WhatsApp." }, 429);
    }

    // 4) Se guarda el reclamo con la clave de servicio, a través del mismo RPC de siempre.
    const payload = {
      in_tipo: body.tipo,
      in_nombre_completo: String(body.nombreCompleto).trim(),
      in_tipo_documento: body.tipoDocumento,
      in_numero_documento: String(body.numeroDocumento).trim(),
      in_domicilio: String(body.domicilio).trim(),
      in_telefono: isNonEmptyString(body.telefono) ? String(body.telefono).trim() : null,
      in_email: email,
      in_nombre_apoderado_menor: isNonEmptyString(body.nombreApoderadoMenor) ? String(body.nombreApoderadoMenor).trim() : null,
      in_tipo_bien: body.tipoBien,
      in_descripcion_bien: String(body.descripcionBien).trim(),
      in_monto_reclamado: body.montoReclamado != null && body.montoReclamado !== "" ? Number(body.montoReclamado) : null,
      in_detalle_reclamo: String(body.detalleReclamo).trim(),
      in_pedido_consumidor: String(body.pedidoConsumidor).trim(),
    };

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/submit_complaint`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return jsonResponse({ error: "No se pudo registrar el reclamo.", detail: errText }, 502);
    }
    const rows = await insertRes.json();
    const row = rows && rows[0];
    if (!row) return jsonResponse({ error: "No se pudo registrar el reclamo." }, 502);

    return jsonResponse({ id: row.id, created_at: row.created_at });
  } catch (err) {
    return jsonResponse({ error: String(err && err.message ? err.message : err) }, 500);
  }
});
