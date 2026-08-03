/**
 * mttoService — Capa de acceso a datos del módulo de Mantenimiento
 * Vehicular. Sigue la misma convención que workflowService.ts /
 * orgService.ts: un objeto con funciones async que llaman a Supabase
 * directamente y devuelven datos tipados (o lanzan en caso de error).
 *
 * La máquina de estados (borrador → ... → cerrada) SOLO se toca a
 * través de las funciones RPC (enviarARevision, revisarOrden, etc.).
 * Nunca hacer un UPDATE directo sobre mtto_orden.estado desde aquí.
 */
import { supabase } from './supabase';
import { compressImage, type ImageMetadata } from './imageUtils';
import type {
    Database,
    MttoDecision,
    MttoEstadoHallazgo,
    MttoTipoVehiculo,
} from '../types/database';

type Tables = Database['public']['Tables'];

export type MttoUsuarioRol = Tables['mtto_usuario_rol']['Row'];
export type MttoVehiculo = Tables['mtto_vehiculo']['Row'];
export type MttoChecklistSeccion = Tables['mtto_checklist_seccion']['Row'];
export type MttoChecklistItem = Tables['mtto_checklist_item']['Row'];
export type MttoCatalogoSistema = Tables['mtto_catalogo_sistema']['Row'];
export type MttoCatalogoArreglo = Tables['mtto_catalogo_arreglo']['Row'];
export type MttoOrden = Tables['mtto_orden']['Row'];
export type MttoOrdenHallazgo = Tables['mtto_orden_hallazgo']['Row'];
export type MttoOrdenFoto = Tables['mtto_orden_foto']['Row'];
export type MttoOrdenReparacion = Tables['mtto_orden_reparacion']['Row'];
export type MttoOrdenEvento = Tables['mtto_orden_evento']['Row'];
export type MttoOrdenTotal = Database['public']['Views']['mtto_v_orden_total']['Row'];
export type MttoOrdenResumen = Database['public']['Views']['mtto_v_orden_resumen']['Row'];
export type MttoCostoVehiculo = Database['public']['Views']['mtto_v_costo_vehiculo']['Row'];

export type ChecklistSeccionConItems = MttoChecklistSeccion & { items: MttoChecklistItem[] };
export type CatalogoSistemaConArreglos = MttoCatalogoSistema & { arreglos: MttoCatalogoArreglo[] };

// El bucket es privado; 'path' guarda la ruta DENTRO del bucket
// (sin el prefijo del bucket), ej: {orden_id}/{hallazgo_id}/{uuid}.jpg
const BUCKET = 'mtto-fotos';

function ensure<T>(data: T | null, error: { message: string } | null): T {
    if (error) throw new Error(error.message);
    if (data === null || data === undefined) throw new Error('Supabase no devolvió datos');
    return data;
}

