-- ============================================================
-- MÓDULO DE MANTENIMIENTO VEHICULAR (mtto_*)
-- Fase adicional: observaciones en ítems BUENOS, recomendaciones
-- del mecánico, y registro de cambios hechos fuera del sistema.
--
-- 1) OBSERVACIÓN EN ÍTEMS BUENOS
--    Hasta ahora mtto_orden_hallazgo tenía CHECK (estado <> 'B'):
--    un ítem bueno sencillamente no tenía fila. Eso mantiene la
--    inspección liviana, pero deja al mecánico sin dónde escribir
--    "las llantas están buenas pero les queda poco". Se relaja el
--    CHECK para permitir filas en 'B'.
--
--    OJO: no hace falta una regla nueva que obligue el texto. La
--    restricción mtto_hallazgo_obs_requerida ya dice
--        estado = 'NA' OR btrim(observacion) <> ''
--    así que una fila en 'B' YA queda obligada a llevar comentario.
--    Un ítem bueno sin nada que decir sigue sin fila.
--
-- 2) RECOMENDACIONES
--    Nueva columna es_recomendacion. Marca que el comentario es un
--    consejo, no un defecto. No obliga a foto ni a cotización.
--
--    Tampoco hay que tocar las validaciones duras: tanto
--    mtto_enviar_a_revision como mtto_guardar_diagnostico_por_token
--    filtran por estado IN ('R','M') y estado = 'M', así que las
--    filas en 'B' y las recomendaciones no bloquean el envío. La
--    regla de foto obligatoria en M queda intacta.
--
-- 3) CAMBIOS PREVIOS
--    mtto_componente_instalado solo se llenaba al cerrar una orden.
--    Si al MC-01 le cambiaron el aceite el mes pasado en otro taller,
--    el seguimiento de vida útil arrancaba en cero. Ahora se puede
--    registrar a mano.
--
-- Requiere mtto_1_schema y mtto_12_vida_util. Idempotente.
-- ============================================================

-- ------------------------------------------------------------
-- 1. PERMITIR FILAS EN BUENO
-- El CHECK era inline, así que Postgres le puso un nombre
-- automático. Se busca y se elimina por su definición, en vez de
-- asumir el nombre.
-- ------------------------------------------------------------
DO $$
DECLARE
    v_nombre text;
BEGIN
    FOR v_nombre IN
        SELECT c.conname
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'mtto_orden_hallazgo'
          AND c.contype = 'c'
          AND pg_get_constraintdef(c.oid) LIKE '%<> ''B''%'
    LOOP
        EXECUTE format('ALTER TABLE public.mtto_orden_hallazgo DROP CONSTRAINT %I', v_nombre);
        RAISE NOTICE 'Eliminada la restricción que impedía guardar ítems en Bueno: %', v_nombre;
    END LOOP;
END $$;

ALTER TABLE public.mtto_orden_hallazgo
    ADD COLUMN IF NOT EXISTS es_recomendacion boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.mtto_orden_hallazgo.es_recomendacion IS
    'true = consejo del mecánico, no un defecto. No obliga a foto ni a cotización.';

-- ------------------------------------------------------------
-- 2. VISTA DE RESUMEN: contar recomendaciones
--
-- El cálculo de "bueno" NO cambia: sigue siendo el total de ítems
-- aplicables menos los que están en R/M/NA. Las filas en 'B' no
-- entran en ese filtro, así que un ítem bueno con observación se
-- sigue contando como bueno, que es lo correcto.
--
-- OJO: CREATE OR REPLACE VIEW solo deja AGREGAR columnas AL FINAL.
-- Si se mete una nueva en medio, Postgres cree que se está
-- renombrando la que estaba en esa posición y falla con
--   "cannot change name of view column ... to ..."
-- Por eso 'recomendaciones' va de última, después de
-- tiene_critico_malo, aunque agrupada quedaría mejor arriba.
-- ------------------------------------------------------------
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
    bool_or(h.estado = 'M' AND ci2.critico) AS tiene_critico_malo,
    COUNT(h.id) FILTER (WHERE h.es_recomendacion) AS recomendaciones
FROM public.mtto_orden o
JOIN public.mtto_vehiculo v ON v.id = o.vehiculo_id
LEFT JOIN public.mtto_orden_hallazgo h ON h.orden_id = o.id
LEFT JOIN public.mtto_checklist_item ci2 ON ci2.id = h.item_id
GROUP BY o.id, o.numero, o.vehiculo_id, v.tipo;

