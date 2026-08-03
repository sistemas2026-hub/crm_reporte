-- ============================================================
-- MÓDULO DE MANTENIMIENTO VEHICULAR (mtto_*)
-- Fase 3/3: funciones RPC de la máquina de estados.
--
--   borrador → en_revision → en_aprobacion → aprobada → en_ejecucion → cerrada
--                                          └→ rechazada
--
-- Todas SECURITY DEFINER (corren como dueño de las tablas, por lo
-- que no están sujetas a RLS) y validan rol + estado ellas mismas.
-- Cada una escribe una fila en mtto_orden_evento (append-only).
--
-- Requiere haber corrido 20260803_mtto_1_schema.sql antes.
-- ============================================================

-- ------------------------------------------------------------
-- mtto_enviar_a_revision — mecánico dueño de la orden
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_enviar_a_revision(p_orden_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_orden        public.mtto_orden%ROWTYPE;
    v_sin_obs      int;
    v_sin_foto     int;
    v_hay_malo     boolean;
    v_reparaciones int;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Debe iniciar sesión';
    END IF;

    SELECT * INTO v_orden FROM public.mtto_orden WHERE id = p_orden_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Orden % no existe', p_orden_id;
    END IF;

    IF v_orden.creado_por <> auth.uid() THEN
        RAISE EXCEPTION 'Solo el mecánico que creó la orden puede enviarla a revisión';
    END IF;

    IF NOT public.mtto_tiene_rol('mecanico') THEN
        RAISE EXCEPTION 'Se requiere rol de mecánico para enviar la orden a revisión';
    END IF;

    IF v_orden.estado <> 'borrador' THEN
        RAISE EXCEPTION 'Solo se puede enviar a revisión una orden en borrador (estado actual: %)', v_orden.estado;
    END IF;

    -- Regla 1: todo ítem en R o M debe tener observación escrita.
    -- (El CHECK de la tabla ya lo impide siempre; se revalida aquí
    -- para dar un mensaje de negocio claro y como segunda capa.)
    SELECT count(*) INTO v_sin_obs
    FROM public.mtto_orden_hallazgo
    WHERE orden_id = p_orden_id AND estado IN ('R', 'M') AND btrim(coalesce(observacion, '')) = '';
    IF v_sin_obs > 0 THEN
        RAISE EXCEPTION 'Hay % ítem(s) en R o M sin observación escrita', v_sin_obs;
    END IF;

    -- Regla 2: todo ítem en M debe tener al menos una foto.
    SELECT count(*) INTO v_sin_foto
    FROM public.mtto_orden_hallazgo h
    WHERE h.orden_id = p_orden_id AND h.estado = 'M'
      AND NOT EXISTS (SELECT 1 FROM public.mtto_orden_foto f WHERE f.hallazgo_id = h.id);
    IF v_sin_foto > 0 THEN
        RAISE EXCEPTION 'Hay % ítem(s) en M sin al menos una foto', v_sin_foto;
    END IF;

    -- Regla 3: si hay ítems en M, debe existir al menos una reparación cotizada.
    SELECT EXISTS (
        SELECT 1 FROM public.mtto_orden_hallazgo WHERE orden_id = p_orden_id AND estado = 'M'
    ) INTO v_hay_malo;

    IF v_hay_malo THEN
        SELECT count(*) INTO v_reparaciones FROM public.mtto_orden_reparacion WHERE orden_id = p_orden_id;
        IF v_reparaciones = 0 THEN
            RAISE EXCEPTION 'Hay ítems en M pero no se ha cotizado ninguna reparación';
        END IF;
    END IF;

    UPDATE public.mtto_orden SET estado = 'en_revision', enviado_at = now() WHERE id = p_orden_id;

    INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, accion, detalle)
    VALUES (p_orden_id, auth.uid(), 'enviado_a_revision', jsonb_build_object('desde', 'borrador'));
END;
$$;

-- ------------------------------------------------------------
-- mtto_revisar_orden — encargado de flota
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_revisar_orden(p_orden_id uuid, p_obs text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_estado public.mtto_estado_orden;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Debe iniciar sesión';
    END IF;

    IF NOT public.mtto_tiene_rol('encargado') THEN
        RAISE EXCEPTION 'Se requiere rol de encargado de flota';
    END IF;

    SELECT estado INTO v_estado FROM public.mtto_orden WHERE id = p_orden_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Orden % no existe', p_orden_id;
    END IF;
    IF v_estado <> 'en_revision' THEN
        RAISE EXCEPTION 'Solo se puede revisar una orden en en_revision (estado actual: %)', v_estado;
    END IF;

    UPDATE public.mtto_orden
    SET estado = 'en_aprobacion', revisado_por = auth.uid(), revisado_at = now(), obs_encargado = p_obs
    WHERE id = p_orden_id;

    INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, accion, detalle)
    VALUES (p_orden_id, auth.uid(), 'revisado', jsonb_build_object('obs', p_obs));
END;
$$;

