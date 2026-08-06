-- ============================================================
-- MÓDULO DE MANTENIMIENTO VEHICULAR (mtto_*)
-- Fase adicional: VIDA ÚTIL DE LOS REPUESTOS.
--
-- Cada arreglo del catálogo puede declarar cuánto dura lo que se
-- instala: en kilómetros, en meses, o en ambos (vence lo que ocurra
-- primero). Los arreglos que no son cambio de pieza —un diagnóstico,
-- una soldadura— se dejan en NULL y sencillamente no vencen.
--
-- CUÁNDO EMPIEZA A CONTAR: al CERRAR la orden, que es cuando el
-- trabajo está hecho de verdad. Al cerrarla se registra, por cada
-- reparación autorizada cuyo arreglo tenga vida útil, qué se instaló,
-- en qué vehículo, en qué fecha y con qué kilometraje, y cuándo
-- vence.
--
-- LIMITACIÓN CONOCIDA: el kilometraje solo se conoce cuando entra una
-- orden. Si un vehículo no vuelve al taller en meses, el sistema sigue
-- creyendo que tiene los km de la última visita y la alerta por km
-- llegará tarde. Se aceptó a propósito para no imponer un registro
-- periódico de odómetro. La alerta por TIEMPO sí es exacta siempre.
--
-- Requiere mtto_1_schema y mtto_3_rpc. Idempotente.
-- ============================================================

-- ------------------------------------------------------------
-- 1. VIDA ÚTIL EN EL CATÁLOGO
-- ------------------------------------------------------------
ALTER TABLE public.mtto_catalogo_arreglo
    ADD COLUMN IF NOT EXISTS vida_util_km    int,
    ADD COLUMN IF NOT EXISTS vida_util_meses int;

DO $$ BEGIN
    ALTER TABLE public.mtto_catalogo_arreglo
        ADD CONSTRAINT mtto_arreglo_vida_util_positiva
        CHECK ((vida_util_km IS NULL OR vida_util_km > 0)
           AND (vida_util_meses IS NULL OR vida_util_meses > 0));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.mtto_catalogo_arreglo.vida_util_km IS
    'Duración esperada en kilómetros. NULL = no aplica (no es cambio de pieza).';
COMMENT ON COLUMN public.mtto_catalogo_arreglo.vida_util_meses IS
    'Duración esperada en meses. NULL = no aplica. Si hay ambos, vence el primero.';

-- ------------------------------------------------------------
-- 2. ÚLTIMO KILOMETRAJE CONOCIDO DEL VEHÍCULO
-- Se actualiza solo, con cada orden que traiga kilometraje.
-- ------------------------------------------------------------
ALTER TABLE public.mtto_vehiculo
    ADD COLUMN IF NOT EXISTS km_actual      int,
    ADD COLUMN IF NOT EXISTS km_actualizado date;

COMMENT ON COLUMN public.mtto_vehiculo.km_actual IS
    'Último kilometraje conocido, tomado de la orden más reciente. No es en tiempo real.';

-- ------------------------------------------------------------
-- 3. COMPONENTES INSTALADOS
-- Un registro por cada repuesto con vida útil que se instaló.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mtto_componente_instalado (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    vehiculo_id   uuid NOT NULL REFERENCES public.mtto_vehiculo(id) ON DELETE CASCADE,
    arreglo_id    uuid NOT NULL REFERENCES public.mtto_catalogo_arreglo(id),
    orden_id      uuid NOT NULL REFERENCES public.mtto_orden(id) ON DELETE CASCADE,
    reparacion_id uuid REFERENCES public.mtto_orden_reparacion(id) ON DELETE SET NULL,
    descripcion   text NOT NULL,          -- texto congelado, como en la cotización
    repuesto      text,
    instalado_el  date NOT NULL,
    instalado_km  int,
    vence_el      date,                   -- calculado con vida_util_meses
    vence_km      int,                    -- calculado con vida_util_km
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (orden_id, reparacion_id)
);

CREATE INDEX IF NOT EXISTS idx_mtto_componente_vehiculo ON public.mtto_componente_instalado(vehiculo_id);

ALTER TABLE public.mtto_componente_instalado ENABLE ROW LEVEL SECURITY;

-- Solo lectura desde el cliente: las filas las escribe el cierre de orden.
DROP POLICY IF EXISTS mtto_componente_select ON public.mtto_componente_instalado;
CREATE POLICY mtto_componente_select ON public.mtto_componente_instalado
    FOR SELECT USING (EXISTS (
        SELECT 1 FROM public.mtto_vehiculo v
        WHERE v.id = vehiculo_id AND v.org_id = public.get_my_org_id()
    ) AND public.mtto_tiene_rol_modulo());

