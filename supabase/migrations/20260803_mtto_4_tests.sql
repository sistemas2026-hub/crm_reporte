-- ============================================================
-- MÓDULO DE MANTENIMIENTO VEHICULAR (mtto_*)
-- Pruebas de las 3 validaciones críticas, ejecutables en el SQL
-- Editor de Supabase. NO es una migración: no cambia el esquema,
-- solo verifica comportamiento, y termina con ROLLBACK — no deja
-- nada escrito en la base de datos.
--
-- Requiere: 20260803_mtto_1_schema.sql, 20260803_mtto_2_seed.sql
-- y 20260803_mtto_3_rpc.sql ya corridos, y al menos un usuario
-- existente en auth.users (usa el primero que encuentre; puede
-- reemplazar la subconsulta por un id específico si lo prefiere).
--
-- Qué prueba:
--   1) No se puede enviar a revisión un ítem en M sin foto.
--   2) No se puede editar una orden fuera de estado borrador.
--   3) Un usuario sin rol de aprobador no puede ejecutar
--      mtto_aprobar_orden (ej. el mismo mecánico).
--
-- Lea los RAISE NOTICE/WARNING en la consola de resultados del
-- SQL Editor de Supabase (pestaña "Logs" del query, no el "Results").
-- ============================================================

BEGIN;

