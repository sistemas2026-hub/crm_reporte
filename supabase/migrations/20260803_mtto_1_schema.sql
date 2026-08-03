-- ============================================================
-- MÓDULO DE MANTENIMIENTO VEHICULAR (mtto_*)
-- Fase 1/3: enums, tablas, triggers, vistas, RLS y storage.
-- Ejecutar en el SQL Editor de Supabase (idempotente).
--
-- Aislamiento multi-tenant: las tablas OPERATIVAS (vehículo, orden,
-- usuario_rol, evento) llevan org_id y quedan aisladas por
-- organización usando los helpers ya existentes get_my_org_id() /
-- is_org_admin() (ver 20250506_saas_multitenancy.sql).
-- Los MAESTROS (checklist y catálogo de arreglos) son globales,
-- tal como se definieron sus columnas, y solo los edita un admin
-- del módulo — si en el futuro hace falta un catálogo por org,
-- es una migración aparte.
-- ============================================================

-- ============================================================
-- 1. ENUMS
-- ============================================================
DO $$ BEGIN
    CREATE TYPE public.mtto_tipo_vehiculo AS ENUM ('motocarro', 'moto_trailer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE public.mtto_rol AS ENUM ('mecanico', 'encargado', 'aprobador', 'admin');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE public.mtto_tipo_servicio AS ENUM ('preventivo', 'correctivo', 'emergencia', 'diagnostico', 'alistamiento');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE public.mtto_estado_item AS ENUM ('B', 'R', 'M', 'NA');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE public.mtto_estado_orden AS ENUM (
        'borrador', 'en_revision', 'en_aprobacion', 'aprobada',
        'rechazada', 'en_ejecucion', 'cerrada', 'anulada'
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE public.mtto_prioridad AS ENUM ('alta', 'media', 'baja');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE public.mtto_decision AS ENUM ('aprobado', 'aprobado_parcial', 'no_aprobado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- 2. TABLAS
-- ============================================================

-- Rol de cada usuario dentro del módulo (uno solo por usuario).
-- Un profiles.role = 'admin' ya es admin del módulo automáticamente
-- (ver mtto_es_admin_modulo() más abajo) sin necesitar fila aquí.
CREATE TABLE IF NOT EXISTS public.mtto_usuario_rol (
    usuario_id  uuid PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    org_id      uuid NOT NULL DEFAULT public.get_my_org_id() REFERENCES public.organizations(id),
    rol         public.mtto_rol NOT NULL,
    nombre      text,
    documento   text,
    cargo       text,
    activo      boolean NOT NULL DEFAULT true,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.mtto_vehiculo (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL DEFAULT public.get_my_org_id() REFERENCES public.organizations(id),
    codigo          text NOT NULL,
    tipo            public.mtto_tipo_vehiculo NOT NULL,
    placa           text,
    marca           text,
    linea           text,
    anio            int,
    cilindraje      int,
    num_motor       text,
    num_chasis      text,
    soat_vence      date,
    tecno_vence     date,
    responsable_id  uuid REFERENCES public.profiles(id),
    activo          boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (org_id, codigo)
);

-- Maestro global: secciones del checklist
CREATE TABLE IF NOT EXISTS public.mtto_checklist_seccion (
    id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    orden   int NOT NULL,
    nombre  text NOT NULL UNIQUE,
    aplica  public.mtto_tipo_vehiculo[] -- NULL = aplica a todos los tipos
);

-- Maestro global: ítems del checklist (97 en total)
CREATE TABLE IF NOT EXISTS public.mtto_checklist_item (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seccion_id  uuid NOT NULL REFERENCES public.mtto_checklist_seccion(id) ON DELETE CASCADE,
    orden       int NOT NULL,
    nombre      text NOT NULL,
    critico     boolean NOT NULL DEFAULT false,
    aplica      public.mtto_tipo_vehiculo[], -- NULL = aplica a todos
    activo      boolean NOT NULL DEFAULT true,
    UNIQUE (seccion_id, nombre)
);

-- Maestro global: sistemas del catálogo de arreglos
CREATE TABLE IF NOT EXISTS public.mtto_catalogo_sistema (
    id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    orden   int NOT NULL,
    nombre  text NOT NULL UNIQUE
);

-- Maestro global: catálogo de arreglos (107 en total). Precios NULL
-- hasta que el admin los cargue desde la pantalla de administración.
CREATE TABLE IF NOT EXISTS public.mtto_catalogo_arreglo (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sistema_id          uuid NOT NULL REFERENCES public.mtto_catalogo_sistema(id) ON DELETE CASCADE,
    nombre              text NOT NULL,
    precio_repuesto_ref numeric(14,0),
    precio_mo_ref       numeric(14,0),
    activo              boolean NOT NULL DEFAULT true,
    UNIQUE (sistema_id, nombre)
);

-- Orden de trabajo
CREATE TABLE IF NOT EXISTS public.mtto_orden (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL DEFAULT public.get_my_org_id() REFERENCES public.organizations(id),
    numero          text UNIQUE, -- se asigna por trigger, formato OT-2026-00001
    vehiculo_id     uuid NOT NULL REFERENCES public.mtto_vehiculo(id),
    fecha           date NOT NULL DEFAULT current_date,
    kilometraje     int,
    tipo_servicio   public.mtto_tipo_servicio NOT NULL,
    taller          text,
    motivo          text,
    diagnostico     text,
    estado          public.mtto_estado_orden NOT NULL DEFAULT 'borrador',
    iva_tasa        numeric(5,4) NOT NULL DEFAULT 0.19 CHECK (iva_tasa IN (0, 0.05, 0.19)),

    creado_por      uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
    enviado_at      timestamptz,

    revisado_por    uuid REFERENCES public.profiles(id),
    revisado_at     timestamptz,
    obs_encargado   text,

    aprobado_por    uuid REFERENCES public.profiles(id),
    aprobado_at     timestamptz,
    decision        public.mtto_decision,
    obs_aprobador   text,
    valor_aprobado  numeric(14,0),

    cerrado_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mtto_orden_org ON public.mtto_orden(org_id);
CREATE INDEX IF NOT EXISTS idx_mtto_orden_vehiculo ON public.mtto_orden(vehiculo_id);
CREATE INDEX IF NOT EXISTS idx_mtto_orden_estado ON public.mtto_orden(estado);

-- Hallazgos: solo lo que NO está en Bueno. Un ítem sin fila = bueno.
CREATE TABLE IF NOT EXISTS public.mtto_orden_hallazgo (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    orden_id    uuid NOT NULL REFERENCES public.mtto_orden(id) ON DELETE CASCADE,
    item_id     uuid NOT NULL REFERENCES public.mtto_checklist_item(id),
    estado      public.mtto_estado_item NOT NULL CHECK (estado <> 'B'),
    observacion text,
    creado_por  uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (orden_id, item_id),
    CONSTRAINT mtto_hallazgo_obs_requerida CHECK (estado = 'NA' OR btrim(coalesce(observacion, '')) <> '')
);

CREATE INDEX IF NOT EXISTS idx_mtto_hallazgo_orden ON public.mtto_orden_hallazgo(orden_id);

CREATE TABLE IF NOT EXISTS public.mtto_orden_foto (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    hallazgo_id uuid NOT NULL REFERENCES public.mtto_orden_hallazgo(id) ON DELETE CASCADE,
    path        text NOT NULL,
    mime        text,
    bytes       int,
    subido_por  uuid NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id),
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mtto_foto_hallazgo ON public.mtto_orden_foto(hallazgo_id);

CREATE TABLE IF NOT EXISTS public.mtto_orden_reparacion (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    orden_id            uuid NOT NULL REFERENCES public.mtto_orden(id) ON DELETE CASCADE,
    hallazgo_id         uuid REFERENCES public.mtto_orden_hallazgo(id) ON DELETE SET NULL,
    arreglo_id          uuid REFERENCES public.mtto_catalogo_arreglo(id),
    descripcion         text NOT NULL, -- texto congelado del arreglo al momento de cotizar
    sistema             text,
    repuesto            text,
    cantidad            numeric(10,2) NOT NULL DEFAULT 1 CHECK (cantidad > 0),
    valor_unitario       numeric(14,0) NOT NULL DEFAULT 0 CHECK (valor_unitario >= 0),
    mano_obra           numeric(14,0) NOT NULL DEFAULT 0 CHECK (mano_obra >= 0),
    prioridad           public.mtto_prioridad NOT NULL DEFAULT 'media',
    autorizado          boolean NOT NULL DEFAULT false,
    subtotal_repuestos  numeric(16,2) GENERATED ALWAYS AS (cantidad * valor_unitario) STORED,
    total               numeric(16,2) GENERATED ALWAYS AS (cantidad * valor_unitario + mano_obra) STORED,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mtto_reparacion_orden ON public.mtto_orden_reparacion(orden_id);

-- Trazabilidad — append-only, solo la escriben las funciones RPC.
CREATE TABLE IF NOT EXISTS public.mtto_orden_evento (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    orden_id    uuid NOT NULL REFERENCES public.mtto_orden(id) ON DELETE CASCADE,
    usuario_id  uuid NOT NULL REFERENCES public.profiles(id),
    accion      text NOT NULL,
    detalle     jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mtto_evento_orden ON public.mtto_orden_evento(orden_id);

-- ============================================================
-- 3. NUMERACIÓN AUTOMÁTICA: OT-2026-00001
-- ============================================================
CREATE TABLE IF NOT EXISTS public.mtto_orden_secuencia (
    anio    int PRIMARY KEY,
    ultimo  int NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION public.mtto_asignar_numero_orden()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_anio int := EXTRACT(year FROM COALESCE(NEW.fecha, current_date))::int;
    v_num  int;
BEGIN
    IF NEW.numero IS NOT NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.mtto_orden_secuencia (anio, ultimo)
    VALUES (v_anio, 1)
    ON CONFLICT (anio) DO UPDATE SET ultimo = public.mtto_orden_secuencia.ultimo + 1
    RETURNING ultimo INTO v_num;

    NEW.numero := 'OT-' || v_anio || '-' || lpad(v_num::text, 5, '0');
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mtto_numero_orden ON public.mtto_orden;
CREATE TRIGGER trg_mtto_numero_orden
    BEFORE INSERT ON public.mtto_orden
    FOR EACH ROW EXECUTE FUNCTION public.mtto_asignar_numero_orden();

-- Fija org_id desde el vehículo (nunca confiar en el org_id que mande el cliente)
CREATE OR REPLACE FUNCTION public.mtto_fijar_org_orden()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_org_vehiculo uuid;
BEGIN
    SELECT org_id INTO v_org_vehiculo FROM public.mtto_vehiculo WHERE id = NEW.vehiculo_id;
    IF v_org_vehiculo IS NULL THEN
        RAISE EXCEPTION 'Vehículo % no existe', NEW.vehiculo_id;
    END IF;
    NEW.org_id := v_org_vehiculo;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mtto_fijar_org_orden ON public.mtto_orden;
CREATE TRIGGER trg_mtto_fijar_org_orden
    BEFORE INSERT ON public.mtto_orden
    FOR EACH ROW EXECUTE FUNCTION public.mtto_fijar_org_orden();

-- ============================================================
-- 4. INMUTABILIDAD FUERA DE BORRADOR (triggers, no solo RLS)
-- ============================================================

-- mtto_orden: los campos de contenido no cambian fuera de borrador.
-- El estado y los campos de revisión/aprobación sí cambian (los tocan
-- únicamente las funciones RPC, que corren como SECURITY DEFINER).
CREATE OR REPLACE FUNCTION public.mtto_bloquear_edicion_orden()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.estado <> 'borrador' AND (
        NEW.vehiculo_id    IS DISTINCT FROM OLD.vehiculo_id OR
        NEW.kilometraje    IS DISTINCT FROM OLD.kilometraje OR
        NEW.tipo_servicio  IS DISTINCT FROM OLD.tipo_servicio OR
        NEW.taller         IS DISTINCT FROM OLD.taller OR
        NEW.motivo         IS DISTINCT FROM OLD.motivo OR
        NEW.diagnostico    IS DISTINCT FROM OLD.diagnostico OR
        NEW.iva_tasa       IS DISTINCT FROM OLD.iva_tasa OR
        NEW.numero         IS DISTINCT FROM OLD.numero OR
        NEW.creado_por     IS DISTINCT FROM OLD.creado_por OR
        NEW.org_id         IS DISTINCT FROM OLD.org_id
    ) THEN
        RAISE EXCEPTION 'La orden % ya salió de borrador (estado actual: %); no se puede editar su contenido', OLD.numero, OLD.estado;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mtto_bloquear_edicion_orden ON public.mtto_orden;
CREATE TRIGGER trg_mtto_bloquear_edicion_orden
    BEFORE UPDATE ON public.mtto_orden
    FOR EACH ROW EXECUTE FUNCTION public.mtto_bloquear_edicion_orden();

-- mtto_orden_hallazgo / mtto_orden_foto: nada se toca fuera de borrador.
CREATE OR REPLACE FUNCTION public.mtto_bloquear_edicion_hallazgo()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_estado public.mtto_estado_orden;
    v_orden_id uuid := COALESCE(NEW.orden_id, OLD.orden_id);
BEGIN
    SELECT estado INTO v_estado FROM public.mtto_orden WHERE id = v_orden_id;
    IF v_estado IS DISTINCT FROM 'borrador' THEN
        RAISE EXCEPTION 'No se puede modificar hallazgos de una orden fuera de borrador (estado actual: %)', v_estado;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_mtto_bloquear_edicion_hallazgo ON public.mtto_orden_hallazgo;
CREATE TRIGGER trg_mtto_bloquear_edicion_hallazgo
    BEFORE UPDATE OR DELETE ON public.mtto_orden_hallazgo
    FOR EACH ROW EXECUTE FUNCTION public.mtto_bloquear_edicion_hallazgo();

CREATE OR REPLACE FUNCTION public.mtto_bloquear_edicion_foto()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_estado public.mtto_estado_orden;
    v_hallazgo_id uuid := COALESCE(NEW.hallazgo_id, OLD.hallazgo_id);
BEGIN
    SELECT o.estado INTO v_estado
    FROM public.mtto_orden_hallazgo h
    JOIN public.mtto_orden o ON o.id = h.orden_id
    WHERE h.id = v_hallazgo_id;

    IF v_estado IS DISTINCT FROM 'borrador' THEN
        RAISE EXCEPTION 'No se puede modificar fotos de una orden fuera de borrador (estado actual: %)', v_estado;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_mtto_bloquear_edicion_foto ON public.mtto_orden_foto;
CREATE TRIGGER trg_mtto_bloquear_edicion_foto
    BEFORE UPDATE OR DELETE ON public.mtto_orden_foto
    FOR EACH ROW EXECUTE FUNCTION public.mtto_bloquear_edicion_foto();

-- mtto_orden_reparacion: fuera de borrador solo se permite que
-- mtto_aprobar_orden marque/desmarque 'autorizado' (usa un flag de
-- sesión para habilitar esa única excepción); todo lo demás, bloqueado.
CREATE OR REPLACE FUNCTION public.mtto_bloquear_edicion_reparacion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_estado public.mtto_estado_orden;
    v_orden_id uuid := COALESCE(NEW.orden_id, OLD.orden_id);
BEGIN
    SELECT estado INTO v_estado FROM public.mtto_orden WHERE id = v_orden_id;

    IF v_estado = 'borrador' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP = 'UPDATE'
       AND current_setting('mtto.autorizando', true) = 'on'
       AND NEW.descripcion    IS NOT DISTINCT FROM OLD.descripcion
       AND NEW.sistema        IS NOT DISTINCT FROM OLD.sistema
       AND NEW.repuesto       IS NOT DISTINCT FROM OLD.repuesto
       AND NEW.cantidad       IS NOT DISTINCT FROM OLD.cantidad
       AND NEW.valor_unitario IS NOT DISTINCT FROM OLD.valor_unitario
       AND NEW.mano_obra      IS NOT DISTINCT FROM OLD.mano_obra
       AND NEW.prioridad      IS NOT DISTINCT FROM OLD.prioridad
       AND NEW.arreglo_id     IS NOT DISTINCT FROM OLD.arreglo_id
       AND NEW.orden_id       IS NOT DISTINCT FROM OLD.orden_id
       AND NEW.hallazgo_id    IS NOT DISTINCT FROM OLD.hallazgo_id
    THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'No se puede modificar la cotización de una orden fuera de borrador (estado actual: %)', v_estado;
END;
$$;

DROP TRIGGER IF EXISTS trg_mtto_bloquear_edicion_reparacion ON public.mtto_orden_reparacion;
CREATE TRIGGER trg_mtto_bloquear_edicion_reparacion
    BEFORE UPDATE OR DELETE ON public.mtto_orden_reparacion
    FOR EACH ROW EXECUTE FUNCTION public.mtto_bloquear_edicion_reparacion();

-- ============================================================
-- 5. HELPERS DE ROL (reutilizan is_org_admin()/get_my_org_id())
-- ============================================================

CREATE OR REPLACE FUNCTION public.mtto_es_admin_modulo()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT public.is_org_admin() OR EXISTS (
        SELECT 1 FROM public.mtto_usuario_rol
        WHERE usuario_id = auth.uid() AND rol = 'admin' AND activo
    );
$$;

CREATE OR REPLACE FUNCTION public.mtto_tiene_rol(p_rol public.mtto_rol)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT public.mtto_es_admin_modulo() OR EXISTS (
        SELECT 1 FROM public.mtto_usuario_rol
        WHERE usuario_id = auth.uid() AND rol = p_rol AND activo
    );
$$;

-- ¿El usuario tiene CUALQUIER rol asignado en el módulo? (gate de lectura)
CREATE OR REPLACE FUNCTION public.mtto_tiene_rol_modulo()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT public.mtto_es_admin_modulo() OR EXISTS (
        SELECT 1 FROM public.mtto_usuario_rol
        WHERE usuario_id = auth.uid() AND activo
    );
$$;

GRANT EXECUTE ON FUNCTION public.mtto_es_admin_modulo() TO authenticated;
GRANT EXECUTE ON FUNCTION public.mtto_tiene_rol(public.mtto_rol) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mtto_tiene_rol_modulo() TO authenticated;

-- ============================================================
-- 6. VISTAS (security_invoker: respetan el RLS de quien consulta)
-- ============================================================

CREATE OR REPLACE VIEW public.mtto_v_orden_total
WITH (security_invoker = on) AS
SELECT
    o.id AS orden_id,
    o.numero,
    COALESCE(SUM(r.subtotal_repuestos) FILTER (WHERE r.autorizado), 0) AS subtotal_repuestos,
    COALESCE(SUM(r.mano_obra) FILTER (WHERE r.autorizado), 0)         AS subtotal_mano_obra,
    COALESCE(SUM(r.total) FILTER (WHERE r.autorizado), 0)             AS subtotal,
    ROUND(COALESCE(SUM(r.total) FILTER (WHERE r.autorizado), 0) * o.iva_tasa, 0) AS iva,
    ROUND(COALESCE(SUM(r.total) FILTER (WHERE r.autorizado), 0) * (1 + o.iva_tasa), 0) AS total
FROM public.mtto_orden o
LEFT JOIN public.mtto_orden_reparacion r ON r.orden_id = o.id
GROUP BY o.id, o.numero, o.iva_tasa;

CREATE OR REPLACE VIEW public.mtto_v_orden_resumen
WITH (security_invoker = on) AS
SELECT
    o.id AS orden_id,
    o.numero,
    o.vehiculo_id,
    (
        SELECT count(*)
        FROM public.mtto_checklist_item ci
        JOIN public.mtto_checklist_seccion cs ON cs.id = ci.seccion_id
        WHERE ci.activo
          AND (ci.aplica IS NULL OR v.tipo = ANY (ci.aplica))
          AND (cs.aplica IS NULL OR v.tipo = ANY (cs.aplica))
    ) - COUNT(h.id) FILTER (WHERE h.estado IN ('R', 'M', 'NA')) AS bueno,
    COUNT(h.id) FILTER (WHERE h.estado = 'R')  AS regular,
    COUNT(h.id) FILTER (WHERE h.estado = 'M')  AS malo,
    COUNT(h.id) FILTER (WHERE h.estado = 'NA') AS no_aplica,
    bool_or(h.estado = 'M' AND ci2.critico) AS tiene_critico_malo
FROM public.mtto_orden o
JOIN public.mtto_vehiculo v ON v.id = o.vehiculo_id
LEFT JOIN public.mtto_orden_hallazgo h ON h.orden_id = o.id
LEFT JOIN public.mtto_checklist_item ci2 ON ci2.id = h.item_id
GROUP BY o.id, o.numero, o.vehiculo_id, v.tipo;

CREATE OR REPLACE VIEW public.mtto_v_costo_vehiculo
WITH (security_invoker = on) AS
SELECT
    v.id AS vehiculo_id,
    v.codigo,
    date_trunc('month', o.fecha)::date AS mes,
    SUM(t.total) AS total_mes
FROM public.mtto_vehiculo v
JOIN public.mtto_orden o ON o.vehiculo_id = v.id
JOIN public.mtto_v_orden_total t ON t.orden_id = o.id
WHERE o.estado NOT IN ('rechazada', 'anulada')
GROUP BY v.id, v.codigo, date_trunc('month', o.fecha);

-- ============================================================
-- 7. ROW LEVEL SECURITY
-- ============================================================

ALTER TABLE public.mtto_usuario_rol       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mtto_vehiculo          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mtto_checklist_seccion ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mtto_checklist_item    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mtto_catalogo_sistema  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mtto_catalogo_arreglo  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mtto_orden             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mtto_orden_hallazgo    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mtto_orden_foto        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mtto_orden_reparacion  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mtto_orden_evento      ENABLE ROW LEVEL SECURITY;

-- mtto_usuario_rol: cualquiera del módulo ve el directorio; solo admin gestiona.
DROP POLICY IF EXISTS mtto_usuario_rol_select ON public.mtto_usuario_rol;
CREATE POLICY mtto_usuario_rol_select ON public.mtto_usuario_rol
    FOR SELECT USING (public.mtto_tiene_rol_modulo() AND org_id = public.get_my_org_id());

DROP POLICY IF EXISTS mtto_usuario_rol_insert ON public.mtto_usuario_rol;
CREATE POLICY mtto_usuario_rol_insert ON public.mtto_usuario_rol
    FOR INSERT WITH CHECK (public.mtto_es_admin_modulo() AND org_id = public.get_my_org_id());

DROP POLICY IF EXISTS mtto_usuario_rol_update ON public.mtto_usuario_rol;
CREATE POLICY mtto_usuario_rol_update ON public.mtto_usuario_rol
    FOR UPDATE USING (public.mtto_es_admin_modulo() AND org_id = public.get_my_org_id());

DROP POLICY IF EXISTS mtto_usuario_rol_delete ON public.mtto_usuario_rol;
CREATE POLICY mtto_usuario_rol_delete ON public.mtto_usuario_rol
    FOR DELETE USING (public.mtto_es_admin_modulo() AND org_id = public.get_my_org_id());

-- mtto_vehiculo: lectura para el módulo; escritura solo admin.
DROP POLICY IF EXISTS mtto_vehiculo_select ON public.mtto_vehiculo;
CREATE POLICY mtto_vehiculo_select ON public.mtto_vehiculo
    FOR SELECT USING (public.mtto_tiene_rol_modulo() AND org_id = public.get_my_org_id());

DROP POLICY IF EXISTS mtto_vehiculo_insert ON public.mtto_vehiculo;
CREATE POLICY mtto_vehiculo_insert ON public.mtto_vehiculo
    FOR INSERT WITH CHECK (public.mtto_es_admin_modulo() AND org_id = public.get_my_org_id());

DROP POLICY IF EXISTS mtto_vehiculo_update ON public.mtto_vehiculo;
CREATE POLICY mtto_vehiculo_update ON public.mtto_vehiculo
    FOR UPDATE USING (public.mtto_es_admin_modulo() AND org_id = public.get_my_org_id());

-- Maestros globales (checklist y catálogo): lectura para el módulo,
-- escritura solo para admin del módulo.
DROP POLICY IF EXISTS mtto_checklist_seccion_select ON public.mtto_checklist_seccion;
CREATE POLICY mtto_checklist_seccion_select ON public.mtto_checklist_seccion
    FOR SELECT USING (public.mtto_tiene_rol_modulo());
DROP POLICY IF EXISTS mtto_checklist_seccion_write ON public.mtto_checklist_seccion;
CREATE POLICY mtto_checklist_seccion_write ON public.mtto_checklist_seccion
    FOR ALL USING (public.mtto_es_admin_modulo()) WITH CHECK (public.mtto_es_admin_modulo());

DROP POLICY IF EXISTS mtto_checklist_item_select ON public.mtto_checklist_item;
CREATE POLICY mtto_checklist_item_select ON public.mtto_checklist_item
    FOR SELECT USING (public.mtto_tiene_rol_modulo());
DROP POLICY IF EXISTS mtto_checklist_item_write ON public.mtto_checklist_item;
CREATE POLICY mtto_checklist_item_write ON public.mtto_checklist_item
    FOR ALL USING (public.mtto_es_admin_modulo()) WITH CHECK (public.mtto_es_admin_modulo());

DROP POLICY IF EXISTS mtto_catalogo_sistema_select ON public.mtto_catalogo_sistema;
CREATE POLICY mtto_catalogo_sistema_select ON public.mtto_catalogo_sistema
    FOR SELECT USING (public.mtto_tiene_rol_modulo());
DROP POLICY IF EXISTS mtto_catalogo_sistema_write ON public.mtto_catalogo_sistema;
CREATE POLICY mtto_catalogo_sistema_write ON public.mtto_catalogo_sistema
    FOR ALL USING (public.mtto_es_admin_modulo()) WITH CHECK (public.mtto_es_admin_modulo());

DROP POLICY IF EXISTS mtto_catalogo_arreglo_select ON public.mtto_catalogo_arreglo;
CREATE POLICY mtto_catalogo_arreglo_select ON public.mtto_catalogo_arreglo
    FOR SELECT USING (public.mtto_tiene_rol_modulo());
DROP POLICY IF EXISTS mtto_catalogo_arreglo_write ON public.mtto_catalogo_arreglo;
CREATE POLICY mtto_catalogo_arreglo_write ON public.mtto_catalogo_arreglo
    FOR ALL USING (public.mtto_es_admin_modulo()) WITH CHECK (public.mtto_es_admin_modulo());

-- mtto_orden: lectura para el módulo; insert de mecánico/admin;
-- update solo del creador y solo mientras está en borrador.
DROP POLICY IF EXISTS mtto_orden_select ON public.mtto_orden;
CREATE POLICY mtto_orden_select ON public.mtto_orden
    FOR SELECT USING (public.mtto_tiene_rol_modulo() AND org_id = public.get_my_org_id());

DROP POLICY IF EXISTS mtto_orden_insert ON public.mtto_orden;
CREATE POLICY mtto_orden_insert ON public.mtto_orden
    FOR INSERT WITH CHECK (
        public.mtto_tiene_rol('mecanico')
        AND creado_por = auth.uid()
        AND estado = 'borrador'
        AND EXISTS (
            SELECT 1 FROM public.mtto_vehiculo v
            WHERE v.id = vehiculo_id AND v.org_id = public.get_my_org_id()
        )
    );

DROP POLICY IF EXISTS mtto_orden_update ON public.mtto_orden;
CREATE POLICY mtto_orden_update ON public.mtto_orden
    FOR UPDATE USING (
        creado_por = auth.uid()
        AND estado = 'borrador'
        AND org_id = public.get_my_org_id()
    );

-- mtto_orden_hallazgo / foto / reparacion: mismo dueño, misma ventana de borrador.
DROP POLICY IF EXISTS mtto_hallazgo_select ON public.mtto_orden_hallazgo;
CREATE POLICY mtto_hallazgo_select ON public.mtto_orden_hallazgo
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM public.mtto_orden o
        WHERE o.id = orden_id AND o.org_id = public.get_my_org_id()
    ) AND public.mtto_tiene_rol_modulo());

DROP POLICY IF EXISTS mtto_hallazgo_insert ON public.mtto_orden_hallazgo;
CREATE POLICY mtto_hallazgo_insert ON public.mtto_orden_hallazgo
    FOR INSERT WITH CHECK (
        public.mtto_tiene_rol('mecanico')
        AND EXISTS (
            SELECT 1 FROM public.mtto_orden o
            WHERE o.id = orden_id AND o.creado_por = auth.uid() AND o.estado = 'borrador'
        )
    );

DROP POLICY IF EXISTS mtto_hallazgo_update ON public.mtto_orden_hallazgo;
CREATE POLICY mtto_hallazgo_update ON public.mtto_orden_hallazgo
    FOR UPDATE USING (EXISTS (
        SELECT 1 FROM public.mtto_orden o
        WHERE o.id = orden_id AND o.creado_por = auth.uid() AND o.estado = 'borrador'
    ));

DROP POLICY IF EXISTS mtto_hallazgo_delete ON public.mtto_orden_hallazgo;
CREATE POLICY mtto_hallazgo_delete ON public.mtto_orden_hallazgo
    FOR DELETE USING (EXISTS (
        SELECT 1 FROM public.mtto_orden o
        WHERE o.id = orden_id AND o.creado_por = auth.uid() AND o.estado = 'borrador'
    ));

DROP POLICY IF EXISTS mtto_foto_select ON public.mtto_orden_foto;
CREATE POLICY mtto_foto_select ON public.mtto_orden_foto
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM public.mtto_orden_hallazgo h
        JOIN public.mtto_orden o ON o.id = h.orden_id
        WHERE h.id = hallazgo_id AND o.org_id = public.get_my_org_id()
    ) AND public.mtto_tiene_rol_modulo());

DROP POLICY IF EXISTS mtto_foto_insert ON public.mtto_orden_foto;
CREATE POLICY mtto_foto_insert ON public.mtto_orden_foto
    FOR INSERT WITH CHECK (
        public.mtto_tiene_rol('mecanico')
        AND EXISTS (
            SELECT 1 FROM public.mtto_orden_hallazgo h
            JOIN public.mtto_orden o ON o.id = h.orden_id
            WHERE h.id = hallazgo_id AND o.creado_por = auth.uid() AND o.estado = 'borrador'
        )
    );

DROP POLICY IF EXISTS mtto_foto_delete ON public.mtto_orden_foto;
CREATE POLICY mtto_foto_delete ON public.mtto_orden_foto
    FOR DELETE USING (EXISTS (
        SELECT 1 FROM public.mtto_orden_hallazgo h
        JOIN public.mtto_orden o ON o.id = h.orden_id
        WHERE h.id = hallazgo_id AND o.creado_por = auth.uid() AND o.estado = 'borrador'
    ));

DROP POLICY IF EXISTS mtto_reparacion_select ON public.mtto_orden_reparacion;
CREATE POLICY mtto_reparacion_select ON public.mtto_orden_reparacion
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM public.mtto_orden o
        WHERE o.id = orden_id AND o.org_id = public.get_my_org_id()
    ) AND public.mtto_tiene_rol_modulo());

DROP POLICY IF EXISTS mtto_reparacion_insert ON public.mtto_orden_reparacion;
CREATE POLICY mtto_reparacion_insert ON public.mtto_orden_reparacion
    FOR INSERT WITH CHECK (
        public.mtto_tiene_rol('mecanico')
        AND EXISTS (
            SELECT 1 FROM public.mtto_orden o
            WHERE o.id = orden_id AND o.creado_por = auth.uid() AND o.estado = 'borrador'
        )
    );

DROP POLICY IF EXISTS mtto_reparacion_update ON public.mtto_orden_reparacion;
CREATE POLICY mtto_reparacion_update ON public.mtto_orden_reparacion
    FOR UPDATE USING (EXISTS (
        SELECT 1 FROM public.mtto_orden o
        WHERE o.id = orden_id AND o.creado_por = auth.uid() AND o.estado = 'borrador'
    ));

DROP POLICY IF EXISTS mtto_reparacion_delete ON public.mtto_orden_reparacion;
CREATE POLICY mtto_reparacion_delete ON public.mtto_orden_reparacion
    FOR DELETE USING (EXISTS (
        SELECT 1 FROM public.mtto_orden o
        WHERE o.id = orden_id AND o.creado_por = auth.uid() AND o.estado = 'borrador'
    ));

-- mtto_orden_evento: sin policy de insert/update/delete — solo
-- escriben las funciones RPC (SECURITY DEFINER, corren como dueño
-- de la tabla y por lo tanto no están sujetas a RLS).
DROP POLICY IF EXISTS mtto_evento_select ON public.mtto_orden_evento;
CREATE POLICY mtto_evento_select ON public.mtto_orden_evento
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM public.mtto_orden o
        WHERE o.id = orden_id AND o.org_id = public.get_my_org_id()
    ) AND public.mtto_tiene_rol_modulo());

