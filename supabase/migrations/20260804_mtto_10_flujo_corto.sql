-- ============================================================
-- MÓDULO DE MANTENIMIENTO VEHICULAR (mtto_*)
-- Fase adicional: FLUJO CORTO (dos enlaces en vez de tres).
--
-- Flujo real acordado:
--   1. El administrador crea la orden y manda un enlace al SUPERVISOR.
--   2. El supervisor va al taller, le pregunta al mecánico, marca los
--      ítems, toma las fotos, cotiza y envía con su PIN.
--   3. El administrador manda el enlace de aprobación al APROBADOR.
--   4. El aprobador revisa, escribe observaciones y decide.
--
-- CAMBIO RESPECTO A LA VERSIÓN ANTERIOR: el paso intermedio de
-- "revisión del encargado de flota" ya no es una parada aparte. El
-- envío del supervisor cuenta como diagnóstico Y como revisión, y
-- la orden pasa directo a en_aprobacion.
--
-- La trazabilidad NO se pierde: se registran los dos eventos
-- (enviado_a_revision y revisado) firmados por el supervisor, y la
-- orden guarda revisado_por / revisado_por_firmante como siempre.
-- Así el aprobador ve quién validó antes que él.
--
-- También se permite que el destinatario del enlace de diagnóstico
-- sea un usuario CON cuenta (el supervisor), no solo un firmante.
--
-- Requiere mtto_9. Idempotente: reemplaza la función.
-- ============================================================

-- El destinatario del enlace de diagnóstico ahora puede ser un usuario
-- con cuenta (el supervisor). La vista debe resolver su nombre también,
-- no solo el de los firmantes sin cuenta.
CREATE OR REPLACE FUNCTION public.mtto_ver_diagnostico_por_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_tok public.mtto_firma_token;
    v_res jsonb;
    v_tipo public.mtto_tipo_vehiculo;
BEGIN
    v_tok := public.mtto_resolver_token(p_token);
    IF v_tok.accion <> 'diagnosticar' THEN
        RAISE EXCEPTION 'Este enlace no es de diagnóstico';
    END IF;

    SELECT v.tipo INTO v_tipo
    FROM public.mtto_orden o JOIN public.mtto_vehiculo v ON v.id = o.vehiculo_id
    WHERE o.id = v_tok.orden_id;

    SELECT jsonb_build_object(
        'expira_at', v_tok.expira_at,
        'mecanico', COALESCE(
            (SELECT jsonb_build_object('nombre', f.nombre, 'documento', f.documento)
             FROM public.mtto_firmante f WHERE f.id = v_tok.firmante_id),
            (SELECT jsonb_build_object('nombre', p.full_name, 'documento', NULL)
             FROM public.profiles p WHERE p.id = v_tok.usuario_id)
        ),
        'orden', jsonb_build_object(
            'id', o.id, 'numero', o.numero, 'fecha', o.fecha, 'estado', o.estado,
            'tipo_servicio', o.tipo_servicio, 'taller', o.taller, 'motivo', o.motivo,
            'kilometraje', o.kilometraje, 'diagnostico', o.diagnostico, 'iva_tasa', o.iva_tasa
        ),
        'vehiculo', jsonb_build_object(
            'codigo', v.codigo, 'placa', v.placa, 'tipo', v.tipo,
            'marca', v.marca, 'linea', v.linea, 'num_motor', v.num_motor, 'num_chasis', v.num_chasis
        ),
        'secciones', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', cs.id, 'nombre', cs.nombre, 'orden', cs.orden,
                'items', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object('id', ci.id, 'nombre', ci.nombre, 'critico', ci.critico) ORDER BY ci.orden)
                    FROM public.mtto_checklist_item ci
                    WHERE ci.seccion_id = cs.id AND ci.activo
                      AND (ci.aplica IS NULL OR v_tipo = ANY (ci.aplica))
                ), '[]'::jsonb)
            ) ORDER BY cs.orden)
            FROM public.mtto_checklist_seccion cs
            WHERE (cs.aplica IS NULL OR v_tipo = ANY (cs.aplica))
        ), '[]'::jsonb),
        'catalogo', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'sistema', s.nombre,
                'arreglos', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'nombre', a.nombre,
                                                        'precio_repuesto_ref', a.precio_repuesto_ref,
                                                        'precio_mo_ref', a.precio_mo_ref) ORDER BY a.nombre)
                    FROM public.mtto_catalogo_arreglo a WHERE a.sistema_id = s.id AND a.activo
                ), '[]'::jsonb)
            ) ORDER BY s.orden)
            FROM public.mtto_catalogo_sistema s
        ), '[]'::jsonb)
    ) INTO v_res
    FROM public.mtto_orden o
    JOIN public.mtto_vehiculo v ON v.id = o.vehiculo_id
    WHERE o.id = v_tok.orden_id;

    RETURN v_res;
