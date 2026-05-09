import { supabase, safeGetUser } from './supabase';
import { orgService } from './orgService';

export interface WispHubClient {
    id_servicio: number;
    nombre: string;
    cedula: string;
    estado: string;
    ip: string;
    plan_internet: {
        nombre: string;
        precio: number;
    };
    saldo_total?: number;
    fecha_instalacion?: string;
    last_result?: string; // Para mostrar errores/éxitos previos
    telefono?: string;    // Propiedad opcional para evitar errores ts(2339)
}

export interface WispHubPlan {
    id: number;
    nombre: string;
    precio?: number;
    Precio?: number;
    costo?: number;
    velocidad_bajada: number;
    velocidad_subida: number;
    tipo: string;
}

export interface WispHubStaff {
    id?: number | string;
    nombre: string;
    usuario: string;
    email?: string;
    nivel: string;
}

// En SaaS: cada tenant tiene su propia URL de WispHub, enrutada via Edge Function.
// La Edge Function lee las credenciales del tenant desde organization_settings.
const BASE_URL = orgService.getWispHubProxyUrl();

export const TICKET_SUBJECTS = [
    "Internet Lento", "No Tiene Internet", "No Responde El Router Wifi", "Router Wifi Reseteado(Valores De Fabrica)",
    "Cambio De Router Wifi", "Cambio De Contraseña En Router Wifi", "Cable Utp Dañado", "Internet Intermitente",
    "Cambio De Domicilio", "Reconexion", "Recolección De Equipos", "Conector Dañado", "Cambio A Fibra Óptica",
    "Cable Fibra Dañado", "Cables Mal Colocados", "Rj45 Dañado", "Cancelación", "Desconexión", "Caja Nap Dañada",
    "Niveles Potencia Altos", "Notificación Datacrédito", "Gestión De Cartera Corte 30", "Gestión De Cartera Corte 15",
    "Recolección De Equipos 2", "Noficación Datacrédito 2", "Retiro De Servicio", "Problema De Tv/Niveles Altos",
    "Problemas De Tv", "Internet Lento/Niveles Altos", "Validación De Niveles", "Instalación De Tv", "Problemas De Conexion",
    "Cable Flojo", "Cable De Fibra Colgado", "Cargador Dañado", "Router Dañado", "Verificacion De Megas", "Wifi Quemado",
    "Cable Bajito", "Sintonización Tv", "Instalación Tdt", "Reubicación de Onu", "Adaptación De Tdt", "Catv Quemada",
    "Problemas De Conexión/Niveles Altos", "Gestión Clausula", "Paz Y Salvo", "Descuento", "Recordatorio Pago Por Whatsapp",
    "Promesa De Pago", "Proyecto De Trabajo", "Cambio De Fecha 30", "Cambio De Fecha 15", "Cambio De Plan",
    "Cambio De Titular", "Gestión De Bienvenida", "No Interesado", "Cancela Solicitud", "Post Retiro", "Post Retiro 2 Gestión",
    "Post Retiro 3 Gestión", "Encuesta De Satisfacción", "Gestion Por Daño", "Cobro De Visita", "No Contesta Para Inst Tv",
    "Instalación Nueva", "Instalación De Switch", "Punto De Tv Adicional",
    "Prorrateo Corte 30", "Prorrateo Corte 15", "Oferta Planes", "Confirmacion De Pago", "Asesoria Para Pago En Linea",
    "Asesoria Para Traslado", "Asesoria Para Reconexion", "Asesoria Para Cambio De Titular", "Asesoria Para Cambio De Plan",
    "Asesoria Para Cambio De Fecha De Pago", "Firma Del Contrato", "Asesoria Para Retiro", "Recordatorio Whatsapp - Cartera 2024",
    "Gmail - Recordatorio De Pago Factura - Corte 30"
];

const FALLBACK_TECHNICIANS: WispHubStaff[] = [
    { id: "sistemas@rapilink-sas", nombre: "SISTEMAS RAPILINK", usuario: "sistemas@rapilink-sas", nivel: "Administrador" },
    { id: "tecnico4@rapilink-sas", nombre: "TOMAS MCAUSLAND", usuario: "tecnico4@rapilink-sas", nivel: "Técnico" },
    { id: "asistente.administrativa1@rapilink-sas", nombre: "VALENTINA SUAREZ", usuario: "asistente.administrativa1@rapilink-sas", nivel: "Técnico" },
    { id: "tecnico1@rapilink-sas", nombre: "ALEXANDER GOMEZ", usuario: "tecnico1@rapilink-sas", nivel: "Técnico" },
    { id: "asistente.administravo.3@rapilink-sas", nombre: "VANESSA BARRERA", usuario: "asistente.administravo.3@rapilink-sas", nivel: "Técnico" },
    { id: "instalaciones@rapilink-sas", nombre: "INSTALACIONES APROBADAS", usuario: "instalaciones@rapilink-sas", nivel: "Técnico", email: "instalaciones@gmail.com" }
];

let GLOBAL_CLIENT_CACHE: WispHubClient[] | null = null;
let GLOBAL_STAFF_CACHE: WispHubStaff[] | null = null;
let CACHE_PROMISE: Promise<void> | null = null;
let STAFF_PROMISE: Promise<WispHubStaff[]> | null = null;
let SUBJECTS_FETCH_FAILED = false;

export function toProxyUrl(url: string | null): string | null {
    if (!url) return null;
    // BLINDAJE INVIOLABLE: Forzar siempre .io, ignorando cualquier intento de .net
    // El proxy de Vite se encarga de dirigirlo a https://api.wisphub.io
    const sanitizedUrl = url.replace(/wisphub\.net/g, 'wisphub.io');
    return sanitizedUrl.replace(/https?:\/\/(api\.)?wisphub\.io\/api\/(v1\/)?/, BASE_URL + '/');
}

export async function safeFetch(url: string, options: RequestInit = {}, retries = 2, silent = false): Promise<Response> {
    const proxyUrl = toProxyUrl(url) || url;
    // Obtener JWT para autenticar la Edge Function (identifica al tenant)
    const authHeader = await orgService.getAuthHeader();

    for (let i = 0; i <= retries; i++) {
        try {
            const finalOptions: RequestInit = {
                ...options,
                headers: {
                    'Accept': 'application/json',
                    ...(authHeader ? { 'Authorization': authHeader } : {}),
                    ...(options.headers || {})
                }
            };

            const res = await fetch(proxyUrl, finalOptions);
            if (res.ok) return res;

            let errorBody = '';
            try {
                const clonedRes = res.clone();
                errorBody = await clonedRes.text();
            } catch (e) {
                errorBody = '(No se pudo leer el cuerpo del error)';
            }

            if (!silent) {
                console.error(`[WispHub API ERROR] 
URL: ${proxyUrl} 
Status: ${res.status} 
Body: ${errorBody.substring(0, 500)}
Attempt: ${i + 1}/${retries + 1}`);
            }

            // Si es 500, no reintentamos si ya falló 2 veces y es un error persistente de servidor
            if (res.status >= 500 && i === retries) return res;

            // 404, 401, 403, 400 son errores finales de cliente, no reintentamos
            if (res.status < 500 && res.status !== 429) return res;

        } catch (e) {
            if (!silent) console.error(`[WispHub FETCH EXCEPTION] URL: ${proxyUrl} Error: ${e}`);
        }
        if (i < retries) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
    return new Response(null, { status: 500 });
}

export function stripHtml(html: string): string {
    if (!html) return '';
    return html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<p>/gi, '\n')
        .replace(/<\/p>/gi, '')
        .replace(/<[^>]*>?/gm, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\n\s*\n/g, '\n\n')
        .trim();
}

export function whNormalize(text: string | null | undefined): string {
    if (!text) return "";
    return text.toString()
        .toLowerCase()
        .trim()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Quitar acentos
        .replace(/[^a-z0-9\s]/g, "")   // Quitar puntuación redundante
        .replace(/\s+/g, " ");          // Colapsar espacios múltiples
}


