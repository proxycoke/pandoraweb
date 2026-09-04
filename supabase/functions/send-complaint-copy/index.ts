// ============================================================
// Pandora Import — Edge Function: send-complaint-copy
// ============================================================
// Qué hace: cuando alguien envía el formulario del Libro de Reclamaciones
// Virtual, la página web llama a esta función pasándole solo el "id" del
// reclamo recién guardado. Esta función busca ese reclamo en la base de
// datos (con permisos internos, sin depender de lo que el navegador diga
// que son los datos, para evitar abusos) y envía DOS correos:
//   1. Al consumidor: una copia en HTML de todo lo que llenó en el
//      formulario — tal como exige la normativa de INDECOPI (el
//      consumidor debe quedarse con una copia de su reclamo).
//   2. Al negocio (ADMIN_NOTIFICATION_EMAIL): un aviso de "nuevo reclamo
//      recibido" con el mismo resumen, para que no dependa de entrar al
//      CMS a revisar si llegó algo nuevo — es un recordatorio automático.
// Cada uno de estos dos envíos es independiente: si uno falla, el otro
// igual se intenta, y cada uno se marca por separado como enviado para
// no reenviarlo dos veces si la función se vuelve a llamar para el mismo id.
//
// Cómo se despliega (sin necesidad de instalar nada en tu computadora):
//   1. Entra a tu proyecto en supabase.com → Edge Functions.
//   2. Crea una función nueva llamada exactamente: send-complaint-copy
//   3. Pega TODO el contenido de este archivo como su código.
//   4. En "Manage secrets" (o Settings → Edge Functions → Secrets) agrega:
//        RESEND_API_KEY = la clave que te da resend.com
//      (SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY ya vienen automáticas,
//      no hace falta que las agregues tú.)
//   5. Guarda / despliega la función.
//
// Requisito previo: haber verificado el dominio pandoraimport.com dentro
// de tu cuenta de Resend (Resend → Domains → Add Domain → agregar los
// registros DNS que te indique). Sin eso, Resend rechazará los envíos.
//
// Requisito de base de datos: la tabla complaints_book debe tener las
// columnas "confirmation_email_sent" y "business_notification_sent"
// (boolean, default false) — están incluidas en migracion_libro_reclamaciones.sql.
// ============================================================

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Cambia esto si prefieres que el correo llegue "desde" otra dirección de
// tu dominio (debe ser un buzón de pandoraimport.com, no de Gmail u otro).
const FROM_ADDRESS = "Libro de Reclamaciones - Pandora Import <reclamos@pandoraimport.com>";

// Correo del negocio que recibe el aviso de "nuevo reclamo recibido",
// como recordatorio para entrar a revisarlo en el CMS.
const ADMIN_NOTIFICATION_EMAIL = "ronaldprado90@gmail.com";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function folioFor(id: number, createdAt: string): string {
  const year = createdAt ? new Date(createdAt).getFullYear() : new Date().getFullYear();
  return String(id).padStart(6, "0") + "-" + year;
}

