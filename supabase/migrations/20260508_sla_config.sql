-- SLA Configuration table
-- Permite a cada organización definir tiempos límite por tipo de ticket

CREATE TABLE IF NOT EXISTS sla_config (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    ticket_type     text NOT NULL,
    max_hours       numeric NOT NULL DEFAULT 24,
    threshold_pct   numeric NOT NULL DEFAULT 80 CHECK (threshold_pct BETWEEN 1 AND 100),
    color           text NOT NULL DEFAULT 'blue',
    created_at      timestamptz DEFAULT now(),
    updated_at      timestamptz DEFAULT now(),
    UNIQUE(org_id, ticket_type)
);

ALTER TABLE sla_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "sla_config_select" ON sla_config
    FOR SELECT USING (org_id = get_my_org_id());

CREATE POLICY "sla_config_insert" ON sla_config
    FOR INSERT WITH CHECK (org_id = get_my_org_id() AND is_org_admin());

CREATE POLICY "sla_config_update" ON sla_config
    FOR UPDATE USING (org_id = get_my_org_id() AND is_org_admin());

CREATE POLICY "sla_config_delete" ON sla_config
    FOR DELETE USING (org_id = get_my_org_id() AND is_org_admin());

CREATE INDEX IF NOT EXISTS idx_sla_config_org ON sla_config(org_id);

-- Seed: valores por defecto para la org inicial
INSERT INTO sla_config (org_id, ticket_type, max_hours, threshold_pct, color)
SELECT
    '00000000-0000-0000-0000-000000000001',
    ticket_type,
    max_hours,
    80,
    color
FROM (VALUES
    ('INSTALACION',    48, 'blue'),
    ('INSTALACION NUEVA', 48, 'blue'),
    ('REPARACION',     24, 'orange'),
    ('FALLA',          8,  'red'),
    ('CORTE',          4,  'red'),
    ('AVERIA',         8,  'orange'),
    ('SUSPENSION',     72, 'purple'),
    ('ADMINISTRATIVO', 72, 'slate')
) AS t(ticket_type, max_hours, color)
ON CONFLICT (org_id, ticket_type) DO NOTHING;
