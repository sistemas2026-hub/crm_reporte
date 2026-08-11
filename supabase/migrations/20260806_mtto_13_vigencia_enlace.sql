-- ============================================================
-- MÓDULO DE MANTENIMIENTO VEHICULAR (mtto_*)
-- Fase adicional: vigencia configurable del enlace.
--
-- Antes: 48 horas fijas, con tope de 7 días. En la práctica el
-- mecánico abre el enlace días después y ya está vencido, y hay que
-- estar disponible para regenerarlo.
--
-- Ahora:
--   - El tope sube a 1 año (8760 horas).
--   - p_horas = 0 significa SIN VENCIMIENTO. Se guarda como
--     'infinity'::timestamptz, que Postgres compara correctamente
--     contra now(), así que la validación de vencimiento sigue
--     funcionando igual sin tocar nada más.
--
-- Lo demás no cambia: el enlace sigue siendo de UN SOLO USO, sigue
-- anulándose al generar uno nuevo, y sigue dejando de servir si la
-- orden cambia de estado.
--
-- NOTA DE SEGURIDAD: mientras un enlace de diagnóstico esté vigente y
-- sin usar, el rol anon puede subir fotos bajo la carpeta de ESA
-- orden (ver mtto_9). Un enlace sin vencimiento mantiene esa ventana
-- abierta indefinidamente para esa orden. Como el enlace se anula al
-- usarse y la orden debe seguir en borrador, el riesgo es acotado,
-- pero conviene no dejar órdenes en borrador con enlaces eternos.
--
-- Requiere mtto_8 y mtto_9. Idempotente.
-- ============================================================

CREATE OR REPLACE FUNCTION public.mtto_generar_token_firma(
    p_orden_id uuid,
    p_accion text,
    p_firmante_id uuid DEFAULT NULL,
    p_usuario_id uuid DEFAULT NULL,
    p_fotos jsonb DEFAULT '{}'::jsonb,
    p_horas int DEFAULT 48
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
    v_secreto text;
    v_id uuid;
    v_estado public.mtto_estado_orden;
    v_expira timestamptz;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Debe iniciar sesión';
    END IF;
    IF NOT public.mtto_tiene_rol_modulo() THEN
        RAISE EXCEPTION 'No tiene rol en el módulo de mantenimiento';
    END IF;
    IF p_accion NOT IN ('revisar', 'aprobar', 'diagnosticar') THEN
        RAISE EXCEPTION 'Acción inválida';
    END IF;
    IF num_nonnulls(p_firmante_id, p_usuario_id) <> 1 THEN
        RAISE EXCEPTION 'Indique exactamente un destinatario';
    END IF;

    SELECT estado INTO v_estado FROM public.mtto_orden
    WHERE id = p_orden_id AND org_id = public.get_my_org_id();
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Orden no encontrada';
    END IF;
    IF (p_accion = 'diagnosticar' AND v_estado <> 'borrador')
       OR (p_accion = 'revisar' AND v_estado <> 'en_revision')
       OR (p_accion = 'aprobar' AND v_estado <> 'en_aprobacion') THEN
        RAISE EXCEPTION 'La orden no está en el estado que corresponde a esa acción (estado actual: %)', v_estado;
    END IF;

    UPDATE public.mtto_firma_token SET anulado = true
    WHERE orden_id = p_orden_id AND accion = p_accion AND usado_at IS NULL AND NOT anulado;

    -- 0 = sin vencimiento. Tope: 1 año.
    v_expira := CASE
        WHEN COALESCE(p_horas, 48) <= 0 THEN 'infinity'::timestamptz
        ELSE now() + make_interval(hours => LEAST(p_horas, 8760))
    END;

    v_secreto := encode(gen_random_bytes(24), 'hex');

    INSERT INTO public.mtto_firma_token (orden_id, accion, firmante_id, usuario_id, secreto_hash, fotos, expira_at)
    VALUES (p_orden_id, p_accion, p_firmante_id, p_usuario_id,
            crypt(v_secreto, gen_salt('bf')), COALESCE(p_fotos, '{}'::jsonb), v_expira)
    RETURNING id INTO v_id;

    RETURN v_id::text || '.' || v_secreto;
END;
$$;

REVOKE ALL ON FUNCTION public.mtto_generar_token_firma(uuid, text, uuid, uuid, jsonb, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mtto_generar_token_firma(uuid, text, uuid, uuid, jsonb, int) TO authenticated;

NOTIFY pgrst, 'reload schema';