function esc(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function buildEmailHtml(c: Record<string, any>, folio: string, audience: "consumer" | "business" = "consumer"): string {
  const fecha = c.created_at
    ? new Date(c.created_at).toLocaleString("es-PE", { dateStyle: "long", timeStyle: "short", timeZone: "America/Lima" })
    : "";
  const tipoLabel = c.tipo === "queja" ? "Queja" : "Reclamo";
  const bienLabel = c.tipo_bien === "servicio" ? "Servicio" : "Producto";
  const monto = c.monto_reclamado != null ? `S/ ${Number(c.monto_reclamado).toFixed(2)}` : "No especificado";

  const introHtml = audience === "business"
    ? `
      <p style="font-size:14px;line-height:1.6;">
        Se acaba de registrar un(a) <strong>${tipoLabel.toLowerCase()}</strong> nuevo en el Libro de Reclamaciones
        Virtual el ${esc(fecha)} (hora de Perú). Este es un recordatorio automático para que entres al
        <strong>CMS → Reclamos</strong> a revisarlo y responder dentro del plazo legal. Folio:
      </p>
      <p style="font-size:20px;font-weight:800;color:#c4125f;margin:6px 0 18px;">${esc(folio)}</p>`
    : `
      <p style="font-size:14px;line-height:1.6;">
        Hola ${esc(c.nombre_completo)}, este es un comprobante automático de tu ${tipoLabel.toLowerCase()}
        registrado el ${esc(fecha)} (hora de Perú). Tu número de folio es:
      </p>
      <p style="font-size:20px;font-weight:800;color:#c4125f;margin:6px 0 18px;">${esc(folio)}</p>`;

  const headerTitle = audience === "business"
    ? "🔔 Nuevo reclamo recibido — Libro de Reclamaciones Virtual"
    : "📋 Copia de tu Libro de Reclamaciones Virtual";

  const footerHtml = audience === "business"
    ? `
      <p style="font-size:12.5px;color:#6b7280;margin-top:22px;line-height:1.6;">
        Recuerda que el plazo de respuesta es de <strong>15 días hábiles</strong>, improrrogable, conforme a la
        Ley N.° 29571 y su modificatoria D.S. N.° 101-2022-PCM.
      </p>
      <p style="font-size:11.5px;color:#9ca3af;margin-top:18px;">
        Este es un correo automático generado por pandoraimport.com para el equipo de Pandora Import.
      </p>`
    : `
      <p style="font-size:12.5px;color:#6b7280;margin-top:22px;line-height:1.6;">
        Te responderemos a este mismo correo en un plazo no mayor a <strong>15 días hábiles</strong>,
        el cual es improrrogable, conforme a la Ley N.° 29571 y su modificatoria D.S. N.° 101-2022-PCM.
        El registro de este ${tipoLabel.toLowerCase()} no impide acudir a otras vías de solución de controversias.
      </p>
      <p style="font-size:11.5px;color:#9ca3af;margin-top:18px;">
        Este es un correo automático generado por pandoraimport.com — no necesitas responderlo para que tu
        ${tipoLabel.toLowerCase()} quede registrado, ya está guardado.
      </p>`;

  return `
  <div style="font-family:Segoe UI,Arial,sans-serif;max-width:640px;margin:0 auto;color:#3d1a33;">
    <div style="background:#ec1e79;color:#fff;padding:18px 24px;border-radius:12px 12px 0 0;">
      <h1 style="margin:0;font-size:18px;">${headerTitle}</h1>
      <p style="margin:4px 0 0;font-size:13px;opacity:.9;">Pandora Import</p>
    </div>
    <div style="border:1px solid #f3d9e8;border-top:none;border-radius:0 0 12px 12px;padding:22px 24px;">
      ${introHtml}

      <table style="width:100%;border-collapse:collapse;font-size:13.5px;">
        <tr><td style="padding:6px 0;color:#6b7280;width:40%;">Tipo de solicitud</td><td style="padding:6px 0;font-weight:700;">${esc(tipoLabel)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Nombre completo</td><td style="padding:6px 0;">${esc(c.nombre_completo)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Documento</td><td style="padding:6px 0;">${esc(c.tipo_documento)} ${esc(c.numero_documento)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Domicilio</td><td style="padding:6px 0;">${esc(c.domicilio)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Teléfono</td><td style="padding:6px 0;">${esc(c.telefono)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Correo</td><td style="padding:6px 0;">${esc(c.email)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Padre/madre/apoderado (si es menor)</td><td style="padding:6px 0;">${esc(c.nombre_apoderado_menor)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Bien contratado</td><td style="padding:6px 0;">${esc(bienLabel)} — ${esc(c.descripcion_bien)}</td></tr>
        <tr><td style="padding:6px 0;color:#6b7280;">Monto reclamado</td><td style="padding:6px 0;">${esc(monto)}</td></tr>
      </table>

      <div style="margin-top:16px;">
        <p style="font-size:12.5px;color:#6b7280;margin:0 0 4px;font-weight:700;">DETALLE DE LA RECLAMACIÓN</p>
        <p style="font-size:13.5px;line-height:1.6;white-space:pre-wrap;margin:0;">${esc(c.detalle_reclamo)}</p>
      </div>
      <div style="margin-top:14px;">
        <p style="font-size:12.5px;color:#6b7280;margin:0 0 4px;font-weight:700;">PEDIDO DEL CONSUMIDOR</p>
        <p style="font-size:13.5px;line-height:1.6;white-space:pre-wrap;margin:0;">${esc(c.pedido_consumidor)}</p>
      </div>

      ${footerHtml}
    </div>
  </div>`;
}

async function sendEmail(to: string, subject: string, html: string): Promise<{ ok: boolean; detail?: string }> {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM_ADDRESS, to: [to], subject, html }),
  });
  if (!res.ok) {
    const errText = await res.text();
    return { ok: false, detail: errText };
  }
  return { ok: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    if (!RESEND_API_KEY) {
      return new Response(JSON.stringify({ error: "Falta configurar RESEND_API_KEY en los secretos de la función." }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { id } = await req.json();
    if (!id) {
      return new Response(JSON.stringify({ error: "Falta el id del reclamo." }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Se busca el reclamo con la clave de servicio (no la del navegador),
    // así el correo se arma siempre con los datos reales guardados en la
    // base de datos, no con lo que alguien pueda mandar desde afuera.
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/complaints_book?id=eq.${encodeURIComponent(id)}&select=*`,
      { headers: { apikey: SERVICE_ROLE_KEY, Authorization: `Bearer ${SERVICE_ROLE_KEY}` } }
    );
    if (!getRes.ok) throw new Error("No se pudo leer el reclamo (" + getRes.status + ")");
    const rows = await getRes.json();
    const c = rows && rows[0];
    if (!c) {
      return new Response(JSON.stringify({ error: "Reclamo no encontrado." }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const folio = folioFor(c.id, c.created_at);
    const tipoLabel = c.tipo === "queja" ? "queja" : "reclamo";
    const patch: Record<string, boolean> = {};
    const result: Record<string, unknown> = {};

    // 1) Copia al consumidor (obligatoria por normativa de INDECOPI).
    if (c.confirmation_email_sent) {
      result.consumerCopy = { ok: true, alreadySent: true };
    } else if (!c.email) {
      result.consumerCopy = { ok: false, error: "Este reclamo no tiene correo registrado." };
    } else {
      const consumerHtml = buildEmailHtml(c, folio, "consumer");
      const sent = await sendEmail(c.email, `Copia de tu ${tipoLabel} — Folio ${folio} — Pandora Import`, consumerHtml);
      if (sent.ok) {
        patch.confirmation_email_sent = true;
        result.consumerCopy = { ok: true };
      } else {
        result.consumerCopy = { ok: false, error: "Resend rechazó el envío", detail: sent.detail };
      }
    }

    // 2) Aviso al negocio (recordatorio de que hay un reclamo nuevo por revisar).
    if (c.business_notification_sent) {
      result.businessNotification = { ok: true, alreadySent: true };
    } else if (!ADMIN_NOTIFICATION_EMAIL) {
      result.businessNotification = { ok: false, error: "No hay un correo de negocio configurado." };
    } else {
      const businessHtml = buildEmailHtml(c, folio, "business");
      const sent = await sendEmail(
        ADMIN_NOTIFICATION_EMAIL,
        `🔔 Nuevo ${tipoLabel} recibido — Folio ${folio} — Pandora Import`,
        businessHtml
      );
      if (sent.ok) {
        patch.business_notification_sent = true;
        result.businessNotification = { ok: true };
      } else {
        result.businessNotification = { ok: false, error: "Resend rechazó el envío", detail: sent.detail };
      }
    }

    // Se marca cada envío exitoso por separado para no reenviarlo dos veces
    // por error o abuso, aunque uno de los dos haya fallado.
    if (Object.keys(patch).length > 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/complaints_book?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: {
          apikey: SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify(patch),
      });
    }

    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err && err.message ? err.message : err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
