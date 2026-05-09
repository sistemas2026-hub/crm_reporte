import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

serve(async (req) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response(null, { headers: CORS });
    }

    try {
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
                status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
            });
        }

        // Crear cliente Supabase con el JWT del usuario
        const supabase = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        );

        // Verificar el token y obtener el usuario
        const { data: { user }, error: authError } = await supabase.auth.getUser(
            authHeader.replace('Bearer ', '')
        );

        if (authError || !user) {
            return new Response(JSON.stringify({ error: 'Invalid token' }), {
                status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
            });
        }

        // Obtener el org_id del usuario
        const { data: profile } = await supabase
            .from('profiles')
            .select('org_id')
            .eq('id', user.id)
            .single();

        if (!profile?.org_id) {
            return new Response(JSON.stringify({ error: 'Organization not configured. Complete onboarding first.' }), {
                status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
            });
        }

        // Obtener las credenciales de WispHub de la organización
        const { data: settings } = await supabase
            .from('organization_settings')
            .select('wisphub_url, wisphub_token')
            .eq('org_id', profile.org_id)
            .single();

        if (!settings?.wisphub_url || !settings?.wisphub_token) {
            return new Response(JSON.stringify({ error: 'WispHub not configured. Go to Settings → API Credentials.' }), {
                status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
            });
        }

        // Construir la URL destino
        // La URL del request viene como: /functions/v1/proxy-wisphub/{path}?{query}
        const url = new URL(req.url);
        const path = url.pathname.replace(/^\/functions\/v1\/proxy-wisphub\/?/, '');
        const baseUrl = settings.wisphub_url.replace(/\/$/, '').replace(/wisphub\.net/g, 'wisphub.io');
        const targetUrl = `${baseUrl}/api/${path}${url.search}`;

        console.log(`[proxy-wisphub] ${user.email} → org:${profile.org_id} → ${targetUrl}`);

        // Copiar el body si es necesario
        let body: BodyInit | null = null;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            body = await req.text();
        }

        // Hacer la petición real a WispHub
        const wisphubRes = await fetch(targetUrl, {
            method: req.method,
            headers: {
                'Authorization': `Api-Key ${settings.wisphub_token}`,
                'Api-Key': settings.wisphub_token,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            body: body || undefined,
        });

        const responseBody = await wisphubRes.text();

        return new Response(responseBody, {
            status: wisphubRes.status,
            headers: {
                ...CORS,
                'Content-Type': wisphubRes.headers.get('Content-Type') || 'application/json',
            },
        });

    } catch (err) {
        console.error('[proxy-wisphub] Error:', err);
        return new Response(JSON.stringify({ error: 'Internal proxy error', detail: String(err) }), {
            status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
    }
});