export const WisphubService = {
    async getStaff(): Promise<WispHubStaff[]> {
        if (GLOBAL_STAFF_CACHE) return GLOBAL_STAFF_CACHE;
        if (STAFF_PROMISE) return STAFF_PROMISE;

        STAFF_PROMISE = (async () => {
            try {
                console.log('[WisphubService] 🔍 Obteniendo staff desde Espejo Local (Supabase)...');

                const { data, error } = await supabase
                    .from('wisphub_staff')
                    .select('id, nombre, usuario, email, nivel');

                if (error) {
                    console.warn('[WisphubService] ⚠️ Falló consulta a espejo local, usando fallback:', error.message);
                    return FALLBACK_TECHNICIANS;
                }

                if (!data || data.length === 0) {
                    console.warn('[WisphubService] ⚠️ Espejo local vacío o inalcanzable, usando fallback.');
                    return FALLBACK_TECHNICIANS;
                }

                const mapped = data.map((s: any) => ({
                    id: s.id,
                    nombre: s.nombre,
                    usuario: s.usuario || '',
                    email: s.email || '',
                    nivel: s.nivel || 'Desconocido'
                }));

                console.log(`[WisphubService] ✅ Staff cargado desde espejo: ${mapped.length} registros`);
                GLOBAL_STAFF_CACHE = mapped;
                return mapped;
            } catch (error) {
                console.error('[WisphubService] 💥 Error crítico al obtener staff mirror:', error);
                return FALLBACK_TECHNICIANS;
            } finally {
                STAFF_PROMISE = null;
            }
        })();
        return STAFF_PROMISE;
    },

    async getInstallations(filters?: { search?: string; tecnico?: string | number; estado?: string; zona?: string }): Promise<any[]> {
        try {
            let url = `${BASE_URL}/instalaciones/?limit=50`;
            if (filters?.search) url += `&search=${encodeURIComponent(filters.search)}`;
            if (filters?.tecnico) url += `&tecnico=${filters.tecnico}`;
            if (filters?.estado) url += `&estado=${filters.estado}`;
            if (filters?.zona) url += `&nombre_zona=${encodeURIComponent(filters.zona)}`;

            const response = await safeFetch(url);
            if (!response.ok) return [];
            const data = await response.json();
            return data.results || [];
        } catch (error) {
            console.error('[WisphubService] Error fetching installations:', error);
            return [];
        }
    },

    async getClientForSmartOlt(cedula?: string, idServicio?: number, nombre?: string): Promise<any | null> {
        if (!cedula && !idServicio && !nombre) {
            console.warn('[WispHub] No se proporcionaron datos suficientes para buscar cliente.');
            return null;
        }

        const cleanCedula = cedula?.trim() || '';
        const cleanIdServicio = idServicio || null;
        const cleanNombre = nombre?.trim() || '';

        console.log(`[WispHub] 📡 Iniciando búsqueda de cliente para diagnóstico óptico:`, { 
            cedula: cleanCedula, 
            idServicio: cleanIdServicio,
            nombre: cleanNombre
        });

        try {
            // Intento 1: ID de Servicio (El más preciso)
            if (cleanIdServicio) {
                const url = `${BASE_URL}/clientes/?id_servicio=${cleanIdServicio}`;
                const response = await safeFetch(url);
                if (response.ok) {
                    const data = await response.json();
                    const results = data.results || (Array.isArray(data) ? data : []);
                    if (results.length > 0) {
                        console.log(`[WispHub] ✅ Cliente encontrado por id_servicio: ${results[0].nombre}`);
                        return results[0];
                    }
                }
            }

            // Intento 2: Cédula
            if (cleanCedula && cleanCedula !== "") {
                const url = `${BASE_URL}/clientes/?cedula=${encodeURIComponent(cleanCedula)}`;
                const response = await safeFetch(url);
                if (response.ok) {
                    const data = await response.json();
                    const results = data.results || (Array.isArray(data) ? data : []);
                    if (results.length > 0) {
                        console.log(`[WispHub] ✅ Cliente encontrado por cédula: ${results[0].nombre}`);
                        return results[0];
                    }
                }
            }

            // Intento 3: Nombre (Búsqueda general por aproximación)
            if (cleanNombre && cleanNombre !== "") {
                const url = `${BASE_URL}/clientes/?nombre=${encodeURIComponent(cleanNombre)}`;
                const response = await safeFetch(url);
                if (response.ok) {
                    const data = await response.json();
                    const results = data.results || (Array.isArray(data) ? data : []);
                    if (results.length > 0) {
                        console.log(`[WispHub] ✅ Cliente encontrado por nombre: ${results[0].nombre}`);
                        return results[0];
                    }
                }
            }

            console.warn(`[WispHub] ❌ No se encontró cliente con los parámetros proporcionados.`);
            return null;
        } catch (error) {
            console.error('[WispHub] Error en getClientForSmartOlt:', error);
            return null;
        }
    },

    async getAllClients(page: number = 1, limit: number = 20, filters?: { plan?: string; status?: string }): Promise<{ results: WispHubClient[], count: number }> {
        try {
            const offset = (page - 1) * limit;
            let url = `${BASE_URL}/clientes/?limit=${limit}&offset=${offset}&ordering=id`;
            if (filters?.plan) url += `&plan_internet=${filters.plan}`;
            if (filters?.status && filters.status !== 'Todos') url += `&estado=${encodeURIComponent(filters.status)}`;

            const response = await safeFetch(url);
            if (!response.ok) return { results: [], count: 0 };
            const data = await response.json();
            return { results: data.results || [], count: data.count || 0 };
        } catch (error) {
            return { results: [], count: 0 };
        }
    },

    async ensureFullCache(): Promise<void> {
        if (GLOBAL_CLIENT_CACHE !== null) return;
        if (CACHE_PROMISE !== null) return CACHE_PROMISE;

        CACHE_PROMISE = (async () => {
            try {
                let allClients: WispHubClient[] = [];
                let nextUrl: string | null = `${BASE_URL}/clientes/?limit=500`;
                let pages = 0;

                while (nextUrl && pages < 100) {
                    const res = await safeFetch(nextUrl);
                    if (!res.ok) break;
                    const data = await res.json();
                    allClients = [...allClients, ...(data.results || [])];
                    nextUrl = toProxyUrl(data.next);
                    pages++;
                }
                GLOBAL_CLIENT_CACHE = allClients;
            } catch (e) {
                console.error("[WispHub] Cache Sync Failed:", e);
            } finally {
                CACHE_PROMISE = null;
            }
        })();
        return CACHE_PROMISE;
    },

    async searchClients(query: string): Promise<WispHubClient[]> {
        if (!GLOBAL_CLIENT_CACHE) this.ensureFullCache();
        try {
            const isNumeric = /^\d+$/.test(query);
            if (!isNumeric && GLOBAL_CLIENT_CACHE) {
                const searchTerms = query.toLowerCase().trim().split(/\s+/);
                return GLOBAL_CLIENT_CACHE.filter(c => searchTerms.every(t => (c.nombre || '').toLowerCase().includes(t)));
            }
            const url = isNumeric ? `${BASE_URL}/clientes/?limit=50&cedula=${query}` : `${BASE_URL}/clientes/?limit=50&nombre=${encodeURIComponent(query)}`;
            const response = await safeFetch(url);
            if (!response.ok) return [];
            const data = await response.json();
            return data.results || [];
        } catch (error) {
            return [];
        }
    },

    async getInternetPlans(): Promise<WispHubPlan[]> {
        try {
            const response = await safeFetch(`${BASE_URL}/plan-internet/?limit=1000`);
            if (!response.ok) return [];
            const data = await response.json();
            return data.results || [];
        } catch (error) {
            return [];
        }
    },

    async getRouters(): Promise<any[]> {
        try {
            // FALLBACK: Usamos /zonas/ como fuente de routers/servidores ya que el endpoint /mikrotiks/ falla
            const response = await safeFetch(`${BASE_URL}/zonas/?limit=1000`);
            if (!response.ok) return [];
            const data = await response.json();
            return (data.results || []).map((z: any) => ({
                id: z.id,
                id_router: z.id,
                nombre: z.nombre,
                // Mapeo adicional por si el frontend espera otros campos
                ip: z.ip_server || '0.0.0.0'
            }));
        } catch (error) {
            return [];
        }
    },

    async getAvailableIps(_routerId: string | number): Promise<string[]> {
        // TODO: Endpoint de IPs no descubierto. Retornamos vacío para evitar errores 404 en consola.
        // Se requiere documentación técnica precisa sobre "ips-disponibles".
        console.warn('[WisphubService] Endpoint de IPs disponibles no encontrado. Retornando lista vacía.');
        return [];
        /* 
        try {
            if (!routerId) return [];
            const response = await safeFetch(`${BASE_URL}/ips-disponibles/?id_router=${routerId}`);
            if (!response.ok) return [];
            const data = await response.json();
            return Array.isArray(data) ? data : (data.results || []);
        } catch (error) {
            console.error('[WisphubService] Error fetching available IPs:', error);
            return [];
        }
        */
    },

    async getSectors(): Promise<any[]> {
        try {
            // INTENTO: Usar endpoint de zonas también para sectores o buscar dentro de zonas
            // Por ahora mapeamos zonas como sectores también para que no esté vacío el select
            const response = await safeFetch(`${BASE_URL}/zonas/?limit=1000`);
            if (!response.ok) return [];
            const data = await response.json();
            return (data.results || []).map((z: any) => ({
                id: z.id,
                id_sector: z.id,
                nombre: z.nombre,
                nombre_sector: z.nombre
            }));
        } catch (error) {
            return [];
        }
    },

    async createInstallation(installationData: any): Promise<{ success: boolean; data?: any; message?: string }> {
        try {
            // Validar que tengamos el ID de zona (id_router en nuestro caso representa la zona)
            if (!installationData.id_zona && !installationData.id_router) {
                return { success: false, message: 'ID de zona es obligatorio' };
            }

            const zonaId = installationData.id_zona || installationData.id_router;

            // Mapeo de campos según documentación oficial de WispHub
            const payload = {
                // Datos de conexión (OBLIGATORIOS)
                ip: installationData.ip || '',
                plan_internet: installationData.plan_internet || installationData.id_plan,

                // Datos de hardware
                // FALLBACK: Si no hay MAC, enviar 00:00:00:00:00:00 para pasar validación de API
                mac_cpe: installationData.mac_cpe || installationData.mac || '00:00:00:00:00:00',
                sn_onu: installationData.sn_onu || installationData.sn || '',

                // Datos del cliente
                nombre: installationData.nombre || '',
                apellidos: installationData.apellidos || installationData.apellido || '',
                email: installationData.email || '',
                cedula: installationData.cedula || installationData.dni || '',
                telefono: installationData.telefono || '',
                direccion: installationData.direccion || '',
                localidad: installationData.localidad || installationData.barrio || '',
                ciudad: installationData.ciudad || 'Soledad',

                // Coordenadas GPS
                coordenadas: installationData.coordenadas || (installationData.gps_latitud && installationData.gps_longitud
                    ? `${installationData.gps_latitud},${installationData.gps_longitud}`
                    : ''),

                // Datos de autenticación PPPoE
                // CORRECCIÓN: Usuario RB = Nombre + Apellido (para Simple Queue / PPPoE)
                // Para Cola Simple, la contraseña va vacía.
                usuario_rb: installationData.usuario_rb || `${installationData.nombre || ''} ${installationData.apellidos || installationData.apellido || ''}`.trim(),
                password_rb: installationData.password_rb || '',

                // Datos de instalación
                forma_contratacion: installationData.forma_contratacion || 3, // 3 = Oficina (default)
                costo_instalacion: installationData.costo_instalacion || installationData.costo || '0',
                estado_instalacion: installationData.estado_instalacion || 2, // 2 = En Progreso
                comentarios: installationData.comentarios || installationData.comentario || ''
            };

            console.log('[WispHub] Payload de instalación enviado:', JSON.stringify(payload, null, 2));

            // Endpoint correcto según documentación: /clientes/agregar-cliente/{id_zona}/?instalacion
            const url = `${BASE_URL}/clientes/agregar-cliente/${zonaId}/?instalacion`;
            console.log('[WispHub] URL de instalación:', url);

            const response = await safeFetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (response.ok) {
                const data = await response.json();
                console.log('[WispHub] Instalación creada exitosamente:', data);
                return { success: true, data };
            } else {
                let errorDetail = 'Sin detalles';
                try {
                    const errorBody = await response.text();
                    errorDetail = errorBody;
                    console.error('[WispHub] Error HTTP', response.status, ':', errorBody);
                } catch (parseError) {
                    console.error('[WispHub] No se pudo leer el cuerpo del error');
                }
                return {
                    success: false,
                    message: `HTTP ${response.status}: ${errorDetail.substring(0, 200)}`
                };
            }
        } catch (error: any) {
            console.error('[WispHub] Error de red o excepción:', error);
            return { success: false, message: error.message || 'Error desconocido' };
        }
    },

    // Método legacy de createClient - redirigir al método correcto
    async createClient(clientData: any): Promise<{ success: boolean; data?: any; message?: string }> {
        return this.createInstallation(clientData);
    },

    async getInvoices(serviceId: number): Promise<any[]> {
        try {
            const url = `${BASE_URL}/facturas/?id_servicio=${serviceId}&limit=50&ordering=-id`;
            const response = await safeFetch(url);
            if (!response.ok) return [];
            const data = await response.json();
            return data.results || [];
        } catch (error) {
            console.error("[WispHub] Error fetching invoices:", error);
            return [];
        }
    },

    async getTickets(serviceId: number, _clientName?: string, cedula?: string): Promise<any[]> {
        try {
            const currentSId = String(serviceId);
            const targetCedula = String(cedula || "").trim();

            let historicalSIds = new Set<string>([currentSId]);
            try {
                const invoices = await this.getInvoices(serviceId);
                invoices.forEach(inv => {
                    if (inv.servicio?.id_servicio) historicalSIds.add(String(inv.servicio.id_servicio));
                    else if (inv.servicio) historicalSIds.add(String(inv.servicio));
                });
            } catch (e) { /* ignore */ }

            const queries = Array.from(historicalSIds).map(id => `${BASE_URL}/tickets/?search=${id}&limit=50`);
            if (targetCedula.length > 5) {
                queries.push(`${BASE_URL}/tickets/?search=${targetCedula}&limit=50`);
            }

            const results = await Promise.all(
                queries.slice(0, 10).map(url => safeFetch(url).then(res => res.ok ? res.json() : { results: [] }))
            );

            let allFound: any[] = [];
            results.forEach(data => { if (data.results) allFound = [...allFound, ...data.results]; });

            const mapped = allFound.map(t => this.mapTicket(t));
            const uniqueMap = new Map();

            mapped.forEach(t => {
                const isIdMatch = historicalSIds.has(String(t.servicio));
                const isCedulaMatch = targetCedula.length > 5 && targetCedula === String(t.cedula).trim();
                if (isIdMatch || isCedulaMatch) {
                    uniqueMap.set(t.id, t);
                }
            });

            return Array.from(uniqueMap.values()).sort((a: any, b: any) => Number(b.id) - Number(a.id));
        } catch (error) {
            console.error("[WispHub] Error en historial:", error);
            return [];
        }
    },

    async getTicketSubjects(): Promise<string[]> {
        if (SUBJECTS_FETCH_FAILED) return TICKET_SUBJECTS;
        try {
            // Probamos primero sin barra final (más común) y en modo SILENCIOSO
            let response = await safeFetch(`${BASE_URL}/asuntos-tickets`, {
                headers: { 'Accept': 'application/json' }
            }, 0, true);

            // Si falla, probamos con barra final, también silencioso
            if (!response.ok) {
                response = await safeFetch(`${BASE_URL}/asuntos-tickets/`, {
                    headers: { 'Accept': 'application/json' }
                }, 0, true);
            }

            if (!response || !response.ok) {
                SUBJECTS_FETCH_FAILED = true;
                // Silent failure: Don't flood console with 404s for subjects if that's the error
                if (response?.status !== 404) {
                    console.info('[WispHub] Usando catálogo de asuntos local (API no disponible).');
                }
                return TICKET_SUBJECTS;
            }

            const data = await response.json();

            // Validar que los datos sean JSON y no una página HTML
            if (typeof data !== 'object' || data === null) {
                console.warn('[WispHub] Subjects API returned non-JSON data, using fallbacks.');
                return TICKET_SUBJECTS;
            }

            const results = data.results || data || [];
            if (!Array.isArray(results) || results.length === 0) return TICKET_SUBJECTS;

            const subjects = Array.from(new Set(results.map((s: any) => s.nombre || s.asunto || s)))
                .filter(Boolean)
                .sort() as string[];

            return subjects.length > 0 ? subjects : TICKET_SUBJECTS;
        } catch (error) {
            return TICKET_SUBJECTS;
        }
    },

    /**
     * Obtiene una lista única de barrios y coordenadas (si existen) desde la lista de clientes.
     */
    async getAllClientsBarrios(): Promise<{ name: string; latitude?: number; longitude?: number; count: number }[]> {
        try {
            console.log('[WispHub] Extrayendo barrios desde la lista de clientes...');
            // Obtenemos una muestra significativa de clientes activos (limit 500 para balancear velocidad)
            const url = `${BASE_URL}/clientes/?estado=1&limit=500`;
            const response = await safeFetch(url);

            if (!response.ok) {
                console.error('[WispHub] Error al consultar clientes para barrios:', response.status);
                return [];
            }

            const data = await response.json();
            const clients = data.results || [];

            const neighborhoodMap = new Map<string, { name: string; latSum: number; lngSum: number; geoCount: number; totalCount: number }>();

            clients.forEach((c: any) => {
                const bName = (c.barrio || c.localidad || 'Sin Barrio').trim();
                if (!bName) return;

                const normalizedKey = whNormalize(bName);

                const existing = neighborhoodMap.get(normalizedKey) || {
                    name: bName, // Guardamos el primer nombre legible que encontremos
                    latSum: 0,
                    lngSum: 0,
                    geoCount: 0,
                    totalCount: 0
                };

                existing.totalCount++;

                // Si el cliente tiene coordenadas válidas en WispHub, las promediamos
                const lat = parseFloat(c.latitud);
                const lng = parseFloat(c.longitud);

                if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
                    existing.latSum += lat;
                    existing.lngSum += lng;
                    existing.geoCount++;
                }

                neighborhoodMap.set(normalizedKey, existing);
            });

            return Array.from(neighborhoodMap.values()).map(item => ({
                name: item.name,
                latitude: item.geoCount > 0 ? item.latSum / item.geoCount : undefined,
                longitude: item.geoCount > 0 ? item.lngSum / item.geoCount : undefined,
                count: item.totalCount
            })).sort((a, b) => b.count - a.count);

        } catch (error) {
            console.error('[WispHub] Error crítico en getAllClientsBarrios:', error);
            return [];
        }
    },

    async getAllTickets(filters?: { startDate?: string; endDate?: string; status?: string }, onProgress?: (current: number, total: number) => void): Promise<any[]> {
        try {
            // Asegurar que el staff esté cargado para mapear nombres reales
            await this.getStaff();

            // Manejo optimizado para múltiples estados separados por comas
            if (filters?.status && filters.status.includes(',')) {
                // SEGURIDAD & RATE LIMIT: Fetch secuencial (uno tras otro)
                // Usar for...of para evitar saturar WispHub.io con 3 peticiones pesadas al unísono
                const statusList = filters.status.split(',');
                const finalMap = new Map<string, any>();
                
                console.log(`[WispHub.io] 🛡️ Iniciando fetch secuencial para estados: ${filters.status}`);
                
                for (const st of statusList) {
                    const tickets = await this.getAllTickets({ ...filters, status: st });
                    for (const t of tickets) {
                        finalMap.set(String(t.id), t);
                    }
                    // Breve pausa técnica de 200ms entre estados para mayor seguridad
                    await new Promise(r => setTimeout(r, 200));
                }
                
                const resultArr = Array.from(finalMap.values());
                if (onProgress) onProgress(resultArr.length, resultArr.length);
                return resultArr;
            }

            const pageSize = 50;
            let baseUrl = `${BASE_URL}/tickets/?limit=${pageSize}&offset=0&ordering=-id`;

            if (filters?.status && !filters.status.includes(',')) {
                baseUrl += `&estado=${filters.status}`; // OJO: WispHub API requiere 'estado', NO 'id_estado'
            }

            // Lógica de fechas
            if (filters?.startDate || filters?.endDate) {
                const start = filters.startDate || '2024-01-01';
                const end = filters.endDate || new Date().toISOString().split('T')[0];
                baseUrl += `&fecha_creacion_0=${start}&fecha_creacion_1=${end}`;
            } else if (filters?.status && (filters.status === '1' || filters.status === '2' || filters.status === '5')) {
                const past = new Date();
                past.setDate(past.getDate() - 60); // 60 días para buscar tickets abiertos
                const start = past.toISOString().split('T')[0];
                const end = new Date().toISOString().split('T')[0];
                baseUrl += `&fecha_creacion_0=${start}&fecha_creacion_1=${end}`;
            } else {
                const past = new Date();
                past.setDate(past.getDate() - 7); // Reducido de 30 a 7
                const start = past.toISOString().split('T')[0];
                const end = new Date().toISOString().split('T')[0];
                baseUrl += `&fecha_creacion_0=${start}&fecha_creacion_1=${end}`;
            }

            console.log(`[REQUEST] URL Base Tickets WispHub: ${baseUrl}`);

            const firstResponse = await safeFetch(baseUrl);
            if (!firstResponse.ok) return [];

            const firstData = await firstResponse.json();
            const totalCount = firstData.count || 0;
            const uniqueTicketsMap = new Map<string, any>();

            // Procesar primera página
            (firstData.results || []).forEach((t: any) => {
                const mapped = this.mapTicket(t);
                // Si enviamos id_estado en la URL, WispHub ya filtra, pero reforzamos localmente por si acaso
                const filterStatus = String(filters?.status || '');
                if (!filterStatus || filterStatus.split(',').includes(String(mapped.id_estado))) {
                    uniqueTicketsMap.set(mapped.id, mapped);
                }
            });

            if (onProgress) onProgress(uniqueTicketsMap.size, totalCount);

            const remainingOffsets = [];
            // Aumentamos el límite de seguridad a 2,000 (40 páginas) para no saturar memoria/vps
            for (let offset = pageSize; offset < totalCount && offset < 2000; offset += pageSize) {
                remainingOffsets.push(offset);
            }

            for (const offset of remainingOffsets) {
                const pageUrl = baseUrl.replace('offset=0', `offset=${offset}`);
                const response = await safeFetch(pageUrl);
                if (response.ok) {
                    const data = await response.json();
                    (data.results || []).forEach((t: any) => {
                        const mapped = this.mapTicket(t);
                        const filterStatus = String(filters?.status || '');
                        if (!filterStatus || filterStatus.split(',').includes(String(mapped.id_estado))) {
                            uniqueTicketsMap.set(mapped.id, mapped);
                        }
                    });
                    if (onProgress) onProgress(uniqueTicketsMap.size, totalCount);
                }
                await new Promise(r => setTimeout(r, 150));
                if (uniqueTicketsMap.size >= 1000) break;
            }

            const finalResults = Array.from(uniqueTicketsMap.values());
            console.log(`[SUCCESS] WisphubService.getAllTickets finalizó con ${finalResults.length} tickets mapeados.`);
            return finalResults;
        } catch (error) {
            console.error("[WispHub] Error loading all tickets:", error);
            return [];
        }
    },

    mapTicket(t: any) {

        // --- EXTRACCIÓN DE HORA DE LLEGADA (NUEVO) ---
        let fechaLlegada: string | null = null;
        if (t.respuestas && Array.isArray(t.respuestas)) {
            const ARRIVAL_PATTERNS = [
                'llegada al destino',
                'llegada al sitio',
                'ha llegado a la ubicación',
                'llegada a ubicación'
            ];

            // WispHub ordena las respuestas de más reciente a más antigua usualmente,
            // pero para la llegada queremos la primera ocurrencia si por alguna razón hay varias
            const arrivalComment = t.respuestas.find((r: any) => {
                const text = (r.respuesta || '').toLowerCase();
                return ARRIVAL_PATTERNS.some(p => text.includes(p));
            });

            if (arrivalComment && arrivalComment.created) {
                fechaLlegada = arrivalComment.created;
            }
        }

        const now = new Date();
        const createdDate = new Date(t.fecha_creacion || t.created_at || t.fecha);
        const diffMs = now.getTime() - createdDate.getTime();
        const diffHours = Math.floor(diffMs / (1000 * 60 * 60));

        const priorityLabels: any = { '1': 'Baja', '2': 'Normal', '3': 'Alta', '4': 'Muy Alta', '5': 'Crítica' };
        const priorityTextToId: any = { 'Baja': 1, 'Normal': 2, 'Alta': 3, 'Muy Alta': 4, 'Crítica': 5 };

        let priorityKey = String(t.prioridad || '1');
        if (priorityTextToId[priorityKey]) priorityKey = String(priorityTextToId[priorityKey]);

        let finalClientName = (t.nombre_cliente || t.cliente_nombre || t.nombre_completo || t.cliente || t.nombre || "");

        // Si el cliente es un objeto (como en el detalle), extraer nombre
        if (typeof finalClientName === 'object') {
            const co = finalClientName as any;
            finalClientName = co.nombre || co.client_name || co.nombre_cliente || co.nombre_completo || co.full_name || "";
        }

        // Si tenemos nombre y apellido separados en la raíz
        if (!finalClientName || finalClientName === "") {
            const firstName = t.nombre || t.first_name || "";
            const lastName = t.apellidos || t.apellido || t.last_name || "";
            if (firstName || lastName) finalClientName = `${firstName} ${lastName}`.trim();
        }

        let finalCedula = "";

        // Intentar extraer de objetos anidados (cliente o servicio)
        const possibleClient = t.cliente || t.servicio;
        if (possibleClient && typeof possibleClient === 'object') {
            finalClientName = finalClientName ||
                possibleClient.nombre ||
                possibleClient.client_name ||
                possibleClient.nombre_cliente ||
                possibleClient.nombre_completo ||
                possibleClient.cliente_nombre ||
                possibleClient.nombre_cliente_completo || "";
            finalCedula = possibleClient.cedula || possibleClient.dni || "";
        }

        const serviceObj = typeof t.servicio === 'object' ? t.servicio : null;
        const clientObj = typeof t.cliente === 'object' ? t.cliente : null;

        let finalServiceId = (t.id_servicio || t.cliente_id) ? String(t.id_servicio || t.cliente_id) :
            (serviceObj?.id_servicio || serviceObj?.id || (typeof t.servicio !== 'object' ? String(t.servicio || "") : null));

        // --- ÚLTIMA RED DE SEGURIDAD PARA EL NOMBRE ---
        if (!finalClientName || finalClientName === "Cliente Desconocido") {
            // Si tenemos el usuario de wisphub, lo usamos como nombre
            const backupUser = serviceObj?.usuario || clientObj?.usuario || t.usuario || t.username;
            if (backupUser) finalClientName = `USUARIO: ${backupUser}`;
            else if (finalServiceId) finalClientName = `SERVICIO: ${finalServiceId}`;
        }
        if (serviceObj) {
            if (!finalServiceId) finalServiceId = String(serviceObj.id_servicio || serviceObj.id);
            if (!finalCedula) finalCedula = serviceObj.cedula || "";
        } else if (clientObj) {
            if (!finalServiceId) finalServiceId = String(clientObj.id_servicio || clientObj.id);
            if (!finalCedula) finalCedula = clientObj.cedula || "";
        }

        let finalAsunto = "Sin Asunto";
        if (t.asunto) {
            finalAsunto = typeof t.asunto === 'object' ? (t.asunto.nombre || "Asunto") : String(t.asunto);
        }

        // --- HEURÍSTICA DE NORMALIZACIÓN: CORREGIR INTERCAMBIO CLIENTE <-> ASUNTO ---
        // WispHub a veces pone el tipo de trabajo en 'nombre_cliente' y el cliente en 'asunto' para instalaciones.
        const normClient = whNormalize(finalClientName);
        const subjectKeywords = ['instalacion', 'cambio de', 'retiro', 'soporte', 'revision', 'reconexion'];

        const clientLooksLikeSubject = subjectKeywords.some(key => normClient.includes(key));
        const asuntoLooksLikeName = finalAsunto.includes('/') || finalAsunto.split(' ').length >= 2;

        if (clientLooksLikeSubject && asuntoLooksLikeName) {
            const temp = finalClientName;
            finalClientName = finalAsunto;
            finalAsunto = temp;
        }

        // --- EXTRACCIÓN INTELIGENTE PARA INSTALACIONES NUEVAS ---
        let extractedDireccion = serviceObj?.direccion || t.direccion || '';
        let extractedBarrio = serviceObj?.barrio || serviceObj?.localidad || t.barrio || '';
        let extractedCedula = finalCedula;

        const isNewInstallation = finalAsunto.toUpperCase().includes('INSTALACION');
        const isAddressUnknown = !extractedDireccion || extractedDireccion.toUpperCase().includes('DESCONOCIDO') || extractedDireccion.trim() === '';

        if (isNewInstallation && isAddressUnknown && t.descripcion) {
            const cleanDesc = t.descripcion.replace(/<[^>]*>?/gm, ' ')
                .replace(/&nbsp;/g, ' ')
                .replace(/&Oacute;/g, 'Ó')
                .replace(/&Uacute;/g, 'Ú')
                .replace(/\s+/g, ' ')
                .trim();

            const extractField = (text: string, fieldName: string) => {
                const regex = new RegExp(`${fieldName}\\s*(.*?)(?=\\s+[A-ZÁÉÍÓÚÑ]{3,}|$)`, 'i');
                const match = text.match(regex);
                return match ? match[1].trim() : null;
            };

            const extrBarrio = extractField(cleanDesc, 'BARRIO');
            const extrDireccion = extractField(cleanDesc, 'DIRECCIÓN DE RESIDENCIA');
            const extrCedula = extractField(cleanDesc, 'NÚMERO DE DOCUMENTO DE IDENTIDAD');

            if (extrBarrio) extractedBarrio = extrBarrio;
            if (extrDireccion) extractedDireccion = extrDireccion;
            if (extrCedula) extractedCedula = extrCedula;
        }

        const statusText = String(t.estado || t.nombre_estado || 'Nuevo');
        let finalNombreEstado = statusText;
        let finalIdEstado = Number(t.id_estado);

        if (isNaN(finalIdEstado)) {
            const lowerStatus = statusText.toLowerCase();
            if (lowerStatus.includes('cerrado')) {
                finalIdEstado = 4;
                finalNombreEstado = 'Cerrado';
            } else if (lowerStatus.includes('resuelto')) {
                finalIdEstado = 3;
                finalNombreEstado = 'Resuelto';
            } else if (lowerStatus.includes('progreso') || lowerStatus.includes('espera')) {
                finalIdEstado = 2;
                finalNombreEstado = 'En Progreso';
            } else {
                finalIdEstado = 1;
                finalNombreEstado = 'Abierto';
            }
        } else {
            if (finalIdEstado === 4) finalNombreEstado = 'Cerrado';
            else if (finalIdEstado === 3) finalNombreEstado = 'Resuelto';
            else if (finalIdEstado === 2) finalNombreEstado = 'En Progreso';
            else if (finalIdEstado === 1) finalNombreEstado = 'Abierto';
        }

        return {
            id: String(t.id_ticket || t.id || "0"),
            asunto: finalAsunto,
            nombre_cliente: finalClientName,
            cedula: extractedCedula,
            prioridad: priorityLabels[priorityKey] || "Normal",
            id_prioridad: Number(priorityKey),
            nombre_estado: finalNombreEstado,
            id_estado: finalIdEstado,
            id_servicio: finalServiceId,
            servicio: finalServiceId,
            servicio_completo: serviceObj,
            nombre_tecnico: (() => {
                const techIdentifier = String(t.tecnico && typeof t.tecnico === 'object' ? (t.tecnico.usuario || t.tecnico.username || t.tecnico.email || t.tecnico.nombre) : t.tecnico || t.nombre_tecnico || "").toLowerCase().trim();
                const techIdStr = String(t.tecnico_id || (t.tecnico && typeof t.tecnico === 'object' ? (t.tecnico.id || t.tecnico.id_usuario) : "")).trim();
                const techEmail = String(t.email_tecnico || (t.tecnico && typeof t.tecnico === 'object' ? t.tecnico.email : "")).toLowerCase().trim();

                let finalName = t.nombre_tecnico || (t.tecnico && typeof t.tecnico === 'object' ? t.tecnico.nombre : null) || "Sin asignar";

                if (GLOBAL_STAFF_CACHE) {
                    const found = GLOBAL_STAFF_CACHE.find(s =>
                        (s.usuario && s.usuario.toLowerCase() === techIdentifier) ||
                        (s.email && (s.email.toLowerCase() === techIdentifier || s.email.toLowerCase() === techEmail)) ||
                        (String(s.id) === techIdStr && techIdStr !== "") ||
                        (s.nombre && (s.nombre.toLowerCase() === techIdentifier || whNormalize(s.nombre) === whNormalize(techIdentifier)))
                    );
                    if (found) finalName = found.nombre;
                }
                return finalName;
            })(),
            tecnico_id: (() => {
                const techIdentifier = String(t.tecnico && typeof t.tecnico === 'object' ? (t.tecnico.usuario || t.tecnico.username || t.tecnico.email || t.tecnico.nombre) : t.tecnico || t.nombre_tecnico || "").toLowerCase().trim();
                const techIdStr = String(t.tecnico_id || (t.tecnico && typeof t.tecnico === 'object' ? (t.tecnico.id || t.tecnico.id_usuario) : "")).trim();
                const techEmail = String(t.email_tecnico || (t.tecnico && typeof t.tecnico === 'object' ? t.tecnico.email : "")).toLowerCase().trim();

                if (GLOBAL_STAFF_CACHE) {
                    const found = GLOBAL_STAFF_CACHE.find(s =>
                        (s.usuario && s.usuario.toLowerCase() === techIdentifier) ||
                        (s.email && (s.email.toLowerCase() === techIdentifier || s.email.toLowerCase() === techEmail)) ||
                        (String(s.id) === techIdStr && techIdStr !== "") ||
                        (s.nombre && (s.nombre.toLowerCase() === techIdentifier || whNormalize(s.nombre) === whNormalize(techIdentifier)))
                    );
                    if (found) return found.id;
                }
                return t.tecnico_id || (t.tecnico && typeof t.tecnico === 'object' ? (t.tecnico.id || t.tecnico.id_usuario) : null);
            })(),
            tecnico_usuario: (() => {
                const techIdentifier = String(t.tecnico && typeof t.tecnico === 'object' ? (t.tecnico.usuario || t.tecnico.username || t.tecnico.email || t.tecnico.nombre) : t.tecnico || t.nombre_tecnico || "").toLowerCase().trim();
                const techIdStr = String(t.tecnico_id || (t.tecnico && typeof t.tecnico === 'object' ? (t.tecnico.id || t.tecnico.id_usuario) : "")).trim();
                const techEmail = String(t.email_tecnico || (t.tecnico && typeof t.tecnico === 'object' ? t.tecnico.email : "")).toLowerCase().trim();

                if (GLOBAL_STAFF_CACHE) {
                    const found = GLOBAL_STAFF_CACHE.find(s =>
                        (s.usuario && s.usuario.toLowerCase() === techIdentifier) ||
                        (s.email && (s.email.toLowerCase() === techIdentifier || s.email.toLowerCase() === techEmail)) ||
                        (String(s.id) === techIdStr && techIdStr !== "") ||
                        (s.nombre && (s.nombre.toLowerCase() === techIdentifier || whNormalize(s.nombre) === whNormalize(techIdentifier)))
                    );
                    if (found) return found.usuario;
                }
                return t.tecnico_usuario || (t.tecnico && typeof t.tecnico === 'object' ? (t.tecnico.usuario || t.tecnico.username) : null);
            })(),
            email_tecnico: (() => {
                const techIdentifier = String(t.tecnico && typeof t.tecnico === 'object' ? (t.tecnico.usuario || t.tecnico.username || t.tecnico.email || t.tecnico.nombre) : t.tecnico || t.nombre_tecnico || "").toLowerCase().trim();
                const techIdStr = String(t.tecnico_id || (t.tecnico && typeof t.tecnico === 'object' ? (t.tecnico.id || t.tecnico.id_usuario) : "")).trim();
                const techEmail = String(t.email_tecnico || (t.tecnico && typeof t.tecnico === 'object' ? t.tecnico.email : "")).toLowerCase().trim();

                if (GLOBAL_STAFF_CACHE) {
                    const found = GLOBAL_STAFF_CACHE.find(s =>
                        (s.usuario && s.usuario.toLowerCase() === techIdentifier) ||
                        (s.email && (s.email.toLowerCase() === techIdentifier || s.email.toLowerCase() === techEmail)) ||
                        (String(s.id) === techIdStr && techIdStr !== "") ||
                        (s.nombre && (s.nombre.toLowerCase() === techIdentifier || whNormalize(s.nombre) === whNormalize(techIdentifier)))
                    );
                    if (found) return found.email;
                }
                return t.email_tecnico || (t.tecnico && typeof t.tecnico === 'object' ? t.tecnico.email : null);
            })(),
            horas_abierto: diffHours,
            sla_status: diffHours > 48 ? 'critico' : diffHours > 24 ? 'amarillo' : 'verde',
            fecha_creacion: t.fecha_creacion || t.created_at || t.fecha,
            fecha_inicio: t.fecha_inicio || null,
            fecha_final: t.fecha_fin || t.fecha_final || t.fecha_termino || null,
            fecha_estimada_inicio: t.fecha_estimada_inicio || null,
            fecha_estimada_fin: t.fecha_estimada_fin || null,
            fecha_llegada: fechaLlegada,
            creado_por: (() => {
                const creatorId = String(t.creado_por || t.created_by || "").toLowerCase().trim();
                if (!creatorId) return 'Sistema';

                if (GLOBAL_STAFF_CACHE) {
                    const found = GLOBAL_STAFF_CACHE.find(s =>
                        (s.usuario && s.usuario.toLowerCase() === creatorId) ||
                        (s.email && s.email.toLowerCase() === creatorId) ||
                        (whNormalize(s.nombre) === whNormalize(creatorId))
                    );
                    if (found) return found.nombre;
                }
                return t.creado_por || t.created_by || 'Sistema';
            })(),
            descripcion: t.descripcion || '',
            // Campos extendidos de servicio (útiles para despacho y detalles)
            direccion: extractedDireccion,
            barrio: extractedBarrio || 'Sin Barrio',
            telefono: serviceObj?.telefono || t.telefono || '',
            celular: serviceObj?.celular || t.celular || '',
            ip: serviceObj?.ip || serviceObj?.ip_servicio || t.ip || t.ip_servicio || '',
            usuario_wisphub: serviceObj?.usuario ||
                clientObj?.usuario ||
                t.usuario ||
                t.usuario_wisphub ||
                t.username ||
                t.user ||
                t.usuario_mikrotik || 'N/A',
            estado_servicio: serviceObj?.estado || clientObj?.estado || t.estado_servicio || 'Activo'
        };
    },

    async getTicketDetail(id: string | number): Promise<any> {
        const raw = await this.getTicketRaw(id);
        return raw ? this.mapTicket(raw) : null;
    },

    async getTicketRaw(id: string | number): Promise<any> {
        try {
            const response = await safeFetch(`${BASE_URL}/tickets/${id}/`);
            if (response.status === 404) return null;
            if (!response.ok) {
                throw new Error(`WispHub API Error: ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            console.error(`[WispHub] Error in getTicketRaw #${id}:`, error);
            throw error; // Re-lanzar para que el sync sepa que falló
        }
    },

    async getServiceDetail(id: string | number): Promise<any> {
        try {
            const response = await safeFetch(`${BASE_URL}/clientes/${id}/`);
            return response.ok ? await response.json() : null;
        } catch (e) {
            return null;
        }
    },

    async getClientPortalLink(serviceId: string | number): Promise<string | null> {
        try {
            const response = await safeFetch(`${BASE_URL}/clientes/${serviceId}/saldo/`);
            if (response.ok) {
                const data = await response.json();
                return data.enlace_portal || data.url || null;
            }
            return null;
        } catch (e) {
            return null;
        }
    },

    async getPlanDetails(id: string | number, type?: string): Promise<any> {
        try {
            let detailUrl = `${BASE_URL}/plan-internet/queue/${id}/`;
            if (type?.toLowerCase().includes('pppoe')) detailUrl = `${BASE_URL}/plan-internet/pppoe/${id}/`;
            const response = await safeFetch(detailUrl);
            if (response.ok) return await response.json();
            const altUrl = detailUrl.includes('queue') ? `${BASE_URL}/plan-internet/pppoe/${id}/` : `${BASE_URL}/plan-internet/queue/${id}/`;
            const altRes = await safeFetch(altUrl);
            return altRes.ok ? await altRes.json() : null;
        } catch (e) {
            return null;
        }
    },

    async getClientBalance(serviceId: number | string): Promise<number> {
        try {
            const response = await safeFetch(`${BASE_URL}/clientes/${serviceId}/saldo/`);
            let saldo = 0;
            if (response.ok) {
                const data = await response.json();
                saldo = Number(data.saldo || 0);
            }
            return saldo;
        } catch (e) {
            return 0;
        }
    },

    async getTicketComments(ticketId: string | number): Promise<any[]> {
        try {
            const response = await safeFetch(`${BASE_URL}/tickets/comentarios/?ticket=${ticketId}`);
            if (!response.ok) return [];
            const data = await response.json();
            return data.results || data || [];
        } catch (e) {
            return [];
        }
    },

    async addTicketComment(ticketId: string | number, comment: string, file?: File | Blob, silent = false): Promise<boolean> {
        try {
            const hasFile = !!file;
            const headers: Record<string, string> = hasFile ? {} : { 'Content-Type': 'application/json' };

            // Estrategia de Endpoints a probar en orden
            const endpoints = [
                `${BASE_URL}/tickets/${ticketId}/comentarios/`, // Prioridad 1: .io Comentarios
                `${BASE_URL}/tickets/${ticketId}/respuestas/`,  // Prioridad 2: .io Respuestas
                `${BASE_URL}/tickets/comentarios/`,             // Fallback 1: global
                `${BASE_URL}/tickets/respuestas/`              // Fallback 2: global
            ];

            let body;
            if (hasFile) {
                const formData = new FormData();
                formData.append('ticket', String(ticketId));
                formData.append('comentario', comment);
                formData.append('respuesta', comment); // Backup field based on user feedback
                if (file) formData.append('archivo', file);
                body = formData;
            } else {
                body = JSON.stringify({
                    ticket: String(ticketId),
                    comentario: comment,
                    respuesta: comment // Backup field based on user feedback
                });
            }

            for (const url of endpoints) {
                try {
                    const response = await safeFetch(url, {
                        method: 'POST',
                        headers,
                        body
                    }, 0, silent); // 0 retries here because we are brute-forcing multiple URLs

                    if (response.ok) {
                        console.log(`[WispHub SUCCESS] Comentario enviado con éxito a: ${url}`);
                        return true;
                    }

                    // If 404 and silent, don't try other URLs, they will likely fail too
                    if (response.status === 404 && silent) return false;

                    if (!silent) {
                        const errText = await response.text();
                        console.warn(`[WispHub] Falló endpoint ${url}: ${response.status} - ${errText}`);
                    }
                } catch (innerErr) {
                    if (!silent) console.warn(`[WispHub] Excepción en endpoint ${url}:`, innerErr);
                }
            }

            if (!silent) console.error('[WispHub] Todos los intentos de enviar comentario fallaron.');
            return false;
        } catch (e) {
            console.error('[WispHub] Add Comment Critical Exception:', e);
            return false;
        }
    },

    async updateTicket(ticketId: string | number, data: any, method: 'PATCH' | 'PUT' = 'PATCH'): Promise<boolean> {
        console.log('[WisphubService.updateTicket] 🚀 Iniciando:', { ticketId, method, dataKeys: Object.keys(data) });
        try {
            // WispHub API seems to require multipart/form-data for ticket updates
            // even if no file is present.
            const fd = new FormData();

            // Si data ya tiene propiedades planas, las agregamos
            Object.keys(data).forEach(key => {
                const value = data[key];
                if (value !== undefined && value !== null) {
                    if (key === 'fecha_inicio' || key === 'fecha_final') {
                        // Ensure date format is correct if it's a Date object or ISO string
                        // But better to trust the caller handles formatting to DD/MM/YYYY HH:mm
                        fd.append(key, String(value));
                        console.log(`[WisphubService.updateTicket] 📅 ${key}:`, String(value));
                    } else if (value instanceof File || value instanceof Blob) {
                        // Ensure the file has a valid name and extension for WispHub
                        const allowedExts = ['docx', 'doc', 'pdf', 'png', 'jpeg', 'jpg', 'gif', 'heif', 'heic'];
                        let fileName = 'archivo.jpg';
                        if (value instanceof File && value.name) {
                            const parts = value.name.split('.');
                            let ext = parts.pop()?.toLowerCase() || 'jpg';
                            const base = parts.join('_').replace(/\W/g, '') || 'archivo';

                            // If extension is not allowed (like .webp), force .jpg
                            if (!allowedExts.includes(ext)) {
                                ext = 'jpg';
                            }
                            fileName = `${base}.${ext}`;
                        }
                        fd.append(key, value, fileName);
                        console.log(`[WisphubService.updateTicket] 📎 ${key}:`, fileName);
                    } else {
                        fd.append(key, String(value));
                        if (key !== 'descripcion') { // Evitar loggear descripciones largas
                            console.log(`[WisphubService.updateTicket] 📝 ${key}:`, String(value));
                        }
                    }
                }
            });

            // Si se pasó un objeto plano y no FormData, lo convertimos.
            // La lógica anterior de "payload = data" fallaba si enviábamos JSON.

            console.log('[WisphubService.updateTicket] 🌐 Enviando request a:', `${BASE_URL}/tickets/${ticketId}/`);
            const response = await safeFetch(`${BASE_URL}/tickets/${ticketId}/`, {
                method: method,
                headers: {}, // Let browser set Content-Type with boundary for FormData
                body: fd
            });
            console.log('[WisphubService.updateTicket] 📡 Response status:', response.status, response.ok ? '✅' : '❌');

            if (!response.ok) {
                const errorText = await response.text();
                console.error('[WisphubService.updateTicket] ⚠️ Error body:', errorText);
            }

            return response.ok;
        } catch (e) {
            console.error('[WisphubService.updateTicket] 💥 Exception:', e);
            return false;
        }
    },



    async setTicketStartTime(ticketId: string | number): Promise<boolean> {
        // Formato esperado por WispHub: YYYY-MM-DD HH:MM:SS (Hora Colombia)
        const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
        const pad = (n: number) => n.toString().padStart(2, '0');
        const formattedDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        const timestamp = `${pad(d.getHours())}:${pad(d.getMinutes())}`;

        try {
            // 1. Obtener ticket actual para no perder descripción
            const rawTicket = await this.getTicketRaw(ticketId);
            const currentDesc = stripHtml(rawTicket?.descripcion || ".");

            const { data: { user } } = await safeGetUser();
            const techName = user?.user_metadata?.full_name || 'Técnico';

            const startMessage = `==== INICIO DE TRABAJO | ${techName.toUpperCase()} a las ${timestamp} ====`;
            const updatedDesc = `${currentDesc}\n\n${startMessage}`.trim();

            // 2. Marcar fecha_inicio y actualizar descripción en WispHub
            const ok = await this.updateTicket(ticketId, {
                fecha_inicio: formattedDate,
                descripcion: updatedDesc
            });

            return ok;
        } catch (error) {
            console.error('[WispHub] Error en setTicketStartTime:', error);
            return false;
        }
    },

    async sendArrivalComment(ticketId: string | number): Promise<boolean> {
        const now = new Date();
        const timestamp = now.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        let supabaseOk = false;
        let updateOk = false;

        console.log(`[WispHub] Registrando llegada para ticket ${ticketId}...`);

        // 1. Guardar en Supabase (Audit Log)
        try {
            const { data: { user } } = await safeGetUser();

            await supabase.from('ticket_events').insert({
                ticket_id: String(ticketId),
                event_type: 'arrival',
                technician_id: user?.id,
                created_at: now.toISOString(),
                metadata: { timestamp_display: timestamp }
            });
            supabaseOk = true;
        } catch (e) {
            console.error('[WispHub] Error en Supabase (arrival):', e);
        }

        // 2. Actualizar DESCRIPCIÓN en WispHub (Substitución de burbuja)
        try {
            const rawTicket = await this.getTicketRaw(ticketId);
            const currentDesc = stripHtml(rawTicket?.descripcion || ".");

            const bubbleMessage = `==== LLEGADA AL DESTINO | Ticket ${ticketId} a las ${timestamp} ====`;
            const updatedDesc = `${currentDesc}\n\n${bubbleMessage}`.trim();

            updateOk = await this.updateTicket(ticketId, { descripcion: updatedDesc });
            if (updateOk) console.log(`[WispHub] ✅ Descripción actualizada con mensaje de llegada.`);
        } catch (e) {
            console.error('[WispHub] Error en actualización de llegada:', e);
        }

        return supabaseOk || updateOk;
    },

    /**
     * Obtiene los eventos de llegada registrados en Supabase para un ticket.
     */
    async getArrivalEvents(ticketId: string | number): Promise<any[]> {
        try {
            const { supabase } = await import('./supabase');
            const { data, error } = await supabase
                .from('ticket_events')
                .select('*')
                .eq('ticket_id', String(ticketId))
                .eq('event_type', 'arrival')
                .order('created_at', { ascending: false });

            if (error) throw error;
            return data || [];
        } catch (error) {
            console.error('[Supabase] Error al obtener eventos de llegada:', error);
            return [];
        }
    },

    async updateClientComments(serviceId: number, newComment: string): Promise<boolean> {
        try {
            const client = await this.getServiceDetail(serviceId);
            const currentComments = client?.comentarios || '';
            const timestamp = new Date().toLocaleString('es-CO', { hour12: false, timeZone: 'America/Bogota' });
            const updatedComments = `${currentComments}\n[${timestamp}]: ${newComment}`.trim();
            return this.updateClient(serviceId, { comentarios: updatedComments });
        } catch (error) {
            return false;
        }
    },

    async updateClient(serviceId: number | string, data: any): Promise<boolean> {
        try {
            const response = await safeFetch(`${BASE_URL}/clientes/${serviceId}/`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });
            return response.ok;
        } catch (e) {
            console.error('[WispHub] Error updating client:', e);
            return false;
        }
    },

    async createTicket(ticketData: {
        servicio: number;
        asunto: string;
        descripcion: string;
        prioridad: number;
        technicianId?: string;
        file?: File | Blob;
    }): Promise<any> {
        try {
            // 1. Resolver ID numérico del técnico (WispHub lo exige en POST/PUT)
            let finalTechId: string | number = ticketData.technicianId || 'admin@rapilink-sas';

            try {
                const staff = await this.getStaff();
                const found = staff.find(s =>
                    s.usuario === ticketData.technicianId ||
                    s.email === ticketData.technicianId ||
                    s.id === ticketData.technicianId
                );
                if (found && found.id) {
                    finalTechId = found.id;
                }
            } catch (staffErr) {
                console.warn("[WispHub] No se pudo resolver ID numérico, usando fallback:", staffErr);
            }

            // 2. Safe Subject Logic (WispHub is strict with catalogs)
            const staffSubjects = await this.getTicketSubjects();
            const originalSubject = ticketData.asunto;
            const isAsuntoValid = staffSubjects.some(s => s.toLowerCase() === originalSubject.toLowerCase());
            const safeSubject = isAsuntoValid ? originalSubject : (staffSubjects[0] || "Internet Lento");

            const payload: any = {
                servicio: ticketData.servicio,
                asunto: `CRM - Report - ${originalSubject}`,
                asuntos_default: safeSubject,
                descripcion: ticketData.descripcion,
                prioridad: ticketData.prioridad.toString(),
                estado: '1',
                tecnico: finalTechId,
                departamento: 'Soporte Técnico',
                departamentos_default: 'Soporte Técnico'
            };

            if (ticketData.file) {
                payload.archivo_ticket = ticketData.file;
            }

            console.log("[WispHub REQUEST] Create Ticket Payload:", { ...payload, archivo_ticket: payload.archivo_ticket ? 'File attached' : 'No file' });

            const hasFile = !!ticketData.file;
            const response = await safeFetch(`${BASE_URL}/tickets/`, {
                method: 'POST',
                headers: hasFile ? {} : { 'Content-Type': 'application/json' },
                body: hasFile ? (() => {
                    const fd = new FormData();
                    Object.keys(payload).forEach(k => {
                        if (payload[k] !== undefined && payload[k] !== null) {
                            fd.append(k, payload[k]);
                        }
                    });
                    return fd;
                })() : JSON.stringify(payload)
            });

            if (response.ok) {
                return { success: true };
            } else {
                const errorText = await response.text();
                console.error("[WispHub API ERROR Response]", errorText);
                return { success: false, message: errorText };
            }
        } catch (error: any) {
            return { success: false, message: error.message };
        }
    },

    async getAllRecentTickets(limit: number = 1000, daysBack: number = 60): Promise<any[]> {
        try {
            const pastDate = new Date();
            pastDate.setDate(pastDate.getDate() - daysBack);
            const start = pastDate.toISOString().split('T')[0];
            const end = new Date().toISOString().split('T')[0];
            const url = `${BASE_URL}/tickets/?limit=${limit}&ordering=-id&fecha_creacion_0=${start}&fecha_creacion_1=${end}`;
            const response = await safeFetch(url);
            if (!response.ok) return [];
            const data = await response.json();
            return (data.results || []).map((t: any) => this.mapTicket(t));
        } catch (error) {
            return [];
        }
    },

    async getMyTickets(limit: number = 100, daysBack: number = 0, tecnico?: string): Promise<any[]> {
        try {
            let dateParams = '';
            if (daysBack > 0) {
                const pastDate = new Date();
                pastDate.setDate(pastDate.getDate() - daysBack);
                const start = pastDate.toISOString().split('T')[0];
                const end = new Date().toISOString().split('T')[0];
                dateParams = `&fecha_creacion_0=${start}&fecha_creacion_1=${end}`;
            }
            const tecnicoParam = tecnico ? `&tecnico=${encodeURIComponent(tecnico)}` : '&mis_tickets=true';
            const url = `${BASE_URL}/tickets/?limit=${limit}&ordering=-id${tecnicoParam}${dateParams}`;
            const response = await safeFetch(url);
            if (!response.ok) return [];
            const data = await response.json();
            return (data.results || []).map((t: any) => this.mapTicket(t));
        } catch (error) {
            return [];
        }
    },

    async getTicketsByTechnician(technicianId: number | string, page: number = 1): Promise<any[]> {
        try {
            const limit = 100;
            const offset = (page - 1) * limit;
            const url = `${BASE_URL}/tickets/?tecnico=${technicianId}&limit=${limit}&offset=${offset}&ordering=-id`;
            const response = await safeFetch(url);
            if (!response.ok) return [];
            const data = await response.json();
            return (data.results || []).map((t: any) => this.mapTicket(t));
        } catch (error) {
            return [];
        }
    },

    async getAllTicketsPage(page: number = 1, filters?: { startDate?: string; endDate?: string; tecnico?: string | number; status?: string | number }): Promise<{ results: any[], count: number }> {
        try {
            const limit = 50;
            const offset = (page - 1) * limit;
            let url = `${BASE_URL}/tickets/?limit=${limit}&offset=${offset}&ordering=-id`;

            if (filters?.startDate && filters?.endDate) {
                url += `&fecha_creacion_0=${filters.startDate}&fecha_creacion_1=${filters.endDate}`;
            }
            if (filters?.tecnico) {
                url += `&tecnico=${filters.tecnico}`;
            }
            if (filters?.status) {
                url += `&id_estado=${filters.status}`;
            }

            const response = await safeFetch(url);
            if (!response.ok) {
                throw new Error(`WispHub API Error: ${response.status}`);
            }
            const data = await response.json();
            return { results: (data.results || []).map((t: any) => this.mapTicket(t)), count: data.count || 0 };
        } catch (error) {
            console.error('[WispHub] Error in getAllTicketsPage:', error);
            throw error;
        }
    },

    async getAllTicketsPaginated(maxPages: number = 30, daysBack: number = 60): Promise<any[]> {
        // ... (existing implementation)
        const allTickets: any[] = [];
        let dateParams = '';
        if (daysBack > 0) {
            const pastDate = new Date();
            pastDate.setDate(pastDate.getDate() - daysBack);
            const start = pastDate.toISOString().split('T')[0];
            const end = new Date().toISOString().split('T')[0];
            dateParams = `&fecha_creacion_0=${start}&fecha_creacion_1=${end}`;
        }

        let nextUrl: string | null = `${BASE_URL}/tickets/?limit=100&ordering=-id${dateParams}`;
        let pages = 0;

        try {
            while (nextUrl && pages < maxPages) {
                const response = await safeFetch(nextUrl);
                if (!response.ok) break;
                const data = await response.json();
                allTickets.push(...(data.results || []).map((t: any) => this.mapTicket(t)));
                nextUrl = toProxyUrl(data.next);
                pages++;
            }
            return allTickets;
        } catch (e) {
            return allTickets;
        }
    },

    async uploadClientEvidence(clientId: string | number, file: Blob, descripcion: string): Promise<boolean> {
        try {
            const formData = new FormData();
            formData.append('id_servicio', String(clientId));
            formData.append('archivo', file, `${descripcion.replace(/\s+/g, '_')}.jpg`);
            formData.append('descripcion', descripcion);

            console.log(`[WispHub] Uploading evidence: ${descripcion} for client ${clientId}`);

            // INTENTO 1: Endpoint de adjuntos/archivos (Probaremos rutas estándar)
            // Ruta A: /clientes/archivos/ (General)
            const response = await safeFetch(`${BASE_URL}/clientes/archivos/`, {
                method: 'POST',
                body: formData
            });

            if (response.ok) return true;

            // INTENTO 2: Ruta B: /clientes/{id}/adjuntos/ (Específica)
            const response2 = await safeFetch(`${BASE_URL}/clientes/${clientId}/adjuntos/`, {
                method: 'POST',
                body: formData
            });

            return response2.ok;
        } catch (e) {
            console.error('[WispHub] Error uploading evidence:', e);
            return false;
        }
    }
};
