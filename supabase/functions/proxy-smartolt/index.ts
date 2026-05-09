import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
};

serve(async (req) => {
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

        const supabase = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        );

        const { data: { user }, error: authError } = await supabase.auth.getUser(
            authHeader.replace('Bearer ', '')
        );

        if (authError || !user) {
            return new Response(JSON.stringify({ error: 'Invalid token' }), {
                status: 401, headers: { ...CORS, 'Content-Type': 'application/json' }
            });
        }

        const { data: profile } = await supabase
            .from('profiles')
            .select('org_id')
            .eq('id', user.id)
            .single();

        if (!profile?.org_id) {
            return new Response(JSON.stringify({ error: 'Organization not configured.' }), {
                status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
            });
        }

        const { data: settings } = await supabase
            .from('organization_settings')
            .select('smartolt_url, smartolt_token')
            .eq('org_id', profile.org_id)
            .single();

        if (!settings?.smartolt_url || !settings?.smartolt_token) {
            return new Response(JSON.stringify({ error: 'SmartOLT not configured. Go to Settings → API Credentials.' }), {
                status: 400, headers: { ...CORS, 'Content-Type': 'application/json' }
            });
        }

        const url = new URL(req.url);
        const path = url.pathname.replace(/^\/functions\/v1\/proxy-smartolt\/?/, '');
        const baseUrl = settings.smartolt_url.replace(/\/$/, '');
        const targetUrl = `${baseUrl}/api/${path}${url.search}`;

        console.log(`[proxy-smartolt] ${user.email} → org:${profile.org_id} → ${targetUrl}`);

        let body: BodyInit | null = null;
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            body = await req.text();
        }

        const smartoltRes = await fetch(targetUrl, {
            method: req.method,
            headers: {
                'X-Token': settings.smartolt_token,
                'Accept': 'application/json',
                'Content-Type': 'application/json',
            },
            body: body || undefined,
        });

        const responseBody = await smartoltRes.text();

        return new Response(responseBody, {
            status: smartoltRes.status,
            headers: {
                ...CORS,
                'Content-Type': smartoltRes.headers.get('Content-Type') || 'application/json',
            },
        });

    } catch (err) {
        console.error('[proxy-smartolt] Error:', err);
        return new Response(JSON.stringify({ error: 'Internal proxy error', detail: String(err) }), {
            status: 500, headers: { ...CORS, 'Content-Type': 'application/json' }
        });
    }
});
