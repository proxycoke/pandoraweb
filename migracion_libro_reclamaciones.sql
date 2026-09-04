-- ============================================================
-- Pandora Import — MIGRACIÓN: Libro de Reclamaciones Virtual
-- Copia TODO este archivo y pégalo en: Supabase > SQL Editor > New query
-- Luego presiona "Run". Es seguro de ejecutar una sola vez sobre
-- tu base de datos ya existente (no borra ni modifica nada más).
--
-- Campos alineados a la "Hoja de Reclamación Virtual" que exige
-- INDECOPI (Ley 29571 y D.S. 101-2022-PCM) para negocios que
-- venden por internet en Perú.
-- ============================================================

create table if not exists complaints_book (
  id bigint generated always as identity primary key,

  -- Tipo de solicitud
  tipo text not null check (tipo in ('reclamo','queja')),

  -- Datos del consumidor reclamante
  nombre_completo text not null,
  tipo_documento text not null default 'DNI',
  numero_documento text not null,
  domicilio text not null,
  telefono text,
  email text not null,
  nombre_apoderado_menor text,

  -- Datos del bien contratado
  tipo_bien text not null check (tipo_bien in ('producto','servicio')),
  descripcion_bien text not null default '',
  monto_reclamado numeric(10,2),

  -- Detalle de la reclamación
  detalle_reclamo text not null,
  pedido_consumidor text not null,

  -- Gestión interna (el negocio responde desde el CMS)
  estado text not null default 'pendiente' check (estado in ('pendiente','en_proceso','respondido')),
  respuesta text,
  fecha_respuesta timestamptz,

  -- Control de la copia por correo que recibe el consumidor
  confirmation_email_sent boolean not null default false,

  -- Control del aviso por correo que recibe el negocio (recordatorio)
  business_notification_sent boolean not null default false,

  created_at timestamptz not null default now()
);

-- Por si esta tabla ya existía de un intento anterior sin las columnas nuevas:
alter table complaints_book add column if not exists nombre_apoderado_menor text;
alter table complaints_book add column if not exists confirmation_email_sent boolean not null default false;
alter table complaints_book add column if not exists business_notification_sent boolean not null default false;

-- Índice para que el límite de "máximo N reclamos por correo por hora"
-- (aplicado en la función submit-complaint) sea rápido de consultar.
create index if not exists idx_complaints_book_email_created_at
  on complaints_book (email, created_at desc);

-- Seguridad a nivel de fila (RLS)
alter table complaints_book enable row level security;

-- Se vuelven a crear las políticas siempre (drop + create), para que este
-- script sea seguro de ejecutar más de una vez sin quedar a medias.
drop policy if exists "public insert complaints" on complaints_book;
drop policy if exists "auth read complaints" on complaints_book;
drop policy if exists "auth update complaints" on complaints_book;
drop policy if exists "auth delete complaints" on complaints_book;

-- IMPORTANTE (seguridad): a propósito NO se vuelve a crear una política de
-- "insert" para el público. Antes existía "public insert complaints ...
-- with check (true)", que permitía insertar reclamos con una llamada HTTP
-- directa a la tabla, sin pasar por el formulario, por el honeypot ni por
-- Turnstile. Ahora que RLS está activo y NO hay ninguna política de insert
-- para "anon"/"authenticated", Postgres deniega todo insert de esos roles
-- por defecto. El único que puede seguir insertando es la función de
-- Supabase "submit-complaint", porque usa la clave de servicio
-- (service_role), que siempre pasa por encima de RLS sin importar las
-- políticas — por eso esto no rompe el formulario público, solo le cierra
-- el paso directo a la tabla a cualquiera que no pase por esa función.
--
-- Nadie puede leer, editar ni borrar reclamos ajenos sin haber iniciado sesión.
create policy "auth read complaints" on complaints_book for select using (auth.role() = 'authenticated');
create policy "auth update complaints" on complaints_book for update using (auth.role() = 'authenticated');
create policy "auth delete complaints" on complaints_book for delete using (auth.role() = 'authenticated');

-- ============================================================
-- Función para que el formulario público reciba el número de folio
-- ============================================================
-- Un visitante anónimo SÍ puede registrar un reclamo (política de arriba),
-- pero por seguridad NO puede leer reclamos (ni siquiera el que él mismo
-- acaba de enviar) — solo el negocio, ya logueado en el CMS, puede leerlos.
-- Sin embargo, el formulario necesita mostrarle al consumidor su número de
-- folio apenas lo envía. Esta función resuelve eso: guarda el reclamo con
-- permisos internos elevados y devuelve ÚNICAMENTE el folio de ESE reclamo,
-- sin abrir la lectura del resto de la tabla a nadie.
create or replace function public.submit_complaint(
  in_tipo text,
  in_nombre_completo text,
  in_tipo_documento text,
  in_numero_documento text,
  in_domicilio text,
  in_telefono text,
  in_email text,
  in_nombre_apoderado_menor text,
  in_tipo_bien text,
  in_descripcion_bien text,
  in_monto_reclamado numeric,
  in_detalle_reclamo text,
  in_pedido_consumidor text
)
returns table (id bigint, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  insert into complaints_book (
    tipo, nombre_completo, tipo_documento, numero_documento, domicilio,
    telefono, email, nombre_apoderado_menor, tipo_bien, descripcion_bien,
    monto_reclamado, detalle_reclamo, pedido_consumidor
  ) values (
    in_tipo, in_nombre_completo, in_tipo_documento, in_numero_documento, in_domicilio,
    in_telefono, in_email, in_nombre_apoderado_menor, in_tipo_bien, in_descripcion_bien,
    in_monto_reclamado, in_detalle_reclamo, in_pedido_consumidor
  )
  returning complaints_book.id, complaints_book.created_at;
end;
$$;

-- IMPORTANTE (seguridad): este RPC YA NO es de acceso público. Antes
-- "anon" podía ejecutarlo directo por HTTP sin pasar por el formulario ni
-- por ninguna verificación anti-bots, generando reclamos falsos ilimitados
-- (cada uno dispara un correo real a quien el que llama elija). Ahora solo
-- la función de Supabase "submit-complaint" puede invocarlo, porque usa la
-- clave de servicio (service_role), que no depende de este grant/revoke.
revoke all on function public.submit_complaint(
  text, text, text, text, text, text, text, text, text, text, numeric, text, text
) from public, anon, authenticated;
