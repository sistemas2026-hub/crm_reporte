-- ============================================================
-- CORRECCIÓN DE ORIGEN: create_new_user no creaba la identidad
--
-- La versión anterior insertaba en auth.users y en public.profiles,
-- pero NUNCA en auth.identities. Por eso cada usuario creado desde
-- Configuración nacía sin identidad, y GoTrue terminaba devolviendo
-- HTTP 500 en operaciones de Auth (entre ellas el refresh de token,
-- que expulsaba al usuario al cabo de un rato).
--
-- Esta versión agrega el INSERT en auth.identities. Todo lo demás
-- (firma, parámetros, retorno, inserción en profiles) queda igual,
-- así que la pantalla de Configuración sigue funcionando sin cambios.
--
-- Corra 20260803_fix_auth_identities.sql para reparar los usuarios
-- YA existentes; este archivo evita que el problema se repita con
-- los usuarios NUEVOS.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_new_user(
    email_input text,
    password_input text,
    full_name_input text,
    role_input text,
    wisphub_id_input text DEFAULT NULL::text,
    operational_level_input integer DEFAULT 1,
    is_field_tech_input boolean DEFAULT false,
    allowed_menus_input jsonb DEFAULT '["Dashboard"]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth', 'extensions'
AS $function$
DECLARE
    new_id uuid;
    v_email text;
BEGIN
    -- Normaliza el correo igual que lo hace GoTrue al iniciar sesión
    -- (minúsculas y sin espacios). Sin esto, un usuario creado como
    -- "Juan@Empresa.com" no podría entrar escribiendo "juan@empresa.com".
    v_email := lower(btrim(email_input));

    IF v_email = '' OR v_email IS NULL THEN
        RAISE EXCEPTION 'El correo es obligatorio';
    END IF;

    IF EXISTS (SELECT 1 FROM auth.users WHERE lower(email) = v_email) THEN
        RAISE EXCEPTION 'Ya existe un usuario con el correo %', v_email;
    END IF;

    -- 1. Insert into auth.users (OMITTING confirmed_at because it is generated)
    INSERT INTO auth.users (
        instance_id,
        id,
        aud,
        role,
        email,
        encrypted_password,
        email_confirmed_at,
        created_at,
        updated_at,
        raw_app_meta_data,
        raw_user_meta_data,
        is_super_admin
    ) VALUES (
        '00000000-0000-0000-0000-000000000000',
        gen_random_uuid(),
        'authenticated',
        'authenticated',
        v_email,
        crypt(password_input, gen_salt('bf')),
        now(),
        now(),
        now(),
        '{"provider": "email", "providers": ["email"]}',
        jsonb_build_object('full_name', full_name_input, 'role', role_input),
        false
    )
    RETURNING id INTO new_id;

    -- 1b. Insert into auth.identities  ← ESTO ES LO QUE FALTABA.
    -- Sin esta fila, GoTrue devuelve 500 en refresh de token y otras
    -- operaciones. Se detecta la versión del esquema (las versiones
    -- nuevas tienen provider_id; las antiguas usan id de tipo text).
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'auth' AND table_name = 'identities' AND column_name = 'provider_id'
    ) THEN
        INSERT INTO auth.identities (
            id, user_id, identity_data, provider, provider_id,
            last_sign_in_at, created_at, updated_at
        ) VALUES (
            gen_random_uuid(),
            new_id,
            jsonb_build_object(
                'sub', new_id::text,
                'email', v_email,
                'email_verified', true,
                'phone_verified', false
            ),
            'email',
            new_id::text,
            now(), now(), now()
        );
    ELSE
        INSERT INTO auth.identities (
            id, user_id, identity_data, provider,
            last_sign_in_at, created_at, updated_at
        ) VALUES (
            new_id::text,
            new_id,
            jsonb_build_object('sub', new_id::text, 'email', v_email),
            'email',
            now(), now(), now()
        );
    END IF;

    -- 2. Insert into profiles
    INSERT INTO public.profiles (
        id,
        full_name,
        role,
        wisphub_id,
        operational_level,
        is_field_tech,
        allowed_menus,
        email
    ) VALUES (
        new_id,
        full_name_input,
        role_input,
        wisphub_id_input,
        operational_level_input,
        is_field_tech_input,
        allowed_menus_input,
        v_email
    )
    ON CONFLICT (id) DO UPDATE SET
        full_name = EXCLUDED.full_name,
        role = EXCLUDED.role,
        email = EXCLUDED.email;

    RETURN new_id;
END;
$function$;

NOTIFY pgrst, 'reload schema';
