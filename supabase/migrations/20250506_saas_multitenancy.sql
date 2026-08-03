-- ============================================================
-- MIGRACIÓN: Arquitectura Multi-Tenant (SaaS)
-- Ejecutar en el SQL Editor de Supabase
-- ============================================================

-- 1. Tabla de Organizaciones (cada empresa = 1 org)
CREATE TABLE IF NOT EXISTS public.organizations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    slug        text UNIQUE NOT NULL,  -- identificador URL-friendly
    created_at  timestamptz DEFAULT now(),
    updated_at  timestamptz DEFAULT now()
);

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

-- 2. Configuración por organización (credenciales API)
CREATE TABLE IF NOT EXISTS public.organization_settings (
    org_id          uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
    -- WispHub
    wisphub_url     text,       -- Ej: https://miempresa.wisphub.io
    wisphub_token   text,       -- Api-Key de WispHub (guardado con RLS restringida)
    -- SmartOLT
    smartolt_url    text,       -- Ej: https://miempresa.smartolt.com
    smartolt_token  text,       -- X-Token de SmartOLT
    -- Identidad
    company_name    text NOT NULL DEFAULT 'Mi Empresa',
    logo_url        text,
    -- Estado de integración
    wisphub_verified    boolean DEFAULT false,
    smartolt_verified   boolean DEFAULT false,
    updated_at      timestamptz DEFAULT now()
);

ALTER TABLE public.organization_settings ENABLE ROW LEVEL SECURITY;

-- 3. Agregar org_id a profiles
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

-- 4. Agregar org_id a las tablas operativas principales
ALTER TABLE public.workflow_processes
    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

ALTER TABLE public.workflow_workitems
    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

ALTER TABLE public.workflow_activities
    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

-- Inventario
ALTER TABLE public.inventory_assets
    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

ALTER TABLE public.inventory_items
    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

-- Config CRM
ALTER TABLE public.crm_config
    ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);

-- Eventos de tickets
DO $$ BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'ticket_events') THEN
        ALTER TABLE public.ticket_events ADD COLUMN IF NOT EXISTS org_id uuid REFERENCES public.organizations(id);
    END IF;
END $$;

-- 5. Función helper: obtener org_id del usuario autenticado
CREATE OR REPLACE FUNCTION public.get_my_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT org_id FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$;

-- 6. Función helper: verificar si el usuario es admin de su org
CREATE OR REPLACE FUNCTION public.is_org_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT role = 'admin' FROM public.profiles WHERE id = auth.uid() LIMIT 1;
$$;

-- ============================================================
-- RLS POLICIES
-- ============================================================

-- organizations: solo ver la propia
CREATE POLICY "org_select_own" ON public.organizations
    FOR SELECT USING (id = public.get_my_org_id());

CREATE POLICY "org_insert_own" ON public.organizations
    FOR INSERT WITH CHECK (true); -- permitir crear nueva org (onboarding)

CREATE POLICY "org_update_own" ON public.organizations
    FOR UPDATE USING (id = public.get_my_org_id() AND public.is_org_admin());

-- organization_settings: solo admins de la org
CREATE POLICY "orgsettings_select" ON public.organization_settings
    FOR SELECT USING (org_id = public.get_my_org_id());

CREATE POLICY "orgsettings_insert" ON public.organization_settings
    FOR INSERT WITH CHECK (org_id = public.get_my_org_id() AND public.is_org_admin());

CREATE POLICY "orgsettings_update" ON public.organization_settings
    FOR UPDATE USING (org_id = public.get_my_org_id() AND public.is_org_admin());

-- profiles: solo ver los de la misma org
DROP POLICY IF EXISTS "profiles_select" ON public.profiles;
CREATE POLICY "profiles_select_org" ON public.profiles
    FOR SELECT USING (org_id = public.get_my_org_id() OR id = auth.uid());

DROP POLICY IF EXISTS "profiles_update" ON public.profiles;
CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE USING (id = auth.uid() OR (public.is_org_admin() AND org_id = public.get_my_org_id()));