export const MttoService = {
    // ================================================================
    // ROLES
    // ================================================================
    async getMiRol(): Promise<MttoUsuarioRol | null> {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return null;
        const { data, error } = await supabase
            .from('mtto_usuario_rol')
            .select('*')
            .eq('usuario_id', user.id)
            .maybeSingle();
        if (error) throw new Error(error.message);
        return data;
    },

    /**
     * Contexto de rol para gating de UI (mismo criterio que
     * mtto_es_admin_modulo()/mtto_tiene_rol() en Postgres: un
     * profiles.role='admin' ya es admin del módulo sin fila propia).
     */
    async getMiContexto(): Promise<{ userId: string | null; rol: MttoUsuarioRol['rol'] | null; esAdmin: boolean }> {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return { userId: null, rol: null, esAdmin: false };

        const [{ data: profile }, { data: usuarioRol }] = await Promise.all([
            supabase.from('profiles').select('role').eq('id', user.id).maybeSingle(),
            supabase.from('mtto_usuario_rol').select('*').eq('usuario_id', user.id).maybeSingle(),
        ]);

        const esAdminPlataforma = profile?.role === 'admin';
        const esAdminModulo = !!usuarioRol?.activo && usuarioRol.rol === 'admin';

        return {
            userId: user.id,
            rol: usuarioRol?.activo ? usuarioRol.rol : null,
            esAdmin: esAdminPlataforma || esAdminModulo,
        };
    },

    async listUsuariosRol(): Promise<(MttoUsuarioRol & { profile?: { full_name: string | null; email?: string | null } })[]> {
        const { data, error } = await supabase
            .from('mtto_usuario_rol')
            .select('*, profile:profiles(full_name, email)')
            .order('created_at', { ascending: false });
        return ensure(data as any, error);
    },

    async upsertUsuarioRol(usuarioId: string, rol: MttoUsuarioRol['rol'], extra?: Partial<Pick<MttoUsuarioRol, 'nombre' | 'documento' | 'cargo' | 'activo'>>) {
        const { data, error } = await supabase
            .from('mtto_usuario_rol')
            .upsert({ usuario_id: usuarioId, rol, ...extra }, { onConflict: 'usuario_id' })
            .select()
            .single();
        return ensure(data, error);
    },

    // ================================================================
    // VEHÍCULOS
    // ================================================================
    async listVehiculos(soloActivos = true): Promise<MttoVehiculo[]> {
        let query = supabase.from('mtto_vehiculo').select('*').order('codigo');
        if (soloActivos) query = query.eq('activo', true);
        const { data, error } = await query;
        return ensure(data, error);
    },

    async getVehiculo(id: string): Promise<MttoVehiculo | null> {
        const { data, error } = await supabase.from('mtto_vehiculo').select('*').eq('id', id).maybeSingle();
        if (error) throw new Error(error.message);
        return data;
    },

    async createVehiculo(payload: Tables['mtto_vehiculo']['Insert']): Promise<MttoVehiculo> {
        const { data, error } = await supabase.from('mtto_vehiculo').insert(payload).select().single();
        return ensure(data, error);
    },

    async updateVehiculo(id: string, payload: Tables['mtto_vehiculo']['Update']): Promise<MttoVehiculo> {
        const { data, error } = await supabase.from('mtto_vehiculo').update(payload).eq('id', id).select().single();
        return ensure(data, error);
    },

    /** Vehículos con SOAT o tecnomecánica venciendo en menos de `dias` días. */
    async listVencimientosProximos(dias = 30): Promise<MttoVehiculo[]> {
        const limite = new Date();
        limite.setDate(limite.getDate() + dias);
        const limiteStr = limite.toISOString().slice(0, 10);
        const { data, error } = await supabase
            .from('mtto_vehiculo')
            .select('*')
            .eq('activo', true)
            .or(`soat_vence.lte.${limiteStr},tecno_vence.lte.${limiteStr}`);
        return ensure(data, error);
    },

    // ================================================================
    // CHECKLIST (maestro global)
    // ================================================================
    async getChecklist(tipoVehiculo: MttoTipoVehiculo): Promise<ChecklistSeccionConItems[]> {
        const [{ data: secciones, error: errSec }, { data: items, error: errItems }] = await Promise.all([
            supabase.from('mtto_checklist_seccion').select('*').order('orden'),
            supabase.from('mtto_checklist_item').select('*').eq('activo', true).order('orden'),
        ]);
        if (errSec) throw new Error(errSec.message);
        if (errItems) throw new Error(errItems.message);

        const aplicaTipo = (aplica: MttoTipoVehiculo[] | null) => !aplica || aplica.includes(tipoVehiculo);

        return (secciones || [])
            .filter((s) => aplicaTipo(s.aplica))
            .map((s) => ({
                ...s,
                items: (items || []).filter((i) => i.seccion_id === s.id && aplicaTipo(i.aplica)),
            }));
    },

    // ================================================================
    // CATÁLOGO DE ARREGLOS (maestro global)
    // ================================================================
    async getCatalogo(): Promise<CatalogoSistemaConArreglos[]> {
        const [{ data: sistemas, error: errSis }, { data: arreglos, error: errArr }] = await Promise.all([
            supabase.from('mtto_catalogo_sistema').select('*').order('orden'),
            supabase.from('mtto_catalogo_arreglo').select('*').eq('activo', true).order('nombre'),
        ]);
        if (errSis) throw new Error(errSis.message);
        if (errArr) throw new Error(errArr.message);

        return (sistemas || []).map((s) => ({
            ...s,
            arreglos: (arreglos || []).filter((a) => a.sistema_id === s.id),
        }));
    },

    async updateArreglo(id: string, payload: Tables['mtto_catalogo_arreglo']['Update']): Promise<MttoCatalogoArreglo> {
        const { data, error } = await supabase.from('mtto_catalogo_arreglo').update(payload).eq('id', id).select().single();
        return ensure(data, error);
    },

    async crearArreglo(payload: Tables['mtto_catalogo_arreglo']['Insert']): Promise<MttoCatalogoArreglo> {
        const { data, error } = await supabase.from('mtto_catalogo_arreglo').insert(payload).select().single();
        return ensure(data, error);
    },

    async crearSistema(payload: Tables['mtto_catalogo_sistema']['Insert']): Promise<MttoCatalogoSistema> {
        const { data, error } = await supabase.from('mtto_catalogo_sistema').insert(payload).select().single();
        return ensure(data, error);
    },

    // ================================================================
    // ÓRDENES — bandeja y detalle
    // ================================================================
    async listOrdenes(filters?: { estado?: MttoOrden['estado'] | MttoOrden['estado'][]; vehiculoId?: string; desde?: string; hasta?: string }): Promise<(MttoOrden & { vehiculo?: MttoVehiculo })[]> {
        let query = supabase.from('mtto_orden').select('*, vehiculo:mtto_vehiculo(*)').order('created_at', { ascending: false });
        if (filters?.estado) {
            query = Array.isArray(filters.estado) ? query.in('estado', filters.estado) : query.eq('estado', filters.estado);
        }
        if (filters?.vehiculoId) query = query.eq('vehiculo_id', filters.vehiculoId);
        if (filters?.desde) query = query.gte('fecha', filters.desde);
        if (filters?.hasta) query = query.lte('fecha', filters.hasta);
        const { data, error } = await query;
        return ensure(data as any, error);
    },

    async getOrden(id: string): Promise<(MttoOrden & { vehiculo?: MttoVehiculo }) | null> {
        const { data, error } = await supabase.from('mtto_orden').select('*, vehiculo:mtto_vehiculo(*)').eq('id', id).maybeSingle();
        if (error) throw new Error(error.message);
        return data as any;
    },

    /** Crea la orden en borrador (paso 1: Vehículo). */
    async createOrden(payload: Tables['mtto_orden']['Insert']): Promise<MttoOrden> {
        const { data: { user } } = await supabase.auth.getUser();
        const { data, error } = await supabase
            .from('mtto_orden')
            .insert({ ...payload, creado_por: user?.id })
            .select()
            .single();
        return ensure(data, error);
    },

    /** Solo válido mientras la orden esté en borrador (RLS + trigger lo garantizan). */
    async updateOrden(id: string, payload: Tables['mtto_orden']['Update']): Promise<MttoOrden> {
        const { data, error } = await supabase.from('mtto_orden').update(payload).eq('id', id).select().single();
        return ensure(data, error);
    },

    // ================================================================
    // HALLAZGOS (llenado por excepción)
    // ================================================================
    async listHallazgos(ordenId: string): Promise<(MttoOrdenHallazgo & { fotos?: MttoOrdenFoto[] })[]> {
        const { data, error } = await supabase
            .from('mtto_orden_hallazgo')
            .select('*, fotos:mtto_orden_foto(*)')
            .eq('orden_id', ordenId);
        return ensure(data as any, error);
    },

    /** Marca un ítem en R/M/NA con su observación (upsert por orden+item). */
    async setHallazgo(ordenId: string, itemId: string, estado: MttoEstadoHallazgo, observacion: string): Promise<MttoOrdenHallazgo> {
        const { data, error } = await supabase
            .from('mtto_orden_hallazgo')
            .upsert({ orden_id: ordenId, item_id: itemId, estado, observacion }, { onConflict: 'orden_id,item_id' })
            .select()
            .single();
        return ensure(data, error);
    },

    /** Vuelve un ítem a "Bueno": como Bueno no se guarda, se borra la fila. */
    async marcarBueno(ordenId: string, itemId: string): Promise<void> {
        const { error } = await supabase
            .from('mtto_orden_hallazgo')
            .delete()
            .eq('orden_id', ordenId)
            .eq('item_id', itemId);
        if (error) throw new Error(error.message);
    },

    // ================================================================
    // FOTOS — Supabase Storage (bucket privado, subida directa)
    // ================================================================
    /**
     * Comprime (máx. 1600px, calidad 0.7 — señal de campo mala) y sube
     * la foto de un hallazgo, y registra la fila en mtto_orden_foto.
     */
    async subirFoto(ordenId: string, hallazgoId: string, file: File | Blob, metadata?: ImageMetadata): Promise<MttoOrdenFoto> {
        const comprimida = await compressImage(file, 1600, 0.7, metadata);
        const path = `${ordenId}/${hallazgoId}/${crypto.randomUUID()}.jpg`;

        const { error: uploadError } = await supabase.storage
            .from(BUCKET)
            .upload(path, comprimida, { contentType: 'image/jpeg' });
        if (uploadError) throw new Error(uploadError.message);

        const { data: { user } } = await supabase.auth.getUser();
        const { data, error } = await supabase
            .from('mtto_orden_foto')
            .insert({
                hallazgo_id: hallazgoId,
                path,
                mime: 'image/jpeg',
                bytes: comprimida.size,
                subido_por: user?.id,
            })
            .select()
            .single();

        if (error) {
            // Revertir el archivo subido si el registro en BD falla
            await supabase.storage.from(BUCKET).remove([path]);
            throw new Error(error.message);
        }
        return data;
    },

    async listFotos(hallazgoId: string): Promise<MttoOrdenFoto[]> {
        const { data, error } = await supabase.from('mtto_orden_foto').select('*').eq('hallazgo_id', hallazgoId);
        return ensure(data, error);
    },

    /** URL firmada temporal para mostrar/descargar una foto del bucket privado. */
    async getFotoUrl(path: string, expiresInSeconds = 3600): Promise<string> {
        const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, expiresInSeconds);
        if (error) throw new Error(error.message);
        return data.signedUrl;
    },

    async eliminarFoto(fotoId: string, path: string): Promise<void> {
        const { error: storageError } = await supabase.storage.from(BUCKET).remove([path]);
        if (storageError) throw new Error(storageError.message);
        const { error } = await supabase.from('mtto_orden_foto').delete().eq('id', fotoId);
        if (error) throw new Error(error.message);
    },

    // ================================================================
    // REPARACIONES (cotización)
    // ================================================================
    async listReparaciones(ordenId: string): Promise<MttoOrdenReparacion[]> {
        const { data, error } = await supabase.from('mtto_orden_reparacion').select('*').eq('orden_id', ordenId).order('created_at');
        return ensure(data, error);
    },

    async crearReparacion(payload: Tables['mtto_orden_reparacion']['Insert']): Promise<MttoOrdenReparacion> {
        const { data, error } = await supabase.from('mtto_orden_reparacion').insert(payload).select().single();
        return ensure(data, error);
    },

    async actualizarReparacion(id: string, payload: Tables['mtto_orden_reparacion']['Update']): Promise<MttoOrdenReparacion> {
        const { data, error } = await supabase.from('mtto_orden_reparacion').update(payload).eq('id', id).select().single();
        return ensure(data, error);
    },

    async eliminarReparacion(id: string): Promise<void> {
        const { error } = await supabase.from('mtto_orden_reparacion').delete().eq('id', id);
        if (error) throw new Error(error.message);
    },

    /**
     * Botón "Traer hallazgos en M": crea una línea de cotización por
     * cada ítem en Malo que todavía no tenga una reparación asociada.
     */
    async crearReparacionesDesdeMalos(ordenId: string): Promise<MttoOrdenReparacion[]> {
        const { data: hallazgosMalos, error: errH } = await supabase
            .from('mtto_orden_hallazgo')
            .select('id, item_id, mtto_checklist_item(nombre)')
            .eq('orden_id', ordenId)
            .eq('estado', 'M');
        if (errH) throw new Error(errH.message);

        const { data: yaCotizadas, error: errR } = await supabase
            .from('mtto_orden_reparacion')
            .select('hallazgo_id')
            .eq('orden_id', ordenId);
        if (errR) throw new Error(errR.message);

        const cotizadosSet = new Set((yaCotizadas || []).map((r) => r.hallazgo_id));
        const pendientes = (hallazgosMalos || []).filter((h) => !cotizadosSet.has(h.id));
        if (pendientes.length === 0) return [];

        const inserts = pendientes.map((h) => ({
            orden_id: ordenId,
            hallazgo_id: h.id,
            descripcion: (h as any).mtto_checklist_item?.nombre || 'Reparación pendiente de describir',
            cantidad: 1,
            valor_unitario: 0,
            mano_obra: 0,
            prioridad: 'media' as const,
        }));

        const { data, error } = await supabase.from('mtto_orden_reparacion').insert(inserts).select();
        return ensure(data, error);
    },

    // ================================================================
    // VISTAS
    // ================================================================
    async getTotales(ordenId: string): Promise<MttoOrdenTotal | null> {
        const { data, error } = await supabase.from('mtto_v_orden_total').select('*').eq('orden_id', ordenId).maybeSingle();
        if (error) throw new Error(error.message);
        return data;
    },

    async getResumen(ordenId: string): Promise<MttoOrdenResumen | null> {
        const { data, error } = await supabase.from('mtto_v_orden_resumen').select('*').eq('orden_id', ordenId).maybeSingle();
        if (error) throw new Error(error.message);
        return data;
    },

    async listResumenes(ordenIds: string[]): Promise<MttoOrdenResumen[]> {
        if (ordenIds.length === 0) return [];
        const { data, error } = await supabase.from('mtto_v_orden_resumen').select('*').in('orden_id', ordenIds);
        return ensure(data, error);
    },

    async getCostosPorVehiculo(vehiculoId?: string): Promise<MttoCostoVehiculo[]> {
        let query = supabase.from('mtto_v_costo_vehiculo').select('*').order('mes', { ascending: false });
        if (vehiculoId) query = query.eq('vehiculo_id', vehiculoId);
        const { data, error } = await query;
        return ensure(data, error);
    },

    /** Reparaciones autorizadas más frecuentes de un vehículo (para detectar recurrencias). */
    async getReparacionesFrecuentes(vehiculoId: string): Promise<{ descripcion: string; veces: number }[]> {
        const { data: ordenes, error: errO } = await supabase.from('mtto_orden').select('id').eq('vehiculo_id', vehiculoId);
        if (errO) throw new Error(errO.message);
        const ordenIds = (ordenes || []).map((o) => o.id);
        if (ordenIds.length === 0) return [];

        const { data, error } = await supabase
            .from('mtto_orden_reparacion')
            .select('descripcion')
            .in('orden_id', ordenIds)
            .eq('autorizado', true);
        if (error) throw new Error(error.message);

        const conteo = new Map<string, number>();
        for (const r of data || []) conteo.set(r.descripcion, (conteo.get(r.descripcion) || 0) + 1);
        return Array.from(conteo.entries())
            .map(([descripcion, veces]) => ({ descripcion, veces }))
            .filter((r) => r.veces > 1)
            .sort((a, b) => b.veces - a.veces);
    },

    // ================================================================
    // TRAZABILIDAD
    // ================================================================
    async listEventos(ordenId: string): Promise<(MttoOrdenEvento & { usuario?: { full_name: string | null } })[]> {
        const { data, error } = await supabase
            .from('mtto_orden_evento')
            .select('*, usuario:profiles(full_name)')
            .eq('orden_id', ordenId)
            .order('created_at');
        return ensure(data as any, error);
    },

    // ================================================================
    // MÁQUINA DE ESTADOS — solo vía RPC (SECURITY DEFINER en Postgres)
    // ================================================================
    async enviarARevision(ordenId: string): Promise<void> {
        const { error } = await supabase.rpc('mtto_enviar_a_revision', { p_orden_id: ordenId });
        if (error) throw new Error(error.message);
    },

    async revisarOrden(ordenId: string, obs: string): Promise<void> {
        const { error } = await supabase.rpc('mtto_revisar_orden', { p_orden_id: ordenId, p_obs: obs });
        if (error) throw new Error(error.message);
    },

    async aprobarOrden(ordenId: string, decision: MttoDecision, obs: string, valorAprobado: number, lineasAutorizadas?: string[]): Promise<void> {
        const { error } = await supabase.rpc('mtto_aprobar_orden', {
            p_orden_id: ordenId,
            p_decision: decision,
            p_obs: obs,
            p_valor_aprobado: valorAprobado,
            p_lineas_autorizadas: lineasAutorizadas ?? null,
        });
        if (error) throw new Error(error.message);
    },

    async devolverOrden(ordenId: string, motivo: string): Promise<void> {
        const { error } = await supabase.rpc('mtto_devolver_orden', { p_orden_id: ordenId, p_motivo: motivo });
        if (error) throw new Error(error.message);
    },

    async iniciarEjecucion(ordenId: string): Promise<void> {
        const { error } = await supabase.rpc('mtto_iniciar_ejecucion', { p_orden_id: ordenId });
        if (error) throw new Error(error.message);
    },

    async cerrarOrden(ordenId: string, notas: string): Promise<void> {
        const { error } = await supabase.rpc('mtto_cerrar_orden', { p_orden_id: ordenId, p_notas: notas });
        if (error) throw new Error(error.message);
    },

    // ================================================================
    // FIRMA RÁPIDA POR PIN — para encargado/aprobador que revisan o
    // aprueban desde el teléfono de otra persona (ej. el mecánico),
    // sin loguearse con correo+clave. El PIN se verifica con bcrypt
    // en el servidor y sigue quedando ligado al usuario_id real de
    // quien firma (ver 20260803_mtto_5_pin.sql).
    // ================================================================

    /** Cada persona configura SU PROPIO PIN, logueada normalmente. */
    async configurarPin(pin: string): Promise<void> {
        const { error } = await supabase.rpc('mtto_configurar_pin', { p_pin: pin });
        if (error) throw new Error(error.message);
    },

    async revisarConPin(ordenId: string, usuarioId: string, pin: string, obs: string): Promise<void> {
        const { error } = await supabase.rpc('mtto_revisar_orden_pin', { p_orden_id: ordenId, p_usuario_id: usuarioId, p_pin: pin, p_obs: obs });
        if (error) throw new Error(error.message);
    },

    async aprobarConPin(ordenId: string, usuarioId: string, pin: string, decision: MttoDecision, obs: string, valorAprobado: number, lineasAutorizadas?: string[]): Promise<void> {
        const { error } = await supabase.rpc('mtto_aprobar_orden_pin', {
            p_orden_id: ordenId,
            p_usuario_id: usuarioId,
            p_pin: pin,
            p_decision: decision,
            p_obs: obs,
            p_valor_aprobado: valorAprobado,
            p_lineas_autorizadas: lineasAutorizadas ?? null,
        });
        if (error) throw new Error(error.message);
    },
};