-- ------------------------------------------------------------
-- 3. CAMBIOS HECHOS FUERA DEL SISTEMA
-- ------------------------------------------------------------
ALTER TABLE public.mtto_componente_instalado
    ALTER COLUMN orden_id DROP NOT NULL;

ALTER TABLE public.mtto_componente_instalado
    ADD COLUMN IF NOT EXISTS origen text NOT NULL DEFAULT 'orden',
    ADD COLUMN IF NOT EXISTS nota   text;

DO $$ BEGIN
    ALTER TABLE public.mtto_componente_instalado
        ADD CONSTRAINT mtto_componente_origen_valido CHECK (origen IN ('orden', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.mtto_componente_instalado.origen IS
    'orden = registrado al cerrar una orden. manual = cambio hecho fuera del sistema.';

-- Registra a mano un cambio anterior, calculando el vencimiento con
-- la vida útil del catálogo (misma lógica que mtto_cerrar_orden).
CREATE OR REPLACE FUNCTION public.mtto_registrar_componente_manual(
    p_vehiculo_id uuid,
    p_arreglo_id  uuid,
    p_fecha       date,
    p_km          int  DEFAULT NULL,
    p_nota        text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
    v_id          uuid;
    v_descripcion text;
    v_vida_km     int;
    v_vida_meses  int;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Debe iniciar sesión';
    END IF;
    IF NOT public.mtto_es_admin_modulo() THEN
        RAISE EXCEPTION 'Solo un administrador del módulo puede registrar cambios anteriores';
    END IF;
    IF p_fecha IS NULL OR p_fecha > current_date THEN
        RAISE EXCEPTION 'La fecha del cambio no puede ser futura';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.mtto_vehiculo
        WHERE id = p_vehiculo_id AND org_id = public.get_my_org_id()
    ) THEN
        RAISE EXCEPTION 'Vehículo no encontrado';
    END IF;

    SELECT nombre, vida_util_km, vida_util_meses
    INTO v_descripcion, v_vida_km, v_vida_meses
    FROM public.mtto_catalogo_arreglo WHERE id = p_arreglo_id;

    IF v_descripcion IS NULL THEN
        RAISE EXCEPTION 'Arreglo no encontrado';
    END IF;
    IF v_vida_km IS NULL AND v_vida_meses IS NULL THEN
        RAISE EXCEPTION 'Ese arreglo no tiene vida útil definida en el catálogo, así que no genera vencimiento. Cárguesela primero en Catálogo de Precios.';
    END IF;

    INSERT INTO public.mtto_componente_instalado
        (vehiculo_id, arreglo_id, orden_id, reparacion_id, descripcion, repuesto,
         instalado_el, instalado_km, vence_el, vence_km, origen, nota)
    VALUES (
        p_vehiculo_id, p_arreglo_id, NULL, NULL, v_descripcion, NULL,
        p_fecha, p_km,
        CASE WHEN v_vida_meses IS NOT NULL THEN p_fecha + make_interval(months => v_vida_meses) END,
        CASE WHEN v_vida_km IS NOT NULL AND p_km IS NOT NULL THEN p_km + v_vida_km END,
        'manual', p_nota
    )
    RETURNING id INTO v_id;

    -- Si este cambio es más reciente que el último kilometraje conocido,
    -- también actualiza la ficha del vehículo.
    IF p_km IS NOT NULL THEN
        UPDATE public.mtto_vehiculo
        SET km_actual = p_km, km_actualizado = p_fecha
        WHERE id = p_vehiculo_id AND (km_actual IS NULL OR p_km >= km_actual);
    END IF;

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.mtto_registrar_componente_manual(uuid, uuid, date, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mtto_registrar_componente_manual(uuid, uuid, date, int, text) TO authenticated;

-- ------------------------------------------------------------
-- 4. PAYLOADS DE LOS ENLACES PÚBLICOS
-- Se agrega es_recomendacion para que el aprobador pueda separar
-- consejos de defectos.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mtto_ver_orden_por_token(p_token text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
AS $$
DECLARE
    v_tok public.mtto_firma_token;
    v_resultado jsonb;
BEGIN
    v_tok := public.mtto_resolver_token(p_token);

    SELECT jsonb_build_object(
        'accion', v_tok.accion,
        'expira_at', v_tok.expira_at,
        'fotos', v_tok.fotos,
        'firmante', (
            SELECT jsonb_build_object('nombre', f.nombre, 'documento', f.documento, 'rol', f.rol)
            FROM public.mtto_firmante f WHERE f.id = v_tok.firmante_id
        ),
        'usuario', (
            SELECT jsonb_build_object('nombre', p.full_name)
            FROM public.profiles p WHERE p.id = v_tok.usuario_id
        ),
        'orden', jsonb_build_object(
            'id', o.id, 'numero', o.numero, 'fecha', o.fecha, 'estado', o.estado,
            'tipo_servicio', o.tipo_servicio, 'taller', o.taller, 'motivo', o.motivo,
            'kilometraje', o.kilometraje, 'iva_tasa', o.iva_tasa,
            'obs_encargado', o.obs_encargado
        ),
        'vehiculo', jsonb_build_object(
            'codigo', v.codigo, 'placa', v.placa, 'tipo', v.tipo,
            'marca', v.marca, 'linea', v.linea
        ),
        'hallazgos', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', h.id, 'estado', h.estado, 'observacion', h.observacion,
                'es_recomendacion', h.es_recomendacion,
                'item', ci.nombre, 'critico', ci.critico, 'seccion', cs.nombre,
                'fotos', COALESCE((SELECT jsonb_agg(fo.path) FROM public.mtto_orden_foto fo WHERE fo.hallazgo_id = h.id), '[]'::jsonb)
            ) ORDER BY cs.orden, ci.orden)
            FROM public.mtto_orden_hallazgo h
            JOIN public.mtto_checklist_item ci ON ci.id = h.item_id
            JOIN public.mtto_checklist_seccion cs ON cs.id = ci.seccion_id
            WHERE h.orden_id = o.id
        ), '[]'::jsonb),
        'reparaciones', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', r.id, 'descripcion', r.descripcion, 'repuesto', r.repuesto,
                'cantidad', r.cantidad, 'valor_unitario', r.valor_unitario,
                'mano_obra', r.mano_obra, 'total', r.total, 'prioridad', r.prioridad,
                'fotos', COALESCE((SELECT jsonb_agg(rf.path) FROM public.mtto_reparacion_foto rf WHERE rf.reparacion_id = r.id), '[]'::jsonb)
            ) ORDER BY r.created_at)
            FROM public.mtto_orden_reparacion r WHERE r.orden_id = o.id
        ), '[]'::jsonb)
    ) INTO v_resultado
    FROM public.mtto_orden o
    JOIN public.mtto_vehiculo v ON v.id = o.vehiculo_id
    WHERE o.id = v_tok.orden_id;

    RETURN v_resultado;
