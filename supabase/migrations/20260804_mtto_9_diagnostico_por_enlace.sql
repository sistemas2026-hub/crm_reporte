-- ============================================================
-- MÓDULO DE MANTENIMIENTO VEHICULAR (mtto_*)
-- Fase adicional: el MECÁNICO llena el diagnóstico por enlace.
--
-- Contexto: el mecánico es externo y no tiene cuenta. Un supervisor
-- (que sí tiene) crea la orden y le manda un enlace por WhatsApp. El
-- mecánico lo abre en su celular, entra su PIN, marca los ítems en
-- R/M/NA, escribe observaciones, toma fotos, cotiza, y envía. Ahí la
-- orden pasa a en_revision y sigue el flujo normal.
--
-- DISEÑO: todo el diagnóstico se guarda en UNA sola llamada al
-- enviar. Así el PIN se valida una vez (bcrypt es costoso, no
-- conviene por cada toque), todo entra en una transacción, y las
-- validaciones duras corren en un solo lugar.
--
-- Requiere mtto_1_schema, mtto_6_fotos_reparacion, mtto_7_firmantes
-- y mtto_8_firma_por_enlace. Idempotente.
-- ============================================================

-- 1. La misma tabla de tokens sirve; se agrega la acción.
ALTER TABLE public.mtto_firma_token DROP CONSTRAINT IF EXISTS mtto_firma_token_accion_check;
ALTER TABLE public.mtto_firma_token
    ADD CONSTRAINT mtto_firma_token_accion_check
    CHECK (accion IN ('revisar', 'aprobar', 'diagnosticar'));

-- El generador exigía que la orden estuviera en en_revision/en_aprobacion.
-- Para 'diagnosticar' debe estar en borrador.
CREATE OR REPLACE FUNCTION public.mtto_generar_token_firma(
    p_orden_id uuid,
    p_accion text,
    p_firmante_id uuid DEFAULT NULL,
    p_usuario_id uuid DEFAULT NULL,
    p_fotos jsonb DEFAULT '{}'::jsonb,
    p_horas int DEFAULT 48
)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_secreto text;
    v_id uuid;
    v_estado public.mtto_estado_orden;
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

    v_secreto := encode(gen_random_bytes(24), 'hex');

    INSERT INTO public.mtto_firma_token (orden_id, accion, firmante_id, usuario_id, secreto_hash, fotos, expira_at)
    VALUES (p_orden_id, p_accion, p_firmante_id, p_usuario_id,
            crypt(v_secreto, gen_salt('bf')), COALESCE(p_fotos, '{}'::jsonb),
            now() + make_interval(hours => GREATEST(1, LEAST(p_horas, 168))))
    RETURNING id INTO v_id;

    RETURN v_id::text || '.' || v_secreto;
END;
$$;