END;
$$;

REVOKE ALL ON FUNCTION public.mtto_ver_diagnostico_por_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mtto_ver_diagnostico_por_token(text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.mtto_guardar_diagnostico_por_token(
    p_token text,
    p_pin text,
    p_hallazgos jsonb,
    p_reparaciones jsonb,
    p_diagnostico text DEFAULT NULL,
    p_kilometraje int DEFAULT NULL,
    p_iva_tasa numeric DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_tok public.mtto_firma_token;
    v_estado public.mtto_estado_orden;
    v_h jsonb;
    v_r jsonb;
    v_hallazgo_id uuid;
    v_reparacion_id uuid;
    v_foto text;
    v_sin_obs int;
    v_sin_foto int;
    v_hay_malo boolean;
    v_reparaciones int;
BEGIN
    v_tok := public.mtto_resolver_token(p_token);
    IF v_tok.accion <> 'diagnosticar' THEN
        RAISE EXCEPTION 'Este enlace no es de diagnóstico';
    END IF;

    -- El destinatario puede ser una persona sin cuenta o el supervisor,
    -- que sí tiene. En ambos casos el PIN es el que prueba la identidad.
    IF v_tok.firmante_id IS NOT NULL THEN
        PERFORM public.mtto_validar_pin_firmante(v_tok.firmante_id, p_pin);
    ELSE
        PERFORM public.mtto_validar_pin(v_tok.usuario_id, p_pin);
    END IF;

    SELECT estado INTO v_estado FROM public.mtto_orden WHERE id = v_tok.orden_id FOR UPDATE;
    IF v_estado <> 'borrador' THEN
        RAISE EXCEPTION 'La orden ya no está en borrador (estado actual: %)', v_estado;
    END IF;

    UPDATE public.mtto_orden
    SET diagnostico = COALESCE(p_diagnostico, diagnostico),
        kilometraje = COALESCE(p_kilometraje, kilometraje),
        iva_tasa = COALESCE(p_iva_tasa, iva_tasa)
    WHERE id = v_tok.orden_id;

    DELETE FROM public.mtto_orden_hallazgo WHERE orden_id = v_tok.orden_id;
    DELETE FROM public.mtto_orden_reparacion WHERE orden_id = v_tok.orden_id;

    FOR v_h IN SELECT * FROM jsonb_array_elements(COALESCE(p_hallazgos, '[]'::jsonb))
    LOOP
        INSERT INTO public.mtto_orden_hallazgo (orden_id, item_id, estado, observacion, creado_por)
        VALUES (v_tok.orden_id,
                (v_h->>'item_id')::uuid,
                (v_h->>'estado')::public.mtto_estado_item,
                NULLIF(btrim(COALESCE(v_h->>'observacion', '')), ''),
                v_tok.creado_por)
        RETURNING id INTO v_hallazgo_id;

        FOR v_foto IN SELECT jsonb_array_elements_text(COALESCE(v_h->'fotos', '[]'::jsonb))
        LOOP
            INSERT INTO public.mtto_orden_foto (hallazgo_id, path, mime, subido_por)
            VALUES (v_hallazgo_id, v_foto, 'image/jpeg', v_tok.creado_por);
        END LOOP;
    END LOOP;

    FOR v_r IN SELECT * FROM jsonb_array_elements(COALESCE(p_reparaciones, '[]'::jsonb))
    LOOP
        INSERT INTO public.mtto_orden_reparacion
            (orden_id, arreglo_id, descripcion, sistema, repuesto, cantidad, valor_unitario, mano_obra, prioridad)
        VALUES (v_tok.orden_id,
                NULLIF(v_r->>'arreglo_id', '')::uuid,
                COALESCE(NULLIF(btrim(v_r->>'descripcion'), ''), 'Reparación'),
                NULLIF(v_r->>'sistema', ''),
                NULLIF(v_r->>'repuesto', ''),
                COALESCE((v_r->>'cantidad')::numeric, 1),
                COALESCE((v_r->>'valor_unitario')::numeric, 0),
                COALESCE((v_r->>'mano_obra')::numeric, 0),
                COALESCE(NULLIF(v_r->>'prioridad', '')::public.mtto_prioridad, 'media'))
        RETURNING id INTO v_reparacion_id;

        FOR v_foto IN SELECT jsonb_array_elements_text(COALESCE(v_r->'fotos', '[]'::jsonb))
        LOOP
            INSERT INTO public.mtto_reparacion_foto (reparacion_id, path, mime, subido_por)
            VALUES (v_reparacion_id, v_foto, 'image/jpeg', v_tok.creado_por);
        END LOOP;
    END LOOP;

    -- ── VALIDACIONES DURAS (idénticas a mtto_enviar_a_revision) ──
    SELECT count(*) INTO v_sin_obs FROM public.mtto_orden_hallazgo
    WHERE orden_id = v_tok.orden_id AND estado IN ('R','M') AND btrim(coalesce(observacion,'')) = '';
    IF v_sin_obs > 0 THEN
        RAISE EXCEPTION 'Hay % ítem(s) en R o M sin observación escrita', v_sin_obs;
    END IF;

    SELECT count(*) INTO v_sin_foto FROM public.mtto_orden_hallazgo h
    WHERE h.orden_id = v_tok.orden_id AND h.estado = 'M'
      AND NOT EXISTS (SELECT 1 FROM public.mtto_orden_foto f WHERE f.hallazgo_id = h.id);
    IF v_sin_foto > 0 THEN
        RAISE EXCEPTION 'Hay % ítem(s) en M sin al menos una foto', v_sin_foto;
    END IF;

    SELECT EXISTS (SELECT 1 FROM public.mtto_orden_hallazgo WHERE orden_id = v_tok.orden_id AND estado = 'M')
    INTO v_hay_malo;
    IF v_hay_malo THEN
        SELECT count(*) INTO v_reparaciones FROM public.mtto_orden_reparacion WHERE orden_id = v_tok.orden_id;
        IF v_reparaciones = 0 THEN
            RAISE EXCEPTION 'Hay ítems en M pero no se ha cotizado ninguna reparación';
        END IF;
    END IF;

    -- ── FLUJO CORTO: pasa directo a en_aprobacion ──
    -- Quien capturó (el supervisor) queda registrado también como quien
    -- revisó, que es lo que ocurre en la realidad: estuvo en el taller
    -- con el mecánico y dio por buena la información.
    UPDATE public.mtto_orden
    SET estado = 'en_aprobacion',
        enviado_at = now(),
        revisado_por = v_tok.usuario_id,
        revisado_por_firmante = v_tok.firmante_id,
        revisado_at = now(),
        obs_encargado = COALESCE(p_diagnostico, obs_encargado)
    WHERE id = v_tok.orden_id;

    -- Los dos eventos, para que el historial no pierda ningún paso
    INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, firmante_id, accion, detalle)
    VALUES (v_tok.orden_id, v_tok.usuario_id, v_tok.firmante_id, 'enviado_a_revision',
            jsonb_build_object('desde', 'borrador', 'via', 'enlace_pin'));

    INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, firmante_id, accion, detalle)
    VALUES (v_tok.orden_id, v_tok.usuario_id, v_tok.firmante_id, 'revisado',
            jsonb_build_object('obs', p_diagnostico, 'via', 'enlace_pin',
                               'nota', 'Flujo corto: quien captura el diagnóstico también lo revisa'));

    UPDATE public.mtto_firma_token SET usado_at = now() WHERE id = v_tok.id;
END;
$$;

REVOKE ALL ON FUNCTION public.mtto_guardar_diagnostico_por_token(text, text, jsonb, jsonb, text, int, numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mtto_guardar_diagnostico_por_token(text, text, jsonb, jsonb, text, int, numeric) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
