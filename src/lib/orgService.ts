/**
 * orgService — Gestión del tenant activo (organización).
 * Cachea los settings en memoria para evitar múltiples queries por render.
 * El JWT del usuario en Supabase identifica al tenant automáticamente.
 */
import { supabase } from './supabase';

export interface OrgSettings {
    org_id: string;
    company_name: string;
    logo_url: string | null;
    wisphub_url: string | null;
    wisphub_token: string | null;
    wisphub_verified: boolean;
    smartolt_url: string | null;
    smartolt_token: string | null;
    smartolt_verified: boolean;
}

export interface OrgInfo {
    id: string;
    name: string;
    slug: string;
}

let _settingsCache: OrgSettings | null = null;
let _orgCache: OrgInfo | null = null;
let _cachePromise: Promise<{ org: OrgInfo | null; settings: OrgSettings | null }> | null = null;

export const orgService = {
    /** Retorna los settings del tenant del usuario autenticado (cacheado en memoria) */
    async getSettings(): Promise<OrgSettings | null> {
        const { settings } = await this._load();
        return settings;
    },

    async getOrg(): Promise<OrgInfo | null> {
        const { org } = await this._load();
        return org;
    },

    /** Nombre de empresa para marcas de agua, labels, etc. */
    async getCompanyName(): Promise<string> {
        const settings = await this.getSettings();
        return settings?.company_name || 'ISP Reports';
    },

    /** URL base de la Edge Function para WispHub de este tenant */
    getWispHubProxyUrl(): string {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
        return `${supabaseUrl}/functions/v1/proxy-wisphub`;
    },

    /** URL base de la Edge Function para SmartOLT de este tenant */
    getSmartOLTProxyUrl(): string {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
        return `${supabaseUrl}/functions/v1/proxy-smartolt`;
    },

    /** Obtiene el JWT del usuario activo para enviarlo a las Edge Functions */
    async getAuthHeader(): Promise<string | null> {
        const { data: { session } } = await supabase.auth.getSession();
        if (!session?.access_token) return null;
        return `Bearer ${session.access_token}`;
    },

    /** Guarda o actualiza las credenciales API de la organización */
    async saveApiCredentials(data: {
        wisphub_url?: string;
        wisphub_token?: string;
        smartolt_url?: string;
        smartolt_token?: string;
        company_name?: string;
    }): Promise<{ error: string | null }> {
        const settings = await this.getSettings();
        if (!settings?.org_id) return { error: 'No hay organización configurada' };

        const { error } = await supabase
            .from('organization_settings')
            .update({ ...data, updated_at: new Date().toISOString() })
            .eq('org_id', settings.org_id);

        if (!error) {
            // Invalidar caché
            _settingsCache = null;
            _orgCache = null;
            _cachePromise = null;
        }

        return { error: error?.message || null };
    },

    /** Verifica conectividad con WispHub y marca como verified en BD */
    async verifyWisphub(): Promise<{ ok: boolean; message: string }> {
        try {
            const authHeader = await this.getAuthHeader();
            if (!authHeader) return { ok: false, message: 'Sin sesión' };

            const res = await fetch(`${this.getWispHubProxyUrl()}/clientes/?page_size=1`, {
                headers: { Authorization: authHeader }
            });

            const ok = res.status < 400 || res.status === 404; // 404 = conectó pero sin datos, válido

            if (ok) {
                const settings = await this.getSettings();
                if (settings?.org_id) {
                    await supabase.from('organization_settings')
                        .update({ wisphub_verified: true })
                        .eq('org_id', settings.org_id);
                    _settingsCache = null; _cachePromise = null;
                }
            }

            return { ok, message: ok ? 'Conexión exitosa con WispHub' : `Error HTTP ${res.status}` };
        } catch (e) {
            return { ok: false, message: `Error de red: ${String(e)}` };
        }
    },

    /** Verifica conectividad con SmartOLT y marca como verified */
    async verifySmartOLT(): Promise<{ ok: boolean; message: string }> {
        try {
            const authHeader = await this.getAuthHeader();
            if (!authHeader) return { ok: false, message: 'Sin sesión' };

            const res = await fetch(`${this.getSmartOLTProxyUrl()}/onu/unconfigured_onus`, {
                headers: { Authorization: authHeader }
            });

            const ok = res.status < 500;

            if (ok) {
                const settings = await this.getSettings();
                if (settings?.org_id) {
                    await supabase.from('organization_settings')
                        .update({ smartolt_verified: true })
                        .eq('org_id', settings.org_id);
                    _settingsCache = null; _cachePromise = null;
                }
            }

            return { ok, message: ok ? 'Conexión exitosa con SmartOLT' : `Error HTTP ${res.status}` };
        } catch (e) {
            return { ok: false, message: `Error de red: ${String(e)}` };
        }
    },

    /** Crea una nueva organización (para onboarding de nuevas empresas) */
    async createOrganization(params: {
        orgName: string;
        slug: string;
        companyName: string;
        wisphubUrl: string;
        wisphubToken: string;
        smartoltUrl?: string;
        smartoltToken?: string;
    }): Promise<{ org_id: string | null; error: string | null }> {
        try {
            const { data: org_id, error } = await supabase.rpc('create_organization', {
                org_name: params.orgName,
                org_slug: params.slug,
                company_name_input: params.companyName,
            });

            if (error) return { org_id: null, error: error.message };

            // Guardar credenciales API
            await supabase.from('organization_settings').update({
                wisphub_url: params.wisphubUrl,
                wisphub_token: params.wisphubToken,
                smartolt_url: params.smartoltUrl || null,
                smartolt_token: params.smartoltToken || null,
            }).eq('org_id', org_id);

            // Invalidar caché
            _settingsCache = null;
            _orgCache = null;
            _cachePromise = null;

            return { org_id, error: null };
        } catch (e: any) {
            return { org_id: null, error: e.message };
        }
    },

    /** Invalida el caché (llamar después de cambios de sesión) */
    invalidateCache() {
        _settingsCache = null;
        _orgCache = null;
        _cachePromise = null;
    },

    async _load(): Promise<{ org: OrgInfo | null; settings: OrgSettings | null }> {
        if (_settingsCache && _orgCache) {
            return { org: _orgCache, settings: _settingsCache };
        }

        if (_cachePromise) return _cachePromise;

        _cachePromise = (async () => {
            try {
                const { data: { user } } = await supabase.auth.getUser();
                if (!user) return { org: null, settings: null };

                const { data: profile } = await supabase
                    .from('profiles')
                    .select('org_id')
                    .eq('id', user.id)
                    .maybeSingle();

                if (!profile?.org_id) return { org: null, settings: null };

                const [{ data: org }, { data: settings }] = await Promise.all([
                    supabase.from('organizations').select('id, name, slug').eq('id', profile.org_id).single(),
                    supabase.from('organization_settings').select('*').eq('org_id', profile.org_id).single(),
                ]);

                _orgCache = org as OrgInfo | null;
                _settingsCache = settings as OrgSettings | null;

                return { org: _orgCache, settings: _settingsCache };
            } catch {
                return { org: null, settings: null };
            }
        })();

        return _cachePromise;
    },
};