-- ------------------------------------------------------------
-- 2. VER EL FORMULARIO DE DIAGNÓSTICO (sin sesión)
-- Devuelve la orden, la ficha del vehículo, el checklist filtrado
-- por tipo de vehículo y el catálogo de arreglos.
-- ------------------------------------------------------------
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
        'mecanico', (
            SELECT jsonb_build_object('nombre', f.nombre, 'documento', f.documento)
            FROM public.mtto_firmante f WHERE f.id = v_tok.firmante_id
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

-- ------------------------------------------------------------
-- 3. GUARDAR Y ENVIAR EL DIAGNÓSTICO (sin sesión, con PIN)
--
-- p_hallazgos:    [{item_id, estado, observacion, fotos:[path,...]}]
-- p_reparaciones: [{arreglo_id, descripcion, sistema, repuesto,
--                   cantidad, valor_unitario, mano_obra, prioridad,
--                   fotos:[path,...]}]
--
-- Reemplaza por completo lo que hubiera antes en esa orden, y aplica
-- las MISMAS validaciones duras que mtto_enviar_a_revision.
-- ------------------------------------------------------------
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
    IF v_tok.firmante_id IS NULL THEN
        RAISE EXCEPTION 'Este enlace no tiene un mecánico asociado';
    END IF;

    PERFORM public.mtto_validar_pin_firmante(v_tok.firmante_id, p_pin);

    SELECT estado INTO v_estado FROM public.mtto_orden WHERE id = v_tok.orden_id FOR UPDATE;
    IF v_estado <> 'borrador' THEN
        RAISE EXCEPTION 'La orden ya no está en borrador (estado actual: %)', v_estado;
    END IF;

    -- Datos de cabecera
    UPDATE public.mtto_orden
    SET diagnostico = COALESCE(p_diagnostico, diagnostico),
        kilometraje = COALESCE(p_kilometraje, kilometraje),
        iva_tasa = COALESCE(p_iva_tasa, iva_tasa)
    WHERE id = v_tok.orden_id;

    -- Se reemplaza el diagnóstico completo (el mecánico manda todo junto)
    DELETE FROM public.mtto_orden_hallazgo WHERE orden_id = v_tok.orden_id;
    DELETE FROM public.mtto_orden_reparacion WHERE orden_id = v_tok.orden_id;

    -- Hallazgos + sus fotos
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

    -- Reparaciones + sus fotos
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

    -- ── MISMAS VALIDACIONES DURAS QUE mtto_enviar_a_revision ──
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

    -- Transición
    UPDATE public.mtto_orden SET estado = 'en_revision', enviado_at = now() WHERE id = v_tok.orden_id;

    INSERT INTO public.mtto_orden_evento (orden_id, usuario_id, firmante_id, accion, detalle)
    VALUES (v_tok.orden_id, NULL, v_tok.firmante_id, 'enviado_a_revision',
            jsonb_build_object('desde', 'borrador', 'via', 'enlace_pin'));

    UPDATE public.mtto_firma_token SET usado_at = now() WHERE id = v_tok.id;
END;
$$;

-- ------------------------------------------------------------
-- 4. STORAGE: subida de fotos sin sesión.
--
-- COMPROMISO CONSCIENTE: el rol anon puede escribir en el bucket,
-- pero SOLO bajo la carpeta de una orden que en este momento tenga
-- un enlace de diagnóstico vigente, sin usar y en borrador. Es una
-- ventana acotada a una orden y a la vigencia del enlace.
--
-- Queda un riesgo residual: quien adivinara el UUID de esa orden
-- podría subir archivos durante esa ventana. Se acepta porque el
-- UUID no es adivinable en la práctica y la alternativa (un servicio
-- intermedio con service_role) exige desplegar una Edge Function.
-- Si más adelante se quiere cerrar del todo, ese es el camino.
-- ------------------------------------------------------------
DROP POLICY IF EXISTS mtto_fotos_insert_anon ON storage.objects;
CREATE POLICY mtto_fotos_insert_anon ON storage.objects
    FOR INSERT TO anon WITH CHECK (
        bucket_id = 'mtto-fotos'
        AND EXISTS (
            SELECT 1 FROM public.mtto_firma_token t
            JOIN public.mtto_orden o ON o.id = t.orden_id
            WHERE t.orden_id::text = (storage.foldername(name))[1]
              AND t.accion = 'diagnosticar'
              AND t.usado_at IS NULL
              AND NOT t.anulado
              AND t.expira_at > now()
              AND o.estado = 'borrador'
        )
    );

-- Lectura de lo que él mismo acaba de subir, para ver la miniatura.
DROP POLICY IF EXISTS mtto_fotos_select_anon ON storage.objects;
CREATE POLICY mtto_fotos_select_anon ON storage.objects
    FOR SELECT TO anon USING (
        bucket_id = 'mtto-fotos'
        AND EXISTS (
            SELECT 1 FROM public.mtto_firma_token t
            JOIN public.mtto_orden o ON o.id = t.orden_id
            WHERE t.orden_id::text = (storage.foldername(name))[1]
              AND t.accion = 'diagnosticar'
              AND t.usado_at IS NULL
              AND NOT t.anulado
              AND t.expira_at > now()
              AND o.estado = 'borrador'
        )
    );

-- ------------------------------------------------------------
-- 5. PERMISOS
-- ------------------------------------------------------------
REVOKE ALL ON FUNCTION public.mtto_ver_diagnostico_por_token(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mtto_guardar_diagnostico_por_token(text, text, jsonb, jsonb, text, int, numeric) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.mtto_ver_diagnostico_por_token(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mtto_guardar_diagnostico_por_token(text, text, jsonb, jsonb, text, int, numeric) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