-- workflow_processes
DROP POLICY IF EXISTS "Allow all" ON public.workflow_processes;
CREATE POLICY "wfprocesses_org" ON public.workflow_processes
    FOR ALL USING (org_id = public.get_my_org_id());

-- workflow_workitems
DROP POLICY IF EXISTS "Allow all" ON public.workflow_workitems;
CREATE POLICY "wfworkitems_org" ON public.workflow_workitems
    FOR ALL USING (org_id = public.get_my_org_id());

-- workflow_activities
DROP POLICY IF EXISTS "Allow all" ON public.workflow_activities;
CREATE POLICY "wfactivities_org" ON public.workflow_activities
    FOR ALL USING (org_id = public.get_my_org_id());

-- inventory_assets
DROP POLICY IF EXISTS "Allow all" ON public.inventory_assets;
CREATE POLICY "inventory_assets_org" ON public.inventory_assets
    FOR ALL USING (org_id = public.get_my_org_id());

-- inventory_items
DROP POLICY IF EXISTS "Allow all" ON public.inventory_items;
CREATE POLICY "inventory_items_org" ON public.inventory_items
    FOR ALL USING (org_id = public.get_my_org_id());

-- crm_config: solo el propio registro (ya existía filtro por user_id)
-- No cambiamos la policy existente, solo aseguramos que org_id quede poblado

-- ============================================================
-- DATOS INICIALES: Migrar instalación existente como Org #1
-- ============================================================

-- Crear organización base para los datos existentes
INSERT INTO public.organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000001', 'Organización Principal', 'principal')
ON CONFLICT (slug) DO NOTHING;

-- Crear settings iniciales vacíos (las credenciales se configuran en el panel)
INSERT INTO public.organization_settings (org_id, company_name)
VALUES ('00000000-0000-0000-0000-000000000001', 'Mi Empresa ISP')
ON CONFLICT (org_id) DO NOTHING;

-- Asociar todos los perfiles existentes a la org principal
UPDATE public.profiles
SET org_id = '00000000-0000-0000-0000-000000000001'
WHERE org_id IS NULL;

-- Asociar registros operativos existentes a la org principal
UPDATE public.workflow_processes
SET org_id = '00000000-0000-0000-0000-000000000001'
WHERE org_id IS NULL;

UPDATE public.workflow_workitems
SET org_id = '00000000-0000-0000-0000-000000000001'
WHERE org_id IS NULL;

UPDATE public.workflow_activities
SET org_id = '00000000-0000-0000-0000-000000000001'
WHERE org_id IS NULL;

UPDATE public.inventory_assets
SET org_id = '00000000-0000-0000-0000-000000000001'
WHERE org_id IS NULL;

UPDATE public.inventory_items
SET org_id = '00000000-0000-0000-0000-000000000001'
WHERE org_id IS NULL;

UPDATE public.crm_config
SET org_id = '00000000-0000-0000-0000-000000000001'
WHERE org_id IS NULL;

-- ============================================================
-- RPC: Crear organización nueva (para onboarding de nuevas empresas)
-- ============================================================
CREATE OR REPLACE FUNCTION public.create_organization(
    org_name text,
    org_slug text,
    company_name_input text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    new_org_id uuid;
BEGIN
    -- Crear la organización
    INSERT INTO public.organizations (name, slug)
    VALUES (org_name, org_slug)
    RETURNING id INTO new_org_id;

    -- Crear settings vacíos
    INSERT INTO public.organization_settings (org_id, company_name)
    VALUES (new_org_id, company_name_input);

    -- Asociar el usuario actual a la nueva org y hacerlo admin
    UPDATE public.profiles
    SET org_id = new_org_id, role = 'admin'
    WHERE id = auth.uid();

    RETURN new_org_id;
END;
$$;

-- ============================================================
-- ÍNDICES para performance multi-tenant
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_profiles_org_id ON public.profiles(org_id);
CREATE INDEX IF NOT EXISTS idx_wfprocesses_org_id ON public.workflow_processes(org_id);
CREATE INDEX IF NOT EXISTS idx_wfworkitems_org_id ON public.workflow_workitems(org_id);
CREATE INDEX IF NOT EXISTS idx_inventory_assets_org_id ON public.inventory_assets(org_id);