DO $$
DECLARE
    v_user_id     uuid := (SELECT id FROM auth.users ORDER BY created_at LIMIT 1);
    v_org_id      uuid;
    v_vehiculo_id uuid;
    v_item_m      uuid;
    v_item_r      uuid;
    v_orden       uuid;
    v_hallazgo_m  uuid;
    v_hallazgo_r  uuid;
    v_fail        int := 0;
    v_msg         text;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'No hay usuarios en auth.users. Cree al menos un usuario antes de correr las pruebas.';
    END IF;

    -- Se trae explícito: en este punto todavía no hay JWT simulado,
    -- así que get_my_org_id() (el default de la columna) no resolvería nada.
    SELECT org_id INTO v_org_id FROM public.profiles WHERE id = v_user_id;
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'El usuario % no tiene org_id en profiles. Asígnele una organización antes de correr las pruebas.', v_user_id;
    END IF;

    SELECT id INTO v_vehiculo_id FROM public.mtto_vehiculo WHERE org_id = v_org_id ORDER BY codigo LIMIT 1;
    IF v_vehiculo_id IS NULL THEN
        RAISE EXCEPTION 'No hay vehículos sembrados para la organización % del usuario de prueba. Corra 20260803_mtto_2_seed.sql antes de las pruebas (o verifique que el seed haya usado la misma organización).', v_org_id;
    END IF;

    SELECT id INTO v_item_m FROM public.mtto_checklist_item WHERE nombre = 'Ruidos anormales del motor' LIMIT 1;
    SELECT id INTO v_item_r FROM public.mtto_checklist_item WHERE nombre = 'Fugas de aceite en motor' LIMIT 1;
    IF v_item_m IS NULL OR v_item_r IS NULL THEN
        RAISE EXCEPTION 'Faltan ítems del checklist. Corra 20260803_mtto_2_seed.sql antes de las pruebas.';
    END IF;

    RAISE NOTICE '=== Usuario de prueba: % — Vehículo: % ===', v_user_id, v_vehiculo_id;

    -- Asigna temporalmente el rol de mecánico al usuario de prueba.
    -- Como todo el script corre dentro de una transacción con ROLLBACK
    -- al final, esta asignación nunca queda persistida.
    INSERT INTO public.mtto_usuario_rol (usuario_id, org_id, rol, nombre)
    VALUES (v_user_id, v_org_id, 'mecanico', 'Usuario de prueba (temporal)')
    ON CONFLICT (usuario_id) DO UPDATE SET rol = 'mecanico', activo = true, org_id = EXCLUDED.org_id;

    -- Simula al usuario autenticado como lo haría PostgREST.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_id, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_user_id::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';

    RAISE NOTICE '--- Creando orden de prueba en borrador ---';
    INSERT INTO public.mtto_orden (vehiculo_id, tipo_servicio, taller, motivo, creado_por)
    VALUES (v_vehiculo_id, 'correctivo', 'Taller de prueba', 'Prueba automatizada de validaciones críticas', v_user_id)
    RETURNING id INTO v_orden;

    INSERT INTO public.mtto_orden_hallazgo (orden_id, item_id, estado, observacion)
    VALUES (v_orden, v_item_r, 'R', 'Observación de prueba para ítem regular')
    RETURNING id INTO v_hallazgo_r;

    INSERT INTO public.mtto_orden_hallazgo (orden_id, item_id, estado, observacion)
    VALUES (v_orden, v_item_m, 'M', 'Observación de prueba para ítem malo')
    RETURNING id INTO v_hallazgo_m;

    INSERT INTO public.mtto_orden_reparacion (orden_id, hallazgo_id, descripcion, cantidad, valor_unitario, mano_obra)
    VALUES (v_orden, v_hallazgo_m, 'Reparación de prueba', 1, 10000, 5000);

    -- ============================================================
    -- TEST 1: no se puede enviar a revisión un ítem en M sin foto
    -- ============================================================
    BEGIN
        PERFORM public.mtto_enviar_a_revision(v_orden);
        v_fail := v_fail + 1;
        RAISE WARNING 'TEST 1 FALLÓ: se permitió enviar a revisión con un ítem en M sin foto';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        RAISE NOTICE 'TEST 1 OK — bloqueado como se esperaba: %', v_msg;
    END;

    -- Registra la foto que faltaba y reintenta: ahora sí debe pasar.
    INSERT INTO public.mtto_orden_foto (hallazgo_id, path, mime, bytes)
    VALUES (v_hallazgo_m, v_orden::text || '/' || v_hallazgo_m::text || '/prueba.jpg', 'image/jpeg', 12345);

    PERFORM public.mtto_enviar_a_revision(v_orden);
    RAISE NOTICE 'Control: con la foto agregada, la orden SÍ pasó a en_revision (correcto)';

    -- ============================================================
    -- TEST 2: no se puede editar una orden fuera de estado borrador
    -- Se prueba como postgres (RESET ROLE), es decir SIN RLS de por
    -- medio, para verificar específicamente que el TRIGGER (no solo
    -- la política RLS) es quien bloquea la edición. Con RLS activo
    -- (rol authenticated) el UPDATE ni siquiera encontraría la fila
    -- y afectaría 0 filas sin lanzar excepción, lo que no probaría
    -- nada sobre el trigger en sí.
    -- ============================================================
    EXECUTE 'RESET ROLE';

    BEGIN
        UPDATE public.mtto_orden_hallazgo
        SET observacion = 'Intento de edición fuera de borrador'
        WHERE id = v_hallazgo_r;
        v_fail := v_fail + 1;
        RAISE WARNING 'TEST 2 FALLÓ: se permitió editar un hallazgo con la orden fuera de borrador';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        RAISE NOTICE 'TEST 2 OK — bloqueado como se esperaba (por el trigger): %', v_msg;
    END;

    -- Vuelve a simular al usuario autenticado para el TEST 3.
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_user_id, 'role', 'authenticated')::text, true);
    PERFORM set_config('request.jwt.claim.sub', v_user_id::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';

    -- ============================================================
    -- TEST 3: un usuario sin rol de aprobador no puede aprobar
    -- (v_user_id solo tiene rol 'mecanico' en este script)
    -- ============================================================
    BEGIN
        PERFORM public.mtto_aprobar_orden(v_orden, 'aprobado', 'obs de prueba', 15000, NULL);
        v_fail := v_fail + 1;
        RAISE WARNING 'TEST 3 FALLÓ: un usuario sin rol de aprobador pudo aprobar la orden';
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
        RAISE NOTICE 'TEST 3 OK — bloqueado como se esperaba: %', v_msg;
    END;

    EXECUTE 'RESET ROLE';

    IF v_fail > 0 THEN
        RAISE EXCEPTION '% prueba(s) fallaron — revise los WARNING de arriba', v_fail;
    ELSE
        RAISE NOTICE '✅ Las 3 pruebas críticas pasaron correctamente';
    END IF;
END $$;

-- Nada de lo anterior queda persistido: usuario de prueba, orden,
-- hallazgos, foto y reparación se descartan.
ROLLBACK;