-- ------------------------------------------------------------
-- mtto_aprobar_orden — responsable de mantenimiento vehicular
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_aprobar_orden(
    p_orden_id uuid,
    p_decision public.mtto_decision,
    p_obs text,
    p_valor_aprobado numeric,
    p_lineas_autorizadas uuid[] DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_estado       public.mtto_estado_orden;
    v_nuevo_estado public.mtto_estado_orden;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Debe iniciar sesión';
    END IF;

    IF NOT public.mtto_tiene_rol('aprobador') THEN
        RAISE EXCEPTION 'Se requiere rol de aprobador (responsable de mantenimiento vehicular)';
    END IF;

    SELECT estado INTO v_estado FROM public.mtto_orden WHERE id = p_orden_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Orden % no existe', p_orden_id;
    END IF;
    IF v_estado <> 'en_aprobacion' THEN
        RAISE EXCEPTION 'Solo se puede aprobar una orden en en_aprobacion (estado actual: %)', v_estado;
    END IF;

    IF p_decision = 'aprobado_parcial' THEN
        IF btrim(coalesce(p_obs, '')) = '' THEN
            RAISE EXCEPTION 'La aprobación parcial exige observaciones';
        END IF;
        IF p_lineas_autorizadas IS NULL OR array_length(p_lineas_autorizadas, 1) IS NULL THEN
            RAISE EXCEPTION 'La aprobación parcial exige indicar las líneas autorizadas';
        END IF;
    END IF;

    -- Habilita, solo dentro de esta transacción, la única excepción que el
    -- trigger de mtto_orden_reparacion permite fuera de borrador: marcar 'autorizado'.
    PERFORM set_config('mtto.autorizando', 'on', true);

    IF p_decision = 'aprobado' THEN
        UPDATE public.mtto_orden_reparacion SET autorizado = true WHERE orden_id = p_orden_id;
        v_nuevo_estado := 'aprobada';
    ELSIF p_decision = 'aprobado_parcial' THEN
        UPDATE public.mtto_orden_reparacion
        SET autorizado = (id = ANY (p_lineas_autorizadas))
        WHERE orden_id = p_orden_id;
        v_nuevo_estado := 'aprobada';
    ELSE
        UPDATE public.mtto_orden_reparacion SET autorizado = false WHERE orden_id = p_orden_id;
        v_nuevo_estado := 'rechazada';
    END IF;

    UPDATE public.mtto_orden
    SET estado = v_nuevo_estado,
        aprobado_por = auth.uid(),
        aprobado_at = now(),
        decision = p_decision,
        obs_aprobador = p_obs,
        valor_aprobado = p_valor_aprobado
    WHERE id = p_orden_id;

    INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, accion, detalle)
    VALUES (p_orden_id, auth.uid(), 'decision_aprobacion', jsonb_build_object(
        'decision', p_decision,
        'obs', p_obs,
        'valor_aprobado', p_valor_aprobado,
        'lineas_autorizadas', to_jsonb(p_lineas_autorizadas)
    ));
END;
$$;

-- ------------------------------------------------------------
-- mtto_devolver_orden — encargado o aprobador
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_devolver_orden(p_orden_id uuid, p_motivo text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_estado public.mtto_estado_orden;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Debe iniciar sesión';
    END IF;

    IF NOT (public.mtto_tiene_rol('encargado') OR public.mtto_tiene_rol('aprobador')) THEN
        RAISE EXCEPTION 'Se requiere rol de encargado o de aprobador para devolver la orden';
    END IF;

    IF btrim(coalesce(p_motivo, '')) = '' THEN
        RAISE EXCEPTION 'Debe indicar el motivo de la devolución';
    END IF;

    SELECT estado INTO v_estado FROM public.mtto_orden WHERE id = p_orden_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Orden % no existe', p_orden_id;
    END IF;
    IF v_estado NOT IN ('en_revision', 'en_aprobacion') THEN
        RAISE EXCEPTION 'Solo se puede devolver una orden en en_revision o en_aprobacion (estado actual: %)', v_estado;
    END IF;

    UPDATE public.mtto_orden SET estado = 'borrador', enviado_at = NULL WHERE id = p_orden_id;

    INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, accion, detalle)
    VALUES (p_orden_id, auth.uid(), 'devuelto', jsonb_build_object('desde', v_estado, 'motivo', p_motivo));
END;
$$;

-- ------------------------------------------------------------
-- mtto_iniciar_ejecucion — mecánico dueño o admin
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_iniciar_ejecucion(p_orden_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_orden public.mtto_orden%ROWTYPE;
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
        RAISE EXCEPTION 'Solo el mecánico dueño de la orden o un admin puede iniciar la ejecución';
    END IF;
    IF v_orden.estado <> 'aprobada' THEN
        RAISE EXCEPTION 'Solo se puede iniciar ejecución desde aprobada (estado actual: %)', v_orden.estado;
    END IF;

    UPDATE public.mtto_orden SET estado = 'en_ejecucion' WHERE id = p_orden_id;

    INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, accion, detalle)
    VALUES (p_orden_id, auth.uid(), 'inicio_ejecucion', '{}'::jsonb);
END;
$$;

-- ------------------------------------------------------------
-- mtto_cerrar_orden — mecánico dueño o admin
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_cerrar_orden(p_orden_id uuid, p_notas text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_orden public.mtto_orden%ROWTYPE;
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

    INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, accion, detalle)
    VALUES (p_orden_id, auth.uid(), 'cerrado', jsonb_build_object('notas', p_notas));
END;
$$;

-- ------------------------------------------------------------
-- Permisos: solo authenticated puede ejecutar estas RPC.
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.mtto_enviar_a_revision(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mtto_revisar_orden(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mtto_aprobar_orden(uuid, public.mtto_decision, text, numeric, uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mtto_devolver_orden(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mtto_iniciar_ejecucion(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mtto_cerrar_orden(uuid, text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.mtto_enviar_a_revision(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mtto_revisar_orden(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mtto_aprobar_orden(uuid, public.mtto_decision, text, numeric, uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mtto_devolver_orden(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mtto_iniciar_ejecucion(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.mtto_cerrar_orden(uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