-- ============================================================
-- 8. STORAGE — bucket privado mtto-fotos
-- Ruta: mtto-fotos/{orden_id}/{hallazgo_id}/{uuid}.jpg
-- ============================================================

INSERT INTO storage.buckets (id, name, public)
VALUES ('mtto-fotos', 'mtto-fotos', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS mtto_fotos_select ON storage.objects;
CREATE POLICY mtto_fotos_select ON storage.objects
    FOR SELECT TO authenticated USING (
        bucket_id = 'mtto-fotos'
        AND public.mtto_tiene_rol_modulo()
        AND EXISTS (
            SELECT 1 FROM public.mtto_orden o
            WHERE o.id::text = (storage.foldername(name))[1]
              AND o.org_id = public.get_my_org_id()
        )
    );

DROP POLICY IF EXISTS mtto_fotos_insert ON storage.objects;
CREATE POLICY mtto_fotos_insert ON storage.objects
    FOR INSERT TO authenticated WITH CHECK (
        bucket_id = 'mtto-fotos'
        AND public.mtto_tiene_rol('mecanico')
        AND EXISTS (
            SELECT 1 FROM public.mtto_orden_hallazgo h
            JOIN public.mtto_orden o ON o.id = h.orden_id
            WHERE h.id::text = (storage.foldername(name))[2]
              AND o.id::text = (storage.foldername(name))[1]
              AND o.creado_por = auth.uid()
              AND o.estado = 'borrador'
        )
    );

DROP POLICY IF EXISTS mtto_fotos_delete ON storage.objects;
CREATE POLICY mtto_fotos_delete ON storage.objects
    FOR DELETE TO authenticated USING (
        bucket_id = 'mtto-fotos'
        AND EXISTS (
            SELECT 1 FROM public.mtto_orden_hallazgo h
            JOIN public.mtto_orden o ON o.id = h.orden_id
            WHERE h.id::text = (storage.foldername(name))[2]
              AND o.id::text = (storage.foldername(name))[1]
              AND o.creado_por = auth.uid()
              AND o.estado = 'borrador'
        )
    );

NOTIFY pgrst, 'reload schema';