-- ------------------------------------------------------------
-- 4. CERRAR ORDEN: además de cerrar, registra los componentes
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_cerrar_orden(p_orden_id uuid, p_notas text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_orden public.mtto_orden%ROWTYPE;
    v_registrados int := 0;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Debe iniciar sesión';
    END IF;

    SELECT * INTO v_orden FROM public.mtto_orden WHERE id = p_orden_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Orden % no existe', p_orden_id;
    END IF;

    IF NOT (public.mtto_tiene_rol('mecanico') OR public.mtto_es_admin_modulo()) THEN
        RAISE EXCEPTION 'Se requiere rol de mecánico o admin';
    END IF;
    IF NOT (v_orden.creado_por = auth.uid() OR public.mtto_es_admin_modulo()) THEN
        RAISE EXCEPTION 'Solo el mecánico dueño de la orden o un admin puede cerrarla';
    END IF;
    IF v_orden.estado <> 'en_ejecucion' THEN
        RAISE EXCEPTION 'Solo se puede cerrar una orden en en_ejecucion (estado actual: %)', v_orden.estado;
    END IF;

    UPDATE public.mtto_orden SET estado = 'cerrada', cerrado_at = now() WHERE id = p_orden_id;

    -- Último kilometraje conocido del vehículo
    IF v_orden.kilometraje IS NOT NULL THEN
        UPDATE public.mtto_vehiculo
        SET km_actual = v_orden.kilometraje, km_actualizado = v_orden.fecha
        WHERE id = v_orden.vehiculo_id
          AND (km_actual IS NULL OR v_orden.kilometraje >= km_actual);
    END IF;

    -- Registro de componentes: solo líneas AUTORIZADAS cuyo arreglo del
    -- catálogo declare vida útil. Lo demás (diagnósticos, soldaduras) no
    -- genera vencimiento.
    INSERT INTO public.mtto_componente_instalado
        (vehiculo_id, arreglo_id, orden_id, reparacion_id, descripcion, repuesto,
         instalado_el, instalado_km, vence_el, vence_km)
    SELECT
        v_orden.vehiculo_id,
        r.arreglo_id,
        p_orden_id,
        r.id,
        r.descripcion,
        r.repuesto,
        v_orden.fecha,
        v_orden.kilometraje,
        CASE WHEN a.vida_util_meses IS NOT NULL
             THEN v_orden.fecha + make_interval(months => a.vida_util_meses) END,
        CASE WHEN a.vida_util_km IS NOT NULL AND v_orden.kilometraje IS NOT NULL
             THEN v_orden.kilometraje + a.vida_util_km END
    FROM public.mtto_orden_reparacion r
    JOIN public.mtto_catalogo_arreglo a ON a.id = r.arreglo_id
    WHERE r.orden_id = p_orden_id
      AND r.autorizado
      AND (a.vida_util_km IS NOT NULL OR a.vida_util_meses IS NOT NULL)
    ON CONFLICT (orden_id, reparacion_id) DO NOTHING;

    GET DIAGNOSTICS v_registrados = ROW_COUNT;

    INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, accion, detalle)
    VALUES (p_orden_id, auth.uid(), 'cerrado',
            jsonb_build_object('notas', p_notas, 'componentes_registrados', v_registrados));
END;
$$;

REVOKE ALL ON FUNCTION public.mtto_cerrar_orden(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mtto_cerrar_orden(uuid, text) TO authenticated;

-- ------------------------------------------------------------
-- 5. VISTA DE ESTADO DE COMPONENTES
-- Para cada repuesto instalado muestra si ya venció y por qué.
-- Solo la instalación MÁS RECIENTE de cada arreglo por vehículo:
-- si la pieza se volvió a cambiar, el contador se reinicia.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW public.mtto_v_componente_estado
WITH (security_invoker = on) AS
WITH ultimos AS (
    SELECT DISTINCT ON (ci.vehiculo_id, ci.arreglo_id)
        ci.*
    FROM public.mtto_componente_instalado ci
    ORDER BY ci.vehiculo_id, ci.arreglo_id, ci.instalado_el DESC, ci.created_at DESC
)
SELECT
    u.id,
    u.vehiculo_id,
    v.codigo AS vehiculo,
    u.arreglo_id,
    u.descripcion,
    u.repuesto,
    u.instalado_el,
    u.instalado_km,
    u.vence_el,
    u.vence_km,
    v.km_actual,
    -- Días para vencer por tiempo (negativo = ya venció)
    CASE WHEN u.vence_el IS NOT NULL THEN (u.vence_el - current_date) END AS dias_restantes,
    -- Km para vencer, con el último kilometraje conocido
    CASE WHEN u.vence_km IS NOT NULL AND v.km_actual IS NOT NULL
         THEN (u.vence_km - v.km_actual) END AS km_restantes,
    -- Vence lo que ocurra primero
    (
        (u.vence_el IS NOT NULL AND u.vence_el <= current_date)
        OR (u.vence_km IS NOT NULL AND v.km_actual IS NOT NULL AND v.km_actual >= u.vence_km)
    ) AS vencido,
    (
        (u.vence_el IS NOT NULL AND u.vence_el > current_date AND u.vence_el <= current_date + 30)
        OR (u.vence_km IS NOT NULL AND v.km_actual IS NOT NULL
            AND v.km_actual < u.vence_km AND (u.vence_km - v.km_actual) <= 500)
    ) AS por_vencer
FROM ultimos u
JOIN public.mtto_vehiculo v ON v.id = u.vehiculo_id;

NOTIFY pgrst, 'reload schema';
