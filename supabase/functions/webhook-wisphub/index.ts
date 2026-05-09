/**
 * webhook-wisphub — Edge Function receptora para n8n
 *
 * Flujo n8n:
 *   WispHub → n8n Webhook Node → POST /functions/v1/webhook-wisphub
 *             (n8n agrega header X-Webhook-Secret con el valor configurado en org_settings)
 *
 * Esta función:
 *   1. Valida el secret del webhook
 *   2. Mapea el payload de WispHub al esquema de workflow_processes
 *   3. Hace upsert en Supabase
 *   4. El canal Realtime de Supabase emite el cambio automáticamente a la UI
 */
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-webhook-secret, x-org-id',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json' },
    });
}

serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    try {
        const webhookSecret = req.headers.get('x-webhook-secret');
        const orgId = req.headers.get('x-org-id');

        if (!orgId) return json({ error: 'x-org-id header required' }, 400);

        const supabase = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        );

        // Validar secret del webhook contra lo configurado en org_settings
        const { data: settings } = await supabase
            .from('organization_settings')
            .select('wisphub_token')
            .eq('org_id', orgId)
            .single();

        // Comparación simple — en producción usar comparación timing-safe
        if (!settings || webhookSecret !== settings.wisphub_token) {
            return json({ error: 'Invalid webhook secret' }, 401);
        }

        const payload = await req.json();

        // Soporte para payload individual o array (n8n puede enviar batch)
        const tickets = Array.isArray(payload) ? payload : [payload];
        const results: { id: string; action: string }[] = [];

        for (const ticket of tickets) {
            const referenceId = String(ticket.id || ticket.ticket_id || '');
            if (!referenceId) continue;

            // Detectar estado WispHub → estado interno
            const statusMap: Record<string, string> = {
                'AB': 'open',
                'EN': 'in_progress',
                'CO': 'completed',
                'CA': 'cancelled',
            };
            const rawStatus = ticket.estado || ticket.status || 'AB';
            const mappedStatus = statusMap[rawStatus] || 'open';

            // Aislar asunto (puede venir "Asunto - Cliente" — ver memoria técnica §12)
            const rawTitle = ticket.asunto || ticket.subject || ticket.title || 'Sin asunto';
            const cleanTitle = rawTitle.includes(' - ') ? rawTitle.split(' - ')[0] : rawTitle;

            const processData = {
                org_id: orgId,
                reference_id: referenceId,
                title: cleanTitle,
                process_type: 'ticket',
                status: mappedStatus,
                escalation_level: ticket.nivel_escalamiento || ticket.escalation_level || 0,
                metadata: {
                    nombre_cliente: ticket.nombre_cliente || ticket.cliente || '',
                    barrio: ticket.barrio || ticket.zona || '',
                    direccion: ticket.direccion || '',
                    telefono: ticket.telefono || '',
                    email_tecnico: ticket.email_tecnico || '',
                    tipo_ticket: cleanTitle.toUpperCase(),
                    wisphub_raw: ticket,
                    synced_at: new Date().toISOString(),
                },
                updated_at: new Date().toISOString(),
            };

            const { error } = await supabase
                .from('workflow_processes')
                .upsert(processData, { onConflict: 'reference_id,org_id' });

            if (!error) {
                results.push({ id: referenceId, action: 'upserted' });
            } else {
                console.error(`[webhook-wisphub] Error upserting ${referenceId}:`, error);
                results.push({ id: referenceId, action: 'error' });
            }
        }

        return json({ ok: true, processed: results.length, results });

    } catch (err) {
        console.error('[webhook-wisphub] Fatal error:', err);
        return json({ error: 'Internal error', detail: String(err) }, 500);
    }
});