END;
$$;

REVOKE ALL ON FUNCTION public.mtto_ver_orden_por_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mtto_ver_orden_por_token(text) TO anon, authenticated;

-- ------------------------------------------------------------
-- 5. GUARDAR EL DIAGNÓSTICO: aceptar es_recomendacion
-- Se reemplaza la versión de mtto_10 (flujo corto) agregando el flag.
-- Todo lo demás queda idéntico.
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions
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
        INSERT INTO public.mtto_orden_hallazgo (orden_id, item_id, estado, observacion, es_recomendacion, creado_por)
        VALUES (v_tok.orden_id,
                (v_h->>'item_id')::uuid,
                (v_h->>'estado')::public.mtto_estado_item,
                NULLIF(btrim(COALESCE(v_h->>'observacion', '')), ''),
                COALESCE((v_h->>'es_recomendacion')::boolean, false),
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

    -- ── VALIDACIONES DURAS: intactas. Solo miran R/M, así que los
    -- ítems buenos con observación y las recomendaciones no estorban.
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

    -- Flujo corto: quien captura también revisa
    UPDATE public.mtto_orden
    SET estado = 'en_aprobacion',
        enviado_at = now(),
        revisado_por = v_tok.usuario_id,
        revisado_por_firmante = v_tok.firmante_id,
        revisado_at = now(),
        obs_encargado = COALESCE(p_diagnostico, obs_encargado)
    WHERE id = v_tok.orden_id;

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

-- ------------------------------------------------------------
-- VERIFICACIÓN
-- ------------------------------------------------------------
-- Debe devolver 0: ya no hay restricción que impida guardar 'B'
SELECT count(*) AS restricciones_que_bloquean_bueno
FROM pg_constraint c
JOIN pg_class t ON t.oid = c.conrelid
WHERE t.relname = 'mtto_orden_hallazgo' AND c.contype = 'c'
  AND pg_get_constraintdef(c.oid) LIKE '%<> ''B''%';

NOTIFY pgrst, 'reload schema';
