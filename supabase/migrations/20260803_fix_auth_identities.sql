-- ============================================================
-- REPARACIÓN: usuarios sin fila en auth.identities
--
-- Diagnóstico encontrado: 26 de 31 usuarios en auth.users NO tienen
-- su fila correspondiente en auth.identities. Esto ocurre cuando el
-- usuario se crea insertando directamente en auth.users (como hace
-- la función create_new_user de este proyecto) sin crear también la
-- identidad del proveedor 'email'.
--
-- GoTrue espera que todo usuario tenga al menos una identidad; sin
-- ella, varias operaciones de Auth fallan con HTTP 500 — incluido el
-- refresh de token, que es el síntoma reportado (la sesión funciona
-- un rato y luego expulsa al usuario).
--
-- El script es idempotente: solo crea identidades faltantes y no
-- toca las que ya existen, ni contraseñas, ni ningún otro dato.
--
-- OJO: después de correrlo, todos deben volver a iniciar sesión una
-- vez (las sesiones actuales ya están en un estado inconsistente).
-- ============================================================

-- ------------------------------------------------------------
-- PASO 1 — Ver a quiénes les falta la identidad (solo consulta)
-- ------------------------------------------------------------
SELECT u.id, u.email, u.created_at
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id)
ORDER BY u.created_at;

-- ------------------------------------------------------------
-- PASO 2 — Crear las identidades faltantes.
--
-- El bloque detecta automáticamente la versión del esquema de
-- auth.identities (las versiones nuevas de GoTrue tienen la columna
-- provider_id; las antiguas usan 'id' de tipo text como identificador
-- del proveedor), para funcionar en ambos casos.
-- ------------------------------------------------------------
DO $$
DECLARE
    v_creadas int;
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'auth' AND table_name = 'identities' AND column_name = 'provider_id'
    ) THEN
        -- Esquema actual de Supabase
        INSERT INTO auth.identities (id, user_id, identity_data, provider, provider_id, last_sign_in_at, created_at, updated_at)
        SELECT
            gen_random_uuid(),
            u.id,
            jsonb_build_object(
                'sub', u.id::text,
                'email', u.email,
                'email_verified', true,
                'phone_verified', false
            ),
            'email',
            u.id::text,
            now(), now(), now()
        FROM auth.users u
        WHERE u.email IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id);
    ELSE
        -- Esquema antiguo (id de tipo text hace las veces de provider_id)
        INSERT INTO auth.identities (id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
        SELECT
            u.id::text,
            u.id,
            jsonb_build_object('sub', u.id::text, 'email', u.email),
            'email',
            now(), now(), now()
        FROM auth.users u
        WHERE u.email IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id);
    END IF;

    GET DIAGNOSTICS v_creadas = ROW_COUNT;
    RAISE NOTICE 'Identidades creadas: %', v_creadas;
END $$;

-- ------------------------------------------------------------
-- PASO 3 — Verificación: debe devolver 0.
-- ------------------------------------------------------------
SELECT count(*) AS usuarios_sin_identity
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM auth.identities i WHERE i.user_id = u.id);

-- ------------------------------------------------------------
-- PASO 4 — Usuarios con email sin confirmar.
--
-- Un usuario creado a mano puede quedar con email_confirmed_at en
-- NULL, lo que impide iniciar sesión si el proyecto exige correo
-- confirmado. Como los correos de esta instalación son internos (y
-- algunos inventados), no hay forma de confirmarlos por correo.
--
-- Primero revise cuántos son:
SELECT count(*) AS sin_confirmar FROM auth.users WHERE email_confirmed_at IS NULL;

-- Y si son usuarios legítimos de la empresa, confírmelos manualmente
-- descomentando esta línea:
-- UPDATE auth.users SET email_confirmed_at = COALESCE(email_confirmed_at, now()) WHERE email_confirmed_at IS NULL;

-- ------------------------------------------------------------
-- PASO 5 (importante) — arreglar el ORIGEN.
--
-- Mientras create_new_user no cree la identidad, cada usuario nuevo
-- volverá a nacer roto. Para ver el código actual de la función:
--
--   SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = 'create_new_user';
--
-- Pásame ese resultado y le agrego el INSERT en auth.identities.
-- ------------------------------------------------------------
