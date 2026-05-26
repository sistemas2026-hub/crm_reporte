import { supabase, safeGetUser } from './supabase';
import { WisphubService, stripHtml } from './wisphub';
import type { WorkflowProcess, WorkflowLog, ParticipantType, PlatformUser } from './types/workflow';

/**
 * Normaliza un texto para comparaciones (minúsculas, sin espacios extras)
 */
export const normalize = (text: string | null | undefined): string => {
    if (!text) return "";
    return text.toString()
        .toLowerCase()
        .trim()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Quitar acentos
        .replace(/[^a-z0-9\s]/g, "")   // Quitar puntuación redundante
        .replace(/\s+/g, " ");          // Colapsar espacios múltiples
};

// Helper to check for valid UUIDs
const isUUID = (str: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);

// Requisitos por tipo de ticket
export const REQUIREMENTS: Record<string, { minPhotos: number, requiresMaterials: boolean }> = {
    'INSTALACION': { minPhotos: 3, requiresMaterials: true },
    'REPARACION': { minPhotos: 2, requiresMaterials: false },
    'MANTENIMIENTO': { minPhotos: 2, requiresMaterials: true },
    'DEFAULT': { minPhotos: 1, requiresMaterials: false }
};

export interface CompleteOptions {
    files?: (File | Blob)[];
    statusId?: number;
    signal?: string;
}

export const WorkflowService = {
    /**
     * RADAR DE HOY (Sincronización de Segundo Plano Ligera)
     * Solo jala los tickets creados HOY para ver si hay algo nuevo.
     */
    async radarSyncToday(): Promise<void> {
        if ((window as any)._isRadarRunning) return;
        (window as any)._isRadarRunning = true;
        
        try {
            console.log('[Radar-Hoy] 📡 Escaneando WispHub por tickets capturados hoy...');
            const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD
            
            // Petición ultraligera: solo de hoy, todos los estados vivos
            const recentTickets = await WisphubService.getAllTickets({ 
                startDate: today, 
                endDate: today,
                status: '1,2,5' 
            });

            if (recentTickets.length > 0) {
                console.log(`[Radar-Hoy] 🎯 Detectados ${recentTickets.length} tickets activos hoy. Sincronizando con espejo local...`);
                // Mandamos a grabar/revalidar al espejo para que el WebSocket de Supabase dispare el UI
                await this.syncMirrorBatch(recentTickets);
            }
        } catch (e) {
            console.warn('[Radar-Hoy] Error en escaneo ligero:', e);
        } finally {
            (window as any)._isRadarRunning = false;
        }
    },

    /**
     * Sincronización en lote de tickets hacia el espejo local (Supabase)
     */
    async syncMirrorBatch(tickets: any[]): Promise<void> {
        if (!tickets || tickets.length === 0) return;

        // Traer metadata existente en una sola consulta para preservar campos CRM
        const refIds = tickets.map(t => String(t.id));
        const { data: existing } = await supabase
            .from('workflow_processes')
            .select('reference_id, metadata')
            .in('reference_id', refIds);
        const existingMap = new Map((existing || []).map((r: any) => [r.reference_id, r.metadata || {}]));

        // Construir todas las filas con metadata fusionada
        const rows = tickets.map(t => {
            const ref = String(t.id);
            const prevMeta = existingMap.get(ref) || {};
            const mergedMeta = { ...prevMeta, ...t };
            return {
                reference_id: ref,
                process_type: 'Ticket AXCES',
                title: t.asunto || `Ticket #${t.id}`,
                status: (t.id_estado === 3 || t.id_estado === 4) ? 'CO' : 'PE',
                metadata: mergedMeta,
                priority: t.prioridad === 'Alta' ? 3 : t.prioridad === 'Media' ? 2 : 1
            };
        });

        // Upsert masivo en lotes de 50 (una sola petición HTTP por lote en vez de N peticiones)
        const BATCH = 50;
        for (let i = 0; i < rows.length; i += BATCH) {
            const { error } = await supabase
                .from('workflow_processes')
                .upsert(rows.slice(i, i + BATCH), { onConflict: 'reference_id' });
            if (error) console.error(`[Radar] Error en upsert masivo lote ${i / BATCH + 1}:`, error);
        }
    },

    // --- PROCESOS ---
    async createProcess(data: {
        process_type: string;
        title: string;
        priority?: number;
        reference_id?: string;
        metadata?: any;
    }): Promise<WorkflowProcess | null> {
        const { data: process, error } = await supabase
            .from('workflow_processes')
            .insert([{
                process_type: data.process_type,
                title: data.title,
                priority: data.priority || 1,
                reference_id: data.reference_id,
                metadata: data.metadata || {},
                status: 'PE'
            }])
            .select()
            .single();

        if (error) {
            console.error('[WorkflowService] Error creando proceso:', error);
            return null;
        }

        await this.logEvent(process.id, 'Creation', `Proceso iniciado: ${data.title}`);
        return process;
    },

    async getProcessById(id: string): Promise<WorkflowProcess | null> {
        const { data, error } = await supabase
            .from('workflow_processes')
            .select('*')
            .eq('id', id)
            .single();
        return error ? null : data;
    },

    /**
     * Recupera los tickets sincronizados desde WispHub que residen en Supabase (Espejo)
     */
    async getOperationalTicketsMirror(): Promise<any[]> {
        const { data, error } = await supabase
            .from('workflow_processes')
            .select('metadata')
            .eq('process_type', 'Ticket AXCES')
            .eq('status', 'PE')
            .order('updated_at', { ascending: false })
            .limit(2500);

        if (error) {
            if (error.message?.includes('aborted') || (error as any).name === 'AbortError') {
                console.warn('[WorkflowService] ⚠️ Petición de tickets espejo abortada');
            } else {
                console.error('[WorkflowService] Error recuperando tickets espejo:', error);
            }
            return [];
        }

        return (data || []).map(row => WisphubService.mapTicket(row.metadata));
    },

    /**
     * Sincronización Stale-While-Revalidate ("El Detective")
     * Purga en Supabase los tickets que en WispHub cambiaron de estado o de técnico sin notificar.
     */
    async silentDetectiveSync(options: { force?: boolean } = {}): Promise<void> {
        if (!options.force && (window as any)._isDetectiveRunning) {
            console.log('[Detective] ⏳ Ya hay una sincronización en curso. Esperando...');
            return;
        }
        (window as any)._isDetectiveRunning = true;

        try {
            console.log('[Detective] 🕵️‍♂️ Iniciando purga/sincronización silenciosa de desajustes...');

            // 1. Obtener todos los abiertos en Supabase (solo los activos para no procesar 8000 filas)
            // FIXED: Tomamos TODOS los 'PE' porque si la metadata está corrupta se quedan atorados "en el aire"
            const { data: localOpenItems } = await supabase
                .from('workflow_processes')
                .select('id, metadata')
                .eq('process_type', 'Ticket AXCES')
                .eq('status', 'PE');

            if (!localOpenItems || localOpenItems.length === 0) {
                console.log('[Detective] No hay tickets abiertos localmente. Nada que purgar.');
                return;
            }

            console.log(`[Detective] Evaluando ${localOpenItems.length} tickets locales abiertos...`);

            // 2. Obtener la fuente de verdad: Tickets Abiertos Reales de WispHub (Últimos 60 días)
            // Ya es secuencial por dentro de getAllTickets
            const openInWispHub = await WisphubService.getAllTickets({ status: '1,2,5' });

            // SEGURIDAD NACIONAL: Si WispHub devolvió 0 tickets o la red falló, 
            // no podemos asumir que los tickets locales son fantasma. Ocurrió un error en la API.
            if (!openInWispHub || openInWispHub.length === 0) {
                console.warn('[Detective] ⚠️ WispHub retornó 0 tickets abiertos. Esto es matemáticamente improbable en producción o indica fallo de API (Error 500, Rate Limit). ABORTANDO purga de Supabase para no borrar datos valiosos!');
                return;
            }

            // Crear mapa para búsqueda O(1)
            const whTruthMap = new Map();
            openInWispHub.forEach(t => whTruthMap.set(String(t.id), t));

            let purges = 0;
            let fixes = 0;

            // Acumular cambios para aplicarlos en batch
            const purgedMetas: any[] = [];
            const toFix: Array<{ id: string; metadata: any }> = [];
            const toPurge: string[] = [];

            // 3. Evaluar discrepancias
            for (const local of localOpenItems) {
                const localId = String(local.metadata.id);
                const localTech = local.metadata.tecnico_usuario || '';
                const truthTicket = whTruthMap.get(localId);

                // CASO A: El ticket ya NO ESTÁ ABIERTO en WispHub
                if (!truthTicket) {
                    purges++;
                    toPurge.push(local.id);
                    // FIXED: El status válido en la BD de Supabase es 'CO' (Closed), no la palabra 'Completed'
                    purgedMetas.push({ id: local.id, metadata: { ...local.metadata, id_estado: 4, nombre_estado: 'Cerrado/Purgado por Detective' }, status: 'CO' });
                    continue;
                }

                // CASO B: El ticket SIGUE ABIERTO, pero le cambiaron el Técnico en WispHub
                const truthTech = truthTicket.tecnico_usuario || '';
                if (localTech !== truthTech) {
                    fixes++;
                    toFix.push({ id: local.id, metadata: { ...local.metadata, tecnico_usuario: truthTech, nombre_tecnico: truthTicket.nombre_tecnico } });
                }
            }

            // 6. Aplicar cambios en Batch Controlado (Evita colapsar el navegador con miles de PATCH)
            const CHUNK_SIZE = 15;

            // Purga de tickets cerrados
            if (purgedMetas.length > 0) {
                console.log(`[Detective] 🧹 Purgando ${purgedMetas.length} tickets en lotes de ${CHUNK_SIZE}...`);
                for (let i = 0; i < purgedMetas.length; i += CHUNK_SIZE) {
                    const chunk = purgedMetas.slice(i, i + CHUNK_SIZE);
                    await Promise.all(chunk.map((item: any) =>
                        supabase.from('workflow_processes')
                            .update({ metadata: item.metadata, status: item.status })
                            .eq('id', item.id)
                    ));
                    if (purgedMetas.length > 100 && i % (CHUNK_SIZE * 5) === 0) {
                        console.log(`[Detective] Progreso purga: ${i}/${purgedMetas.length}...`);
                    }
                }
            }

            // Corrección de técnicos o metadatos
            if (toFix.length > 0) {
                console.log(`[Detective] 🛠 Corrigiendo ${toFix.length} tickets en lotes de ${CHUNK_SIZE}...`);
                for (let i = 0; i < toFix.length; i += CHUNK_SIZE) {
                    const chunk = toFix.slice(i, i + CHUNK_SIZE);
                    await Promise.all(chunk.map(item =>
                        supabase.from('workflow_processes')
                            .update({ metadata: item.metadata })
                            .eq('id', item.id)
                    ));
                }
            }

            if (purges > 0 || fixes > 0) {
                console.log(`[Detective] 🕵️‍♂️ Sincronización Completada: ${purges} marcados cerrados, ${fixes} reasignados.`);
            } else {
                console.log('[Detective] Todo en orden. No hay desincronización.');
            }

        } catch (e) {
            console.error('[Detective] Error al intentar reparar discrepancias:', e);
        } finally {
            (window as any)._isDetectiveRunning = false;
        }
    },

    // --- ACTIVIDADES Y WORKITEMS ---
    async createStep(processId: string, name: string, participantId: string, type: ParticipantType, durationMinutes: number = 60) {
        // 1. Crear Actividad
        const { data: activity, error: actErr } = await supabase
            .from('workflow_activities')
            .insert([{ process_id: processId, name, status: 'Active' }])
            .select()
            .single();

        if (actErr) return null;

        // 2. Crear WorkItem con Deadline
        const deadline = new Date();
        deadline.setMinutes(deadline.getMinutes() + durationMinutes);

        const { data: workItem, error: wiErr } = await supabase
            .from('workflow_workitems')
            .insert([{
                activity_id: activity.id,
                participant_id: participantId,
                participant_type: type,
                deadline: deadline.toISOString(),
                status: 'Pending'
            }])
            .select()
            .single();

        return wiErr ? null : { activity, workItem };
    },

    async completeWorkItem(workItemId: string, actorId: string, note?: string) {
        const now = new Date().toISOString();

        // 1. Marcar WorkItem como completado
        const { data: wi, error: wiErr } = await supabase
            .from('workflow_workitems')
            .update({ status: 'Completed', completed_at: now })
            .eq('id', workItemId)
            .select()
            .single();

        if (wiErr) return false;

        // 2. Marcar Actividad como completada
        await supabase
            .from('workflow_activities')
            .update({ status: 'Completed', completed_at: now })
            .eq('id', wi.activity_id);

        // 3. Log
        const { data: activity } = await supabase.from('workflow_activities').select('process_id').eq('id', wi.activity_id).single();
        if (activity) {
            await this.logEvent(activity.process_id, 'Approval', note || `Tarea completada por ${actorId}`);
        }

        return true;
    },

    async reassignWorkItem(workItemId: string, newParticipantId: string, actorId: string) {
        const { data, error } = await supabase
            .from('workflow_workitems')
            .update({ participant_id: newParticipantId })
            .eq('id', workItemId)
            .select('activity_id, workflow_activities(process_id, workflow_processes(reference_id))')
            .single();

        if (error) {
            console.error('[INTERNAL] Error en reassignWorkItem:', error);
            return false;
        }

        const processId = (data.workflow_activities as any)?.process_id;
        const ticketId = (data.workflow_activities as any)?.workflow_processes?.reference_id;

        if (processId) {
            await this.logEvent(processId, 'Reassignment', `Reasignado a: ${newParticipantId}`, actorId);
        }

        // SINCRONIZACIÓN WispHub
        if (ticketId && isUUID(newParticipantId)) {
            console.log(`[WispHub] Sincronizando reasignación manual para ticket ${ticketId}`);
            await this.changeWispHubTechnician(ticketId, newParticipantId);
        }

        return true;
    },

    /**
     * Reasigna un ticket que ya está publicado buscando su workitem activo.
     */
    async reassignPublishedTicket(ticketId: string, newParticipantId: string) {
        try {
            // 1. Encontrar el workitem activo para este ticket (reference_id)
            const { data: item, error } = await supabase
                .from('workflow_workitems')
                .select(`
                    id, 
                    activity_id,
                    workflow_activities!inner(
                        id,
                        workflow_processes!inner(id, reference_id)
                    )
                `)
                .eq('workflow_activities.workflow_processes.reference_id', String(ticketId))
                .eq('status', 'PE')
                .order('created_at', { ascending: false })
                .maybeSingle();

            if (error || !item) {
                console.error('[WorkflowService] No se encontró workitem activo para reasignar:', ticketId, error);

                // FALLBACK: Si no hay workitem PE, intentamos ver si existe el proceso y crear uno nuevo para el técnico
                const { data: process } = await supabase
                    .from('workflow_processes')
                    .select('id')
                    .eq('reference_id', String(ticketId))
                    .maybeSingle();

                if (process) {
                    console.log('[WorkflowService] Proceso encontrado, creando nuevo paso de gestión para reasignación.');
                    const result = await this.createStep(process.id, 'Gestión de Ticket', newParticipantId, 'U');
                    if (result) {
                        await this.changeWispHubTechnician(ticketId, newParticipantId);
                        return true;
                    }
                }
                return false;
            }

            // 2. Usar la lógica de reasignación existente
            const { data: { user } } = await safeGetUser();
            return await this.reassignWorkItem(item.id, newParticipantId, user?.id || 'system');
        } catch (e) {
            console.error('[WorkflowService] Error en reassignPublishedTicket:', e);
            return false;
        }
    },

    /**
     * Obtiene los tickets ya asignados hoy para poblar la vista de despacho.
     */
    async getTodayAssignments() {
        try {
            const today = new Date().toISOString().split('T')[0];
            const { data, error } = await supabase
                .from('workflow_workitems')
                .select(`
                    participant_id,
                    workflow_activities!inner(
                        workflow_processes!inner(reference_id, metadata, status)
                    )
                `)
                .eq('status', 'PE')
                .gte('created_at', today);

            if (error) throw error;

            const assignments: Record<string, any[]> = {};
            data.forEach(item => {
                const techId = item.participant_id;
                const ticket = (item.workflow_activities as any).workflow_processes.metadata;
                // Asegurarnos que el ID coincida con el reference_id por si la metadata está vieja
                ticket.id = (item.workflow_activities as any).workflow_processes.reference_id;

                if (!assignments[techId]) assignments[techId] = [];
                assignments[techId].push(ticket);
            });

            return assignments;
        } catch (e) {
            console.error('[WorkflowService] Error obteniendo asignaciones de hoy:', e);
            return {};
        }
    },

    async getPlatformUsers(): Promise<PlatformUser[]> {
        try {
            console.log('[getPlatformUsers] 🔍 Iniciando carga de perfiles...');

            // 1. Obtener perfiles reales con ID de WispHub
            const { data: profiles, error: profilesError } = await supabase
                .from('profiles')
                .select('id, full_name, email, role, wisphub_id, operational_level, is_field_tech, strategic_location');

            if (profilesError) {
                if (profilesError.message?.includes('aborted') || (profilesError as any).name === 'AbortError') {
                    console.warn('[getPlatformUsers] ⚠️ Petición abortada (probablemente por recarga de página)');
                } else {
                    console.error('[getPlatformUsers] ❌ Error obteniendo profiles:', profilesError);
                }
                return [];
            }

            if (!profiles || profiles.length === 0) {
                console.warn('[getPlatformUsers] ⚠️ No se encontraron perfiles en la base de datos');
                return [];
            }

            console.log(`[getPlatformUsers] ✅ ${profiles.length} perfiles cargados`);

            // 2. Obtener IDs técnicos de interacciones (Ghost Users)
            const { data: interactions } = await supabase.from('crm_interactions').select('user_id');
            const uniqueIds = Array.from(new Set((interactions || []).map(i => i.user_id)));

            const finalUsers = (profiles || []).map(p => ({
                id: p.id,
                full_name: p.full_name,
                display_name: p.full_name || p.email || `ID: ${p.id.substring(0, 8)}`,
                email: p.email,
                role: p.role,
                wisphub_id: p.wisphub_id,
                operational_level: p.operational_level,
                is_field_tech: p.is_field_tech,
                strategic_location: p.strategic_location
                    ? (String(p.strategic_location).toLowerCase().trim() as "campo" | "oficina")
                    : null,
                is_profile: true
            }));

            const profileIds = new Set(finalUsers.map(u => u.id));

            for (const item of uniqueIds) {
                const id = String(item);
                if (!profileIds.has(id)) {
                    finalUsers.push({
                        id,
                        full_name: `Técnico: ${id.substring(0, 8)}`,
                        display_name: `Técnico: ${id.substring(0, 8)}`,
                        email: null,
                        role: 'agente',
                        wisphub_id: id,
                        operational_level: null,
                        is_field_tech: false,
                        is_profile: false,
                        strategic_location: null,
                    });
                }
            }

            console.log(`[getPlatformUsers] 🎯 Total usuarios finales: ${finalUsers.length}`);
            console.log('[getPlatformUsers] 📊 Distribución por nivel:',
                finalUsers.reduce((acc, u) => {
                    const level = u.operational_level ?? 'null';
                    acc[level] = (acc[level] || 0) + 1;
                    return acc;
                }, {} as Record<string | number, number>)
            );

            return finalUsers;
        } catch (error) {
            console.error('[getPlatformUsers] 💥 Error crítico:', error);
            console.error('[getPlatformUsers] Stack:', error instanceof Error ? error.stack : 'No stack');
            // En caso de error crítico, retornar array vacío en lugar de fallar
            return [];
        }
    },

    async updateTicketStatus(ticketId: string, statusId: number, comment?: string, options: { file?: File | Blob } = {}) {
        console.log('[updateTicketStatus] 🚀 Iniciando cierre de ticket:', { ticketId, statusId, hasComment: !!comment, hasFile: !!options.file });
        try {
            // 1. Obtener Datos Actuales para PUT limpio
            const rawTicket = await WisphubService.getTicketRaw(ticketId);
            if (!rawTicket) {
                console.error('[updateTicketStatus] ❌ No se pudo obtener el ticket raw');
                return false;
            }
            console.log('[updateTicketStatus] ✅ Ticket raw obtenido:', { asunto: rawTicket.asunto, tecnico: rawTicket.tecnico, estado: rawTicket.estado });

            // 2. Mapeo de IDs (PUT Estricto sin tocar descripción)
            const priorityMap: Record<string, number> = { "Baja": 1, "Normal": 2, "Media": 2, "Alta": 3, "Muy Alta": 4 };
            const validSubjects = (WisphubService as any).TICKET_SUBJECTS || [];
            const currentAsunto = rawTicket.asunto || "Otro Asunto";
            const isAsuntoValid = validSubjects.some((s: string) => s.toLowerCase() === currentAsunto.toLowerCase());
            const safeAsunto = isAsuntoValid ? currentAsunto : (validSubjects[0] || "Otro Asunto");

            // 3. Resolver ID Numérico del Técnico Actual (requerido por WispHub)
            let finalTechId = rawTicket.tecnico_id;
            if (!finalTechId || isNaN(Number(finalTechId))) {
                try {
                    const staff = await WisphubService.getStaff();
                    const techName = rawTicket.tecnico || rawTicket.nombre_tecnico || '';
                    const foundInStaff = staff.find(s =>
                        normalize(s.nombre) === normalize(techName) ||
                        normalize(s.usuario) === normalize(techName) ||
                        s.email === techName
                    );
                    if (foundInStaff) {
                        finalTechId = foundInStaff.id;
                        console.log(`[updateTicketStatus] ✅ Técnico resuelto: "${techName}" -> ID: ${finalTechId}`);
                    } else {
                        console.warn(`[updateTicketStatus] ⚠️ No se encontró ID para técnico: "${techName}", usando ID por defecto`);
                        // Usar primer técnico disponible como fallback
                        finalTechId = staff[0]?.id || 1;
                    }
                } catch (e) {
                    console.error('[updateTicketStatus] Error resolviendo técnico, usando fallback:', e);
                    finalTechId = 1; // ID por defecto
                }
            }

            const { data: { user } } = await safeGetUser();
            let actorName = 'Sistema';
            if (user) {
                const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user.id).single();
                actorName = profile?.full_name || user.email || 'Sistema';
            }

            const timestamp = new Date().toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bogota' }).replace(',', '');
            const statusLabel = statusId === 3 ? "FINALIZADO" : "CERRADO";
            const commentText = comment || `Ticket ${statusLabel.toLowerCase()} por ${actorName}`;
            const responseMsg = `${commentText} | ${actorName.toUpperCase()} | ${timestamp}`;

            const prioridadNum = priorityMap[rawTicket.prioridad] || 2;

            // 5. PUT limpio — solo cambia estado + fecha_final, sin tocar descripción
            const payload: any = {
                servicio: rawTicket.servicio?.id_servicio || rawTicket.servicio?.id || rawTicket.servicio,
                asunto: currentAsunto,
                asuntos_default: safeAsunto,
                descripcion: stripHtml(rawTicket.descripcion || '.'),
                prioridad: prioridadNum,
                estado: statusId,
                tecnico: Number(finalTechId),
                departamento: rawTicket.departamento || "Soporte Técnico",
                departamentos_default: rawTicket.departamento || "Soporte Técnico"
            };

            if (statusId === 3) {
                const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
                const pad = (n: number) => n.toString().padStart(2, '0');
                payload.fecha_final = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
            }

            if (options.file) {
                payload.archivo_ticket = options.file;
            }

            console.log('[updateTicketStatus] 📦 Payload:', payload);
            const updateSuccess = await WisphubService.updateTicket(ticketId, payload, 'PUT');

            if (!updateSuccess) {
                console.error('[updateTicketStatus] ❌ Falló actualización de ticket');
                return false;
            }

            // 6. Respuesta en el hilo del ticket (fire-and-forget)
            WisphubService.postTicketResponse(ticketId, responseMsg, {
                estado: statusId,
                prioridad: prioridadNum,
            }).catch(() => {});

            console.log('[updateTicketStatus] 🏁 Completado');
            return true;
        } catch (e) {
            console.error('[updateTicketStatus] 💥 ERROR FATAL:', e);
            return false;
        }
    },

    async requestValidation(processId: string, ticketId: string, note: string, file?: File | Blob): Promise<boolean> {
        try {
            const rawTicket = await WisphubService.getTicketRaw(ticketId).catch(() => null);
            const priorityMap: Record<string, number> = { "Baja": 1, "Normal": 2, "Media": 2, "Alta": 3, "Muy Alta": 4 };
            const prioridad = rawTicket ? (priorityMap[rawTicket.prioridad] || 2) : 2;
            const estadoActual = rawTicket?.id_estado || rawTicket?.estado_id || 2;

            const msg = note.trim() || 'Trabajo completado — pendiente de validación por supervisor';
            await WisphubService.postTicketResponse(ticketId, msg, { estado: estadoActual, prioridad }, file).catch(() => {});

            const { data: proc } = await supabase.from('workflow_processes').select('metadata').eq('id', processId).single();
            await supabase.from('workflow_processes').update({
                metadata: {
                    ...(proc?.metadata || {}),
                    pending_validation: true,
                    validation_requested_at: new Date().toISOString(),
                    // Limpia rechazo previo para que el ciclo siguiente funcione limpio
                    validation_rejected: false,
                    validation_rejected_note: null,
                }
            }).eq('id', processId);

            await this.logEvent(processId, 'ValidationRequest', msg).catch(() => {});
            return true;
        } catch (e) {
            console.error('[requestValidation] ERROR:', e);
            return false;
        }
    },

    async markTicketInProgress(ticketId: string | number, eventLabel?: string): Promise<boolean> {
        console.log('[markTicketInProgress] 🚀 Marcando ticket en progreso:', ticketId, eventLabel || '');
        try {
            // Resolver nombre del actor para el mensaje
            let actorName = 'Técnico';
            try {
                const { data: { user } } = await safeGetUser();
                if (user) {
                    const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user.id).single();
                    actorName = profile?.full_name || user.email || 'Técnico';
                }
            } catch { /* usar fallback */ }

            const msgMap: Record<string, string> = {
                'INICIO DE TRABAJO': `El ticket ${ticketId} ha sido iniciado por ${actorName}`,
                'LLEGADA AL SITIO':  `Técnico ${actorName} registró llegada al sitio — Ticket ${ticketId}`,
            };
            const msg = eventLabel ? (msgMap[eventLabel] || `${eventLabel} — Ticket ${ticketId} | ${actorName}`) : '';

            // 1. PUT completo — cambia estado=2 + fecha_inicio (método confiable)
            const rawTicket = await WisphubService.getTicketRaw(ticketId);
            if (!rawTicket) {
                console.error('[markTicketInProgress] ❌ No se pudo obtener ticket raw');
                return false;
            }

            const priorityMap: Record<string, number> = { "Baja": 1, "Normal": 2, "Media": 2, "Alta": 3, "Muy Alta": 4 };
            const validSubjects = (WisphubService as any).TICKET_SUBJECTS || [];
            const currentAsunto = rawTicket.asunto || "Otro Asunto";
            const isAsuntoValid = validSubjects.some((s: string) => s.toLowerCase() === currentAsunto.toLowerCase());
            const safeAsunto = isAsuntoValid ? currentAsunto : (validSubjects[0] || "Otro Asunto");

            let finalTechId = rawTicket.tecnico_id;
            if (!finalTechId || isNaN(Number(finalTechId))) {
                try {
                    const staff = await WisphubService.getStaff();
                    const techName = rawTicket.tecnico || rawTicket.nombre_tecnico || '';
                    const found = staff.find(s =>
                        normalize(s.nombre) === normalize(techName) ||
                        normalize(s.usuario) === normalize(techName) ||
                        s.email === techName
                    );
                    finalTechId = found?.id || staff[0]?.id || 1;
                } catch {
                    finalTechId = 1;
                }
            }

            const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
            const pad = (n: number) => n.toString().padStart(2, '0');
            const fechaInicio = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

            const payload = {
                servicio: rawTicket.servicio?.id_servicio || rawTicket.servicio?.id || rawTicket.servicio,
                asunto: currentAsunto,
                asuntos_default: safeAsunto,
                descripcion: stripHtml(rawTicket.descripcion || '.'),
                prioridad: priorityMap[rawTicket.prioridad] || 2,
                estado: 2,
                tecnico: Number(finalTechId),
                departamento: rawTicket.departamento || "Soporte Técnico",
                departamentos_default: rawTicket.departamento || "Soporte Técnico",
                fecha_inicio: fechaInicio,
            };

            console.log('[markTicketInProgress] 📦 PUT payload:', payload);
            const ok = await WisphubService.updateTicket(ticketId, payload, 'PUT');
            console.log(`[markTicketInProgress] ${ok ? '✅ PUT OK' : '❌ PUT falló'}`);

            // 2. POST /respuesta/ — ticket-estado y ticket-prioridad son requeridos
            if (ok && msg) {
                WisphubService.postTicketResponse(ticketId, msg, {
                    estado: 2,
                    prioridad: priorityMap[rawTicket.prioridad] || 2,
                }).catch(() => {});
            }

            return ok;
        } catch (e) {
            console.error('[markTicketInProgress] 💥 ERROR:', e);
            return false;
        }
    },

    async completeAndSyncWorkItem(workItemId: string, resolution: string, options: CompleteOptions = {}) {
        try {
            const finalStatusId = options.statusId || 4;
            const signalValue = options.signal || '';

            // 1. Obtener detalles del item
            const { data: item } = await supabase
                .from('workflow_workitems')
                .select('*, workflow_activities(id, process_id, workflow_processes(reference_id, metadata))')
                .eq('id', workItemId)
                .single();

            if (!item) return false;

            const ticketId = item.workflow_activities?.workflow_processes?.reference_id;
            const processId = item.workflow_activities?.process_id;
            const currentMetadata = item.workflow_activities?.workflow_processes?.metadata || {};

            // 2. Marcar workitem como completado localmente
            const { error: localError } = await supabase
                .from('workflow_workitems')
                .update({ status: 'SS' })
                .eq('id', workItemId);

            if (localError) throw localError;

            // 3. Marcar proceso como Completado y actualizar id_estado en metadata
            if (processId) {
                await supabase
                    .from('workflow_processes')
                    .update({
                        status: 'Completed',
                        metadata: {
                            ...currentMetadata,
                            id_estado: finalStatusId,
                            ...(signalValue ? { potencia: signalValue } : {})
                        }
                    })
                    .eq('id', processId);
            }

            // 4. Sincronizar con WispHub
            if (ticketId) {
                const files = options.files || [];
                const firstFile = files[0];
                const extraFiles = files.slice(1);

                // Prepend signal information to resolution
                let finalResolution = resolution;
                if (signalValue) {
                    finalResolution = `--- POTENCIA ÓPTICA: ${signalValue} dBm ---\n\n${resolution}`;
                }

                // B. Evidencias adicionales en Supabase + HTML
                if (extraFiles.length > 0) {
                    const extraLinks: string[] = [];
                    for (let i = 0; i < extraFiles.length; i++) {
                        const file = extraFiles[i];
                        const fileName = `tk_${ticketId}_ex_${i}_${Date.now()}.jpg`;
                        const filePath = fileName;

                        const { error: uploadError } = await supabase.storage
                            .from('interaction-attachments')
                            .upload(filePath, file, {
                                cacheControl: '3600',
                                upsert: true,
                                contentType: 'image/jpeg'
                            });

                        if (!uploadError) {
                            const { data: publicData } = supabase.storage
                                .from('interaction-attachments')
                                .getPublicUrl(filePath);

                            if (publicData?.publicUrl) {
                                extraLinks.push(publicData.publicUrl);
                            }
                        } else {
                            console.error(`[Supabase Storage Error] ${fileName}:`, uploadError);
                        }
                    }

                    if (extraLinks.length > 0) {
                        const textLinks = extraLinks.map((url, idx) => `Evidencia #${idx + 2}:\n${url}`).join('\n\n');
                        finalResolution = `${finalResolution}\n\n--- EVIDENCIAS ADICIONALES ---\n${textLinks}`;
                    }
                }

                await this.updateTicketStatus(ticketId, finalStatusId, finalResolution, { file: firstFile });
            }

            return true;
        } catch (e) {
            console.error('Error in completeAndSync:', e);
            return false;
        }
    },

    async trackMaterialConsumption(ticketId: string, materials: { asset_id: string, quantity: number }[]) {
        try {
            const { data: { user } } = await safeGetUser();
            if (!user) return false;

            for (const mat of materials) {
                // Registrar movimiento de consumo
                await supabase.from('inventory_movements').insert({
                    asset_id: mat.asset_id,
                    origin_holder_id: user.id,
                    movement_type: 'CONSUMO',
                    quantity: mat.quantity,
                    notes: `Consumido en Ticket #${ticketId}`,
                    created_by: user.id
                });

                // Actualizar stock del asset si no es serializado
                // [FIX] is_serialized está en inventory_items, no en inventory_assets
                const { data: asset } = await supabase
                    .from('inventory_assets')
                    .select('quantity, inventory_items!inner(is_serialized)')
                    .eq('id', mat.asset_id)
                    .single();

                // Accedemos a la propiedad anidada
                const isSerialized = (asset?.inventory_items as any)?.is_serialized;

                if (asset && !isSerialized) {
                    await supabase.from('inventory_assets').update({
                        quantity: Math.max(0, asset.quantity - mat.quantity)
                    }).eq('id', mat.asset_id);
                } else if (asset && isSerialized) {
                    // Si es serializado, se marca como instalado/consumido (sacar de stock técnico)
                    await supabase.from('inventory_assets').update({
                        status: 'INSTALADO',
                        current_holder_id: null
                    }).eq('id', mat.asset_id);
                }
            }
            return true;
        } catch (e) {
            console.error('[Inventory] Error tracking consumption:', e);
            return false;
        }
    },

    async escalateWorkItem(workItemId: string, reason: string, targetTechnicianId?: string, options: { priority?: number, file?: File | Blob } = {}) {
        try {
            // 1. Obtener item y proceso actual
            const { data: item } = await supabase
                .from('workflow_workitems')
                .select('*, workflow_activities(*, workflow_processes(*))')
                .eq('id', workItemId)
                .single();

            if (!item) return false;

            const currentLevel = item.workflow_activities?.workflow_processes?.metadata?.current_level ?? 1;

            // LÓGICA DE SALTO: 0 o 1 saltan a 2 (Supervisor). El resto sube de 1 en 1.
            let nextLevel = currentLevel + 1;
            if (currentLevel === 0) nextLevel = 2;
            else if (currentLevel === 1) nextLevel = 2;

            const processId = item.workflow_activities?.workflow_processes?.id;
            const ticketId = item.workflow_activities?.workflow_processes?.reference_id;

            if (nextLevel > 4 || currentLevel >= 4) {
                alert('No hay más niveles de escalamiento operativos configurados (Nivel Máximo: 4).');
                return false;
            }

            // 2. Marcar actual como completado (Escalado)
            await supabase
                .from('workflow_workitems')
                .update({
                    status: 'SS'
                    // Se omitió completed_at porque no existe en el esquema
                })
                .eq('id', workItemId);

            // 3. Actualizar nivel en proceso + marcar escalated_to para Supervisión
            const escalatedToName = targetTechnicianId
                ? (await supabase.from('profiles').select('full_name').or(`id.eq.${isUUID(targetTechnicianId) ? targetTechnicianId : '00000000-0000-0000-0000-000000000000'},wisphub_id.eq.${targetTechnicianId}`).maybeSingle())?.data?.full_name || targetTechnicianId
                : `Nivel ${nextLevel}`;
            await supabase
                .from('workflow_processes')
                .update({
                    metadata: {
                        ...item.workflow_activities.workflow_processes.metadata,
                        current_level: nextLevel,
                        escalated_to: escalatedToName,
                        escalated_at: new Date().toISOString()
                    }
                })
                .eq('id', processId);

            // 4. Crear o recuperar la actividad
            let nextActivity;
            const { data: existingActivity } = await supabase
                .from('workflow_activities')
                .select('*')
                .eq('process_id', processId)
                .eq('name', `ESCALAMIENTO NIVEL ${nextLevel}`)
                .single();

            if (existingActivity) {
                nextActivity = existingActivity;
            } else {
                const { data: newActivity, error: activityError } = await supabase
                    .from('workflow_activities')
                    .insert({
                        process_id: processId,
                        name: `ESCALAMIENTO NIVEL ${nextLevel}`,
                        activity_type: 'HS',
                        status: 'Active'
                    })
                    .select()
                    .single();

                if (activityError && activityError.code !== '23505') throw activityError;
                nextActivity = newActivity;
            }

            if (nextActivity) {
                // 5. RESOLVER IDENTIDADES (Local UUID vs WispHub Mapping)
                let targetUuid: string | undefined;
                let targetWhId: string | undefined;

                if (targetTechnicianId) {
                    console.log(`[ANALYSIS] Resolviendo técnico para ID: ${targetTechnicianId}`);

                    // Búsqueda inteligente: intentamos encontrar el perfil por UUID o por el Mapping directamente
                    const { data: profile } = await supabase
                        .from('profiles')
                        .select('id, wisphub_id')
                        .or(`id.eq.${isUUID(targetTechnicianId) ? targetTechnicianId : '00000000-0000-0000-0000-000000000000'},wisphub_id.eq.${targetTechnicianId}`)
                        .maybeSingle();

                    if (profile) {
                        targetUuid = profile.id;
                        targetWhId = profile.wisphub_id;
                        console.log(`[INTERNAL] ID Usuario Local: ${targetUuid}`);
                        console.log(`[MAPPING] Valor EXACTO wisphub_id: ${targetWhId}`);
                    } else {
                        // Si no hay perfil, tratamos el input como ID directo según su formato
                        if (isUUID(targetTechnicianId)) {
                            targetUuid = targetTechnicianId;
                        } else {
                            targetWhId = targetTechnicianId;
                        }
                        console.log(`[INTERNAL] ID Usuario Local (Inferred): ${targetUuid || 'n/a'}`);
                        console.log(`[MAPPING] Valor EXACTO wisphub_id (Inferred): ${targetWhId || 'n/a'}`);
                    }
                }

                // ABORTAR si no hay mapeo válido para WispHub (Rule 2.2)
                if (ticketId && !targetWhId) {
                    console.error(`[MAPPING] 🛑 ERROR: No se encontró un mapeo de técnico válido para WispHub. Abortando proceso de red.`);
                }

                // A. Inserción Local (Supabase) - USAR SIEMPRE UUID para evitar Error 400
                const pType = nextLevel <= 1 ? 'U' : nextLevel === 2 ? 'SU' : 'SO';
                const deadline = new Date();
                deadline.setMinutes(deadline.getMinutes() + 120); // 2 horas de plazo
                const deadlineStr = deadline.toISOString();

                if (targetUuid) {
                    console.log(`[INTERNAL] Intentando asignar WorkItem local para UUID: ${targetUuid}, Tipo: ${pType}`);
                    const { error: insertError } = await supabase.from('workflow_workitems').upsert({
                        activity_id: nextActivity.id,
                        participant_id: targetUuid,
                        participant_type: pType,
                        deadline: deadlineStr,
                        status: 'PE'
                    }, {
                        onConflict: 'activity_id,participant_id'
                    });

                    if (insertError) {
                        console.error(`[INTERNAL] ❌ Error en UPSERT de WorkItem:`, insertError);
                    }
                } else {
                    // Enrutamiento automático si no hay técnico específico
                    const { data: nextLevelUsers } = await supabase
                        .from('profiles')
                        .select('id')
                        .eq('operational_level', nextLevel);

                    if (nextLevelUsers && nextLevelUsers.length > 0) {
                        const workItems = nextLevelUsers.map(u => ({
                            activity_id: nextActivity.id,
                            participant_id: u.id, // Siempre UUID
                            participant_type: pType,
                            deadline: deadlineStr,
                            status: 'PE'
                        }));
                        const { error: multiError } = await supabase.from('workflow_workitems').upsert(workItems, {
                            onConflict: 'activity_id,participant_id'
                        });
                        if (multiError) console.error(`[INTERNAL] ❌ Error en UPSERT múltiple:`, multiError);
                    } else {
                        const { error: fallbackError } = await supabase.from('workflow_workitems').upsert({
                            activity_id: nextActivity.id,
                            participant_id: `SOPORTE NIVEL ${nextLevel}`,
                            participant_type: pType,
                            deadline: deadlineStr,
                            status: 'PE'
                        }, {
                            onConflict: 'activity_id,participant_id'
                        });
                        if (fallbackError) console.error(`[INTERNAL] ❌ Error en UPSERT fallback:`, fallbackError);
                    }
                }

                // 6. Sincronizar con WispHub (Reasignación y descripción)
                if (ticketId) {
                    try {
                        // Obtener nombre del actor actual para la trazabilidad
                        const { data: { user } } = await safeGetUser();
                        let actorName = 'Sistema';
                        if (user) {
                            const { data: actorProfile } = await supabase.from('profiles').select('full_name').eq('id', user.id).single();
                            actorName = actorProfile?.full_name || user.email || 'Sistema';
                        }

                        const timestamp = new Date().toLocaleString('es-CO', {
                            dateStyle: 'short',
                            timeStyle: 'short',
                            timeZone: 'America/Bogota'
                        }).replace(',', '');

                        // Bloque profesional para agregar a la descripción
                        const fancyComment = `==== ESCALAMIENTO A NIVEL ${nextLevel} | ${actorName.toUpperCase()} | Fecha: ${timestamp} | MOTIVO: ${reason} ====`;

                        // Delegar cambio de técnico con descripción actualizada
                        if (targetUuid) {
                            await this.changeWispHubTechnician(ticketId, targetUuid, {
                                priority: options.priority,
                                file: options.file,
                                descripcion: fancyComment
                            });
                        }
                    } catch (whError) {
                        console.error('[RESPONSE] ❌ Error en sincronización WispHub:', whError);
                    }
                }
            }
            // 7. Log de escalamiento
            try {
                const { data: { user } } = await safeGetUser();
                await this.logEvent(
                    processId,
                    'Escalation',
                    `Ticket escalado a ${escalatedToName}`,
                    user?.id
                );
            } catch { /* no bloquear si falla el log */ }

            return true;
        } catch (e) {
            console.error('Error in escalateWorkItem:', e);
            return false;
        }
    },

    async supervisorValidateProcess(processId: string, ticketId: string, note: string): Promise<boolean> {
        try {
            const { data: { user } } = await safeGetUser();
            let supervisorName = 'Supervisor';
            if (user) {
                const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user.id).single();
                supervisorName = profile?.full_name || user.email || 'Supervisor';
            }

            const msg = `Validado por ${supervisorName}: ${note.trim()}`;
            // PUT completo estado=4 para cerrar el ticket en WispHub (postTicketResponse solo agrega texto, no cambia estado)
            await this.updateTicketStatus(String(ticketId), 4, msg);

            const { data: proc } = await supabase.from('workflow_processes').select('metadata').eq('id', processId).single();
            await supabase.from('workflow_processes').update({
                status: 'Completed',
                metadata: {
                    ...(proc?.metadata || {}),
                    pending_validation: false,
                    supervisor_validated: true,
                    supervisor_validation_note: note.trim(),
                    supervisor_validated_at: new Date().toISOString(),
                    closed_at: new Date().toISOString(),
                }
            }).eq('id', processId);

            // Cierra workitems activos del proceso
            try {
                const { data: activities } = await supabase
                    .from('workflow_activities')
                    .select('id')
                    .eq('process_id', processId);
                if (activities && activities.length > 0) {
                    await supabase
                        .from('workflow_workitems')
                        .update({ status: 'CO' })
                        .eq('status', 'PE')
                        .in('workflow_activity_id', activities.map((a: any) => a.id));
                }
            } catch { /* no bloquear */ }

            await this.logEvent(processId, 'SupervisorValidation', msg, user?.id).catch(() => {});
            return true;
        } catch (e) {
            console.error('[supervisorValidateProcess] ERROR:', e);
            return false;
        }
    },

    async rejectValidation(processId: string, ticketId: string, note: string): Promise<boolean> {
        try {
            const { data: { user } } = await safeGetUser();
            let supervisorName = 'Supervisor';
            if (user) {
                const { data: profile } = await supabase.from('profiles').select('full_name').eq('id', user.id).single();
                supervisorName = profile?.full_name || user.email || 'Supervisor';
            }

            const rawTicket = await WisphubService.getTicketRaw(ticketId).catch(() => null);
            const priorityMap: Record<string, number> = { "Baja": 1, "Normal": 2, "Media": 2, "Alta": 3, "Muy Alta": 4 };
            const prioridad = rawTicket ? (priorityMap[rawTicket.prioridad] || 2) : 2;

            const msg = `Validación rechazada por ${supervisorName}: ${note.trim()}`;
            // Mantiene el ticket en progreso (estado=2)
            await WisphubService.postTicketResponse(ticketId, msg, { estado: 2, prioridad }).catch(() => {});

            const { data: proc } = await supabase.from('workflow_processes').select('metadata').eq('id', processId).single();
            await supabase.from('workflow_processes').update({
                metadata: {
                    ...(proc?.metadata || {}),
                    pending_validation: false,
                    validation_rejected: true,
                    validation_rejected_note: note.trim(),
                    validation_rejected_at: new Date().toISOString(),
                    validation_rejected_by: supervisorName,
                }
            }).eq('id', processId);

            await this.logEvent(processId, 'ValidationRejected', msg, user?.id).catch(() => {});

            // Señal cross-tab: el storage event se dispara en OTRAS pestañas del mismo browser.
            // MyTasks escucha esta clave y llama loadMyTasks() inmediatamente.
            try {
                localStorage.setItem('crm:rejection_signal', JSON.stringify({
                    processId,
                    note: note.trim(),
                    at: new Date().toISOString(),
                }));
            } catch { /* no bloquear si localStorage no disponible */ }

            // Reabre workitems para el técnico: si estaba SS (completado) lo vuelve PE.
            // Esto garantiza que el ticket reaparezca en MyTasks después del rechazo.
            try {
                const { data: acts } = await supabase
                    .from('workflow_activities')
                    .select('id')
                    .eq('process_id', processId);
                if (acts && acts.length > 0) {
                    const actIds = acts.map((a: any) => a.id);
                    await supabase
                        .from('workflow_workitems')
                        .update({ status: 'PE', updated_at: new Date().toISOString() })
                        .in('activity_id', actIds)
                        .in('status', ['SS', 'PE']);
                }
            } catch { /* no bloquear */ }

            return true;
        } catch (e) {
            console.error('[rejectValidation] ERROR:', e);
            return false;
        }
    },

    async supervisorCloseProcess(
        processId: string,
        resolution: string,
        statusId: number = 4   // 4=Cerrado, 3=Resuelto
    ): Promise<boolean> {
        try {
            const { data: { user } } = await safeGetUser();

            // 1. Obtener el proceso
            const { data: proc } = await supabase
                .from('workflow_processes')
                .select('reference_id, metadata')
                .eq('id', processId)
                .single();

            if (!proc) return false;

            // 2. Marcar proceso como Completado en Supabase
            await supabase
                .from('workflow_processes')
                .update({
                    status: 'Completed',
                    metadata: { ...(proc.metadata || {}), supervisor_resolution: resolution, closed_at: new Date().toISOString() }
                })
                .eq('id', processId);

            // 3. Cerrar todos los workitems activos (PE) del proceso
            try {
                const { data: activities } = await supabase
                    .from('workflow_activities')
                    .select('id')
                    .eq('process_id', processId);
                if (activities && activities.length > 0) {
                    const activityIds = activities.map((a: any) => a.id);
                    await supabase
                        .from('workflow_workitems')
                        .update({ status: 'CO' })
                        .eq('status', 'PE')
                        .in('workflow_activity_id', activityIds);
                }
            } catch { /* no bloquear si falla el cierre de workitems */ }

            // 4. Sincronizar cierre con WispHub
            if (proc.reference_id) {
                try {
                    await WisphubService.updateTicket(proc.reference_id, { id_estado: statusId });
                } catch { /* no bloquear si WispHub no responde */ }
            }

            // 5. Log del evento
            await this.logEvent(processId, 'SupervisorClose', `Supervisión cerró el ticket: ${resolution}`, user?.id);

            return true;
        } catch (e) {
            console.error('[supervisorCloseProcess] Error:', e);
            return false;
        }
    },

    async logEvent(processId: string, type: string, description: string, actorId?: string) {
        await supabase
            .from('workflow_logs')
            .insert([{
                process_id: processId,
                event_type: type,
                description,
                actor_id: actorId
            }]);
    },

    async getFullLogs(processId: string): Promise<WorkflowLog[]> {
        const { data, error } = await supabase
            .from('workflow_logs')
            .select('*')
            .eq('process_id', processId)
            .order('created_at', { ascending: true });
        return error ? [] : data;
    },

    // --- ESCALAMIENTO AXCES ---
    async checkTimeouts() {
        const now = new Date().toISOString();

        // 1. Cierre Automático: Resuelto -> Cerrado tras 24h
        const { data: resolvedProcesses } = await supabase
            .from('workflow_processes')
            .select('id, updated_at')
            .eq('status', 'SS');

        if (resolvedProcesses) {
            for (const p of resolvedProcesses) {
                const diff = (new Date().getTime() - new Date(p.updated_at).getTime()) / (1000 * 60 * 60);
                if (diff >= 24) {
                    await supabase.from('workflow_processes').update({ status: 'Cerrado' }).eq('id', p.id);
                    await this.logEvent(p.id, 'Auto-Close', 'Caso cerrado automáticamente tras 24h sin respuesta.');
                }
            }
        }

        // 2. Escalamiento por SLA
        const { data: expiredItems, error } = await supabase
            .from('workflow_workitems')
            .select('*, workflow_activities(process_id, name)')
            .eq('status', 'Pending')
            .lt('deadline', now);

        if (error || !expiredItems) return;

        const AXCES_LEVELS: Record<string, { label: string, contact: string, type: ParticipantType }> = {
            'N1': { label: 'Soporte Técnico', contact: 'SOPORTE NIVEL 1', type: 'U' },
            'N2': { label: 'Supervisor de Operaciones', contact: 'SOPORTE NIVEL 2', type: 'SU' },
            'N3': { label: 'Jefe de Operaciones', contact: 'SOPORTE NIVEL 3', type: 'DA' },
            'N4': { label: 'Gerencia', contact: 'GERENCIA', type: 'DA' }
        };

        for (const item of expiredItems) {
            const processId = item.workflow_activities?.process_id;
            if (!processId) continue;

            const { data: proc } = await supabase.from('workflow_processes')
                .select('metadata')
                .eq('id', processId)
                .single();

            const currentLevel = proc?.metadata?.current_level || 1;
            const nextLevel = Math.min(currentLevel + 1, 4);
            const levelKey = `N${nextLevel}`;
            const levelInfo = AXCES_LEVELS[levelKey];

            if (!levelInfo) continue;

            await supabase.from('workflow_workitems').update({ status: 'Expired' }).eq('id', item.id);
            await supabase.from('workflow_processes').update({
                status: 'ES',
                updated_at: now,
                metadata: { ...proc?.metadata, current_level: nextLevel }
            }).eq('id', processId);

            await this.logEvent(processId, 'Escalation', `SLA Excedido. Escalado a Nivel ${nextLevel}: ${levelInfo.contact}`);

            await this.createStep(
                processId,
                `Escalamiento N${nextLevel}: ${levelInfo.label}`,
                levelInfo.contact,
                levelInfo.type,
                120 // 2h para pasos de escalamiento
            );
        }
    },

    // --- SINCRONIZACIÓN AXCES (STRICT MIRROR) ---
    async syncMyTickets(forceFull: boolean = false) {
        try {
            console.log(`[Sync] 🔄 START: Strict Mirror Sync (ForceFull=${forceFull})...`);

            // 1. Authenticate context
            const { data: { user } } = await safeGetUser();
            if (!user) throw new Error("No authenticated user.");

            console.log(`[Sync] 👤 Session User: ${user.email} (UID: ${user.id})`);

            // 1.1 Intentar resolver perfil por ID o por Email (Fallback)
            let { data: profile } = await supabase.from('profiles').select('*').eq('id', user.id).maybeSingle();

            if (!profile && user.email) {
                console.log(`[Sync] 🔍 Profile not found by UID. Trying by email: ${user.email}`);
                const { data: emailProfile } = await supabase
                    .from('profiles')
                    .select('*')
                    .eq('email', user.email)
                    .maybeSingle();

                if (emailProfile) {
                    profile = emailProfile;
                    console.log(`[Sync] ✅ Profile recovered via email match: ${emailProfile.id}`);
                }
            }

            // Validamos que exista perfil y al menos un campo de mapeo
            if (!profile || (!profile.wisphub_id && !profile.wisphub_mapping)) {
                console.error("[Sync] 🛑 No profile or mapping found for this session.");
                return false;
            }

            // [INTERNAL] ID del usuario local que usaremos para los WorkItems
            const effectiveParticipantId = profile.id;
            console.log(`[INTERNAL] Mapping to Profile ID: ${effectiveParticipantId} (${profile.full_name})`);

            // PRIORIDAD: Mapping Manual > ID Automático
            const targetUsername = profile.wisphub_mapping || profile.wisphub_id;

            // [MAPPING] Valor exacto que usará la API
            console.log(`[MAPPING] WispHub ID/Mapping: "${targetUsername}"`);

            if (!targetUsername) {
                console.error("[MAPPING] 🛑 ABORT: targetUsername is null/undefined. Cannot sync.");
                return false;
            }

            // 2. Resolve Tech Name via /api/staff/ 
            // (The "Indirect Mapping": Local Email -> Staff Object -> Real Name -> Ticket Match)
            let techNameStr = '';
            let staffMember: any = null;

            try {
                const staffRes = await WisphubService.getStaff();
                const staffList = staffRes || [];

                staffMember = staffList.find((s: any) =>
                    normalize(s.usuario) === normalize(targetUsername) ||
                    normalize(s.username) === normalize(targetUsername) ||
                    s.email === targetUsername
                );

                // Fallback de coincidencia parcial solo si e mapeo parece ser un email corto
                if (!staffMember && targetUsername.includes('@')) {
                    const shortName = targetUsername.split('@')[0];
                    staffMember = staffList.find((s: any) =>
                        (s.usuario && s.usuario.startsWith(shortName)) ||
                        (s.username && s.username.startsWith(shortName))
                    );
                }

                if (staffMember) {
                    techNameStr = staffMember.nombre;
                    // [MAPPING] Confirmación de resolución de staff
                    console.log(`[MAPPING] Resolved Staff: "${techNameStr}" (ID: ${staffMember.id})`);
                } else {
                    console.error(`[MAPPING] ❌ Could not find WispHub Staff for mapping: ${targetUsername}`);
                    return false;
                }

                // FAIL-SAFE SECURITY CHECK
                if (!techNameStr || techNameStr.trim() === '') {
                    console.error(`[MAPPING] 🛑 SECURITY ALERT: Resolved Name is EMPTY for ${targetUsername}. Aborting sync.`);
                    return false;
                }

            } catch (err) {
                console.error("[Sync] ❌ Error resolving staff:", err);
                return false;
            }

            // 3. Recursive Ticket Fetching & Local Filter
            // --- ESTRATEGIA DE SINCRONIZACIÓN POR NIVELES ---
            // FASE 1: ABIERTOS (sin límite de fecha) - Trae TODOS los tickets abiertos históricos.
            const now = new Date();
            const endDateStr = new Date(now.getTime() + 86400000).toISOString().split('T')[0];

            console.log(`[Sync:N1] 🔍 Buscando Tareas ABIERTAS (sin límite de fecha)...`);

            let allApiTickets: any[] = [];

            try {
                const tecId = staffMember?.id ? String(staffMember.id) : undefined;

                if (tecId) {
                    // Ruta rápida: WispHub filtra por técnico en servidor.
                    // Solo devuelve los tickets de este técnico → muy pocos, sin límite de fecha.
                    const [res1, res2] = await Promise.all([
                        WisphubService.getAllTickets({ status: '1', tecnicoId: tecId }),
                        WisphubService.getAllTickets({ status: '2', tecnicoId: tecId }),
                    ]);
                    const merged = new Map<string, any>();
                    [...res1, ...res2].forEach(t => merged.set(String(t.id), t));
                    allApiTickets = Array.from(merged.values());
                    console.log(`[Sync:N1] ✅ Ruta rápida (tecnico=${tecId}): ${allApiTickets.length} tickets.`);
                } else {
                    // Ruta lenta (sin ID numérico): limitar a 30 días para no colgar la UI.
                    // El filtro local por nombre se aplica en FASE 4.
                    const past30 = new Date();
                    past30.setDate(past30.getDate() - 30);
                    const startDate30 = past30.toISOString().split('T')[0];
                    const [res1, res2] = await Promise.all([
                        WisphubService.getAllTickets({ status: '1', startDate: startDate30 }),
                        WisphubService.getAllTickets({ status: '2', startDate: startDate30 }),
                    ]);
                    const merged = new Map<string, any>();
                    [...res1, ...res2].forEach(t => merged.set(String(t.id), t));
                    allApiTickets = Array.from(merged.values());
                    console.log(`[Sync:N1] ✅ Ruta normal (30d, sin tecnico): ${allApiTickets.length} tickets.`);
                }
            } catch (e) {
                console.error("[Sync:N1] ⚠️ Error en fase abiertos:", e);
            }

            // FASE 2: HISTORIAL RECIENTE (7-30 días) - Para auditoría y tareas recién terminadas.
            const daysBack = forceFull ? 30 : 7;
            const pastHistory = new Date();
            pastHistory.setDate(now.getDate() - daysBack);
            const historyStartDate = pastHistory.toISOString().split('T')[0];

            console.log(`[Sync:N2] 🔍 Sincronizando HISTORIAL RECIENTE (${daysBack} días)...`);
            
            let page = 1;
            let hasMore = true;
            while (hasMore && page <= (forceFull ? 10 : 3)) {
                const { results, count } = await WisphubService.getAllTicketsPage(page, {
                    startDate: historyStartDate,
                    endDate: endDateStr
                });

                if (results && results.length > 0) {
                    const newTickets = results.filter((t: any) => !allApiTickets.some(at => at.id === t.id));
                    allApiTickets = [...allApiTickets, ...newTickets];
                    if (allApiTickets.length >= count || results.length < 50) hasMore = false;
                    page++;
                } else {
                    hasMore = false;
                }
                await new Promise(r => setTimeout(r, 100));
            }

            console.log(`[Sync] 📦 Total Active Tickets in API for this Tech: ${allApiTickets.length}`);
            if (allApiTickets.length === 0) {
                console.log("[Sync] ⚠️ No tickets found in API. User queue is empty.");
            }

            const myApiTicketIds: string[] = [];

            // 4. PROCESS: Throttled Upsert (Status 'PE')
            const allProfiles = await this.getPlatformUsers();

            for (const ticket of allApiTickets) {
                try {
                    const incomingTechName = normalize(ticket.tecnico || ticket.nombre_tecnico || '');
                    const incomingTechRaw = String(ticket.tecnico || '').trim();
                    const incomingTechId = String(ticket.tecnico_id || '').trim();

                    const isStrictlyMine =
                        incomingTechName === normalize(techNameStr) ||
                        (staffMember?.id && incomingTechId === String(staffMember.id)) ||
                        (staffMember?.usuario && normalize(incomingTechRaw) === normalize(staffMember.usuario)) ||
                        normalize(incomingTechRaw) === normalize(targetUsername) ||
                        incomingTechId === targetUsername;

                    if (isStrictlyMine) {
                        myApiTicketIds.push((ticket.id || ticket.id_ticket).toString());
                        // Si forceFull es true, mandamos forceLocalOverride para romper la protección SS
                        await this.syncSingleTicketMirror(ticket, allProfiles, profile, { autoAssign: true, forceLocalOverride: forceFull });
                        await new Promise(r => setTimeout(r, 50));
                    }
                } catch (e) {
                    console.error(`[Sync] ❌ Failed to upsert ticket ${ticket?.id}:`, e);
                }
            }

            // 5. SPLIT CLEANUP STRATEGY (Identity Purge vs History Check)

            // 5.1 Fetch Local 'PE' candidates
            const { data: localItems } = await supabase
                .from('workflow_workitems')
                .select(`
                    id,
                    activity_id,
                    updated_at,
                    workflow_activities!inner(
                        workflow_processes!inner(reference_id, metadata)
                    )
                `)
                .eq('participant_id', profile.id)
                .eq('status', 'PE');

            const itemsToPurge: string[] = [];
            const idsToPurgeLog: string[] = [];

            console.log(`[Sync] 🧹 Starting Cleanup Check on ${localItems?.length || 0} local items...`);

            for (const item of localItems || []) {
                const proc = (item.workflow_activities as any)?.workflow_processes;
                const refId = proc?.reference_id;

                if (!refId) continue;

                if (myApiTicketIds.includes(refId.toString())) {
                    continue;
                }

                // [RACE CONDITION FIX] Período de gracia de 2 minutos
                // Si el ticket fue inyectado forzosamente de forma local (ej. publicado en Despacho en este mismo instante)
                // y WispHub aún retorna datos viejos en el getAllTicketsPage, evitamos la purga prematura.
                const timeSinceLastUpdateMs = new Date().getTime() - new Date(item.updated_at).getTime();
                if (timeSinceLastUpdateMs < 120000) {
                    console.log(`[StrictPurge] 🛡️ Ticket #${refId} modificado de forma local hace menos de 2 mins. Inmune a purgas por caché de WispHub.`);
                    continue;
                }

                // [STRICT PURGE] Barrido Total: Verificamos propiedad contra WispHub sin importar la fecha
                // Esto elimina "fantasmas" antiguos que cambiaron de dueño o estado fuera de la ventana de 10 días.
                try {
                    console.log(`[StrictPurge] 🔍 Verifying ticket #${refId} ownership...`);
                    const ticketDetail = await WisphubService.getTicketDetail(refId);

                    if (ticketDetail) {
                        // FIX: Comprobación estricta utilizando los campos mapeados correctos
                        // mapTicket no siempre genera .tecnico general, pero genera nombre_tecnico, tecnico_id y tecnico_usuario
                        const mappedTechName = ticketDetail.nombre_tecnico || '';
                        const mappedTechId = String(ticketDetail.tecnico_id || '');
                        const mappedTechUser = ticketDetail.tecnico_usuario || '';

                        const isStrictlyMine = (
                            normalize(mappedTechName) === normalize(techNameStr) ||
                            (staffMember?.id && mappedTechId === String(staffMember.id)) ||
                            (staffMember?.usuario && normalize(mappedTechUser) === normalize(staffMember.usuario))
                        );

                        const isClosed = ['Cerrado', 'Resuelto', 'Cancelado', 'Finalizado'].includes(ticketDetail.nombre_estado || ticketDetail.estado);

                        if (isStrictlyMine && !isClosed) {
                            console.log(`[StrictPurge] ✅ Ticket #${refId} is precisely mine and active. KEEPING.`);
                            await supabase.from('workflow_workitems').update({ updated_at: new Date().toISOString() }).eq('id', item.id); // Refresh time to avoid cron purge
                            continue;
                        } else {
                            console.log(`[StrictPurge] 🗑️ Ticket #${refId} closed or reassigned (WispHub: ${mappedTechName} - Local: ${techNameStr}). PURGING.`);
                        }
                    } else {
                        console.log(`[StrictPurge] 🗑️ Ticket #${refId} NOT FOUND in WispHub. PURGING.`);
                    }
                } catch (err) {
                    console.error(`[StrictPurge] ❌ Error verifying ticket #${refId}:`, err);
                    continue;
                }

                itemsToPurge.push(item.id);
                console.log(`[PURGE] Ticket #${refId} marked as CO. Reason: Confirmed missing/closed.`);
                idsToPurgeLog.push(`${refId} (Stale/Closed/Reassigned)`);
            }

            if (itemsToPurge.length > 0) {
                // SEGURO DE GRAVEDAD: Si planeamos purgar más del 80% de los tickets locales 
                // y el resultado de la API fue muy pequeño, abortamos por seguridad.
                const localCount = localItems?.length || 0;
                const purgeRatio = itemsToPurge.length / (localCount || 1);

                if (purgeRatio > 0.8 && localCount > 2) {
                    console.error(`[Sync] 🛑 BLOQUEO DE SEGURIDAD ACTIVADO. Se intentó purgar el ${Math.round(purgeRatio * 100)}% de los tickets (${itemsToPurge.length}/${localCount}). Abortando purga para proteger datos locales.`);
                    return true; // Retornamos éxito porque sincronizamos los nuevos, pero protegimos los viejos.
                }

                console.log(`[Sync] 🗑️ PURGING ${itemsToPurge.length} items (Batch Processing)...`);
                const BATCH_SIZE = 50;
                for (let i = 0; i < itemsToPurge.length; i += BATCH_SIZE) {
                    const batch = itemsToPurge.slice(i, i + BATCH_SIZE);
                    await supabase.from('workflow_workitems').update({ status: 'CO' }).in('id', batch);
                }
            } else {
                console.log("[Sync] ✨ Cleanup: No items to purge.");
            }

            console.log("[Sync] ✅ Strict Mirror Sync COMPLETE.");
            return true;
        } catch (error) {
            console.error("[Sync] 🚨 Fatal Error in syncMyTickets:", error);
            return false;
        }
    },

    /**
     * Procesa un solo ticket usando UPSERT para sincronización espejo
     */
    async syncSingleTicketMirror(ticket: any, profiles: any[], syncOwnerProfile?: any, options: { autoAssign?: boolean, forceLocalOverride?: boolean } = {}): Promise<void> {
        try {
            const ticketIdStr = ticket.id.toString();
            const techName = ticket.tecnico || ticket.nombre_tecnico || 'Sin asignar';

            // PRIORIDAD 1: Si lo bajamos nosotros en un sync personal, es nuestro.
            let profile = syncOwnerProfile;

            // PRIORIDAD 2: Búsqueda Inteligente Multi-Criterio
            if (!profile) {
                profile = profiles.find(p => {
                    const localWhId = normalize(p.wisphub_id);
                    const incomingTech = normalize(techName);
                    const incomingTechId = ticket.tecnico_id ? String(ticket.tecnico_id) : null;
                    const incomingUser = ticket.tecnico_usuario ? normalize(ticket.tecnico_usuario) : null;

                    return (
                        // A. Coincidencia por ID Numérico (El más seguro)
                        (incomingTechId && localWhId === incomingTechId) ||
                        // B. Coincidencia Exacta de Usuario o Email
                        (localWhId === incomingUser) ||
                        (localWhId === incomingTech) ||
                        // C. El ID local está contenido en la cadena de WispHub (ej: "Nombre - usuario")
                        (localWhId !== "" && incomingTech.includes(localWhId)) ||
                        // D. Coincidencia por Nombre Completo
                        (normalize(p.full_name) !== "" && incomingTech.includes(normalize(p.full_name)))
                    );
                });
            }

            // 2. Cálculo de Status Robusto (Consistencia de Estados)
            let finalStatus: 'PE' | 'CO' = 'PE';
            const whStatusId = Number(ticket.id_estado);
            const whStatusName = (ticket.nombre_estado || ticket.estado || '').toLowerCase();

            if ([3, 4].includes(whStatusId) || whStatusName.includes('resuelto') || whStatusName.includes('cerrado')) {
                finalStatus = 'CO';
            } else {
                finalStatus = 'PE';
            }

            // 2.1 Consultar estado previo para Fusión de Metadatos (Integridad de Datos)
            const { data: existingProcess } = await supabase
                .from('workflow_processes')
                .select('metadata')
                .eq('reference_id', ticketIdStr)
                .maybeSingle();

            const mergedMetadata = { ...ticket };
            if (existingProcess?.metadata) {
                // Preservar datos críticos si el nuevo ticket viene incompleto
                const old = existingProcess.metadata;

                if ((!mergedMetadata.nombre_cliente || mergedMetadata.nombre_cliente === 'Cliente Desconocido') && old.nombre_cliente) {
                    mergedMetadata.nombre_cliente = old.nombre_cliente;
                }
                if (!mergedMetadata.creado_por && old.creado_por) mergedMetadata.creado_por = old.creado_por;
                if (!mergedMetadata.asunto && old.asunto) mergedMetadata.asunto = old.asunto;

                // Preservar trazabilidad / escalamiento
                if (old.current_level !== undefined) mergedMetadata.current_level = old.current_level;
                if (old.last_escalation_at) mergedMetadata.last_escalation_at = old.last_escalation_at;

                // Preservar campos CRM propios (no existen en WispHub):
                // sin esto el sync borra el estado del flujo de validación y el progreso del técnico
                // NOTA: id_estado NO está aquí — ese campo viene de WispHub y debe actualizarse con él.
                const CRM_FIELDS = [
                    'started_at',
                    'pending_validation', 'validation_requested_at',
                    'validation_rejected', 'validation_rejected_note',
                    'validation_rejected_at', 'validation_rejected_by',
                ] as const;
                for (const field of CRM_FIELDS) {
                    if (old[field] !== undefined) mergedMetadata[field] = old[field];
                }
            }

            const { data: process, error: pErr } = await supabase
                .from('workflow_processes')
                .upsert({
                    reference_id: ticketIdStr,
                    title: `${mergedMetadata.asunto || 'Ticket'} - ${mergedMetadata.nombre_cliente || 'Cliente'}`,
                    status: finalStatus,
                    process_type: 'Ticket AXCES',
                    metadata: mergedMetadata,
                    updated_at: new Date().toISOString()
                }, { onConflict: 'reference_id' })
                .select()
                .single();

            if (pErr) throw pErr;

            // AHORA validamos perfil. Si no existe, al menos ya actualizamos la metadata del proceso
            // para que "Limpieza de Identidad" lo borre del usuario anterior.
            if (!profile || !isUUID(profile.id)) {
                return;
            }

            // 4. Actualizar nivel en metadata si es nuevo o el perfil tiene un nivel definido
            // Si el ticket ya tiene un nivel (porque fue escalado), lo respetamos.
            // Si no tiene, o es el primer sync, tomamos el nivel del técnico (0 o 1).
            const currentMetadataLevel = process?.metadata?.current_level;
            const profileLevel = profile.operational_level;

            // Si el ticket no tiene nivel O está en fase inicial (0 o 1) y el perfil es diferente
            const isInitialPhase = currentMetadataLevel === undefined || [0, 1].includes(currentMetadataLevel);
            const needsUpdate = isInitialPhase && profileLevel !== undefined && currentMetadataLevel !== profileLevel;

            if (needsUpdate) {
                await supabase
                    .from('workflow_processes')
                    .update({
                        metadata: {
                            ...process.metadata,
                            current_level: profileLevel
                        }
                    })
                    .eq('id', process.id);
            }

            // 5. Upsert Actividad (Paso Actual)
            const { data: activity, error: aErr } = await supabase
                .from('workflow_activities')
                .upsert({
                    process_id: process.id,
                    name: 'Gestión de Ticket',
                    status: finalStatus === 'PE' ? 'Active' : 'Completed',
                    activity_type: 'task',
                    updated_at: new Date().toISOString()
                }, { onConflict: 'process_id,activity_type' })
                .select()
                .single();

            if (aErr) throw aErr;

            // 5. Upsert Workitem (SOLO SI AUTO-ASSIGN O SI YA EXISTE)
            // Esto evita que tickets nuevos en WispHub "salten" al técnico sin intervención manual en la App
            // 5. Upsert Workitem (SOLO SI AUTO-ASSIGN O SI YA EXISTE)
            // Esto evita que tickets nuevos en WispHub "salten" al técnico sin intervención manual en la App
            const { data: existingWorkItem } = await supabase
                .from('workflow_workitems')
                .select('id, status')
                .eq('activity_id', activity.id)
                .eq('participant_id', profile.id)
                .maybeSingle();

            if (options.autoAssign || existingWorkItem) {
                // [CRITICAL FIX] Protección de estado 'SS' (Solved/Submitted)
                // Si WispHub dice 'PE' (Pending) pero nosotros tenemos 'SS', significa que 
                // acabamos de finalizarlo y la API de WispHub nos está devolviendo datos viejos (stale).
                // En este caso, PRESERVAMOS 'SS' para que no reaparezca en la UI.
                // EXCEPCIÓN: Si forceLocalOverride es true (Deep Sync), confiamos en WispHub.
                let statusToSave: string = finalStatus;

                // No proteger SS si el proceso tiene validation_rejected — el rechazo ya reabrió el workitem
                const validationRejected = existingProcess?.metadata?.validation_rejected === true;
                const shouldProtectLocalState = !options.forceLocalOverride && existingWorkItem?.status === 'SS' && finalStatus === 'PE' && !validationRejected;

                if (shouldProtectLocalState) {
                    console.log(`[Sync] 🛡️ Protecting local 'SS' status for WorkItem ${existingWorkItem.id} against stale WispHub 'PE'.`);
                    statusToSave = 'SS'; // Mantenemos estado de "Enviado/Resuelto"
                } else if (options.forceLocalOverride && existingWorkItem?.status === 'SS' && finalStatus === 'PE') {
                    console.log(`[Sync] ⚠️ Deep Sync FORCE: Overriding local 'SS' with WispHub 'PE'.`);
                }

                const { error: wErr } = await supabase
                    .from('workflow_workitems')
                    .upsert({
                        activity_id: activity.id,
                        participant_id: profile.id,
                        participant_type: 'user',
                        status: statusToSave,
                        updated_at: new Date().toISOString()
                    }, { onConflict: 'activity_id,participant_id' });

                if (wErr) throw wErr;
            }

            // 6. LIMPIEZA AGRESIVA: Si el ticket cambió de dueño, reasignamos las otras tareas PE
            if (finalStatus === 'PE') {
                await supabase
                    .from('workflow_workitems')
                    .update({
                        status: 'RE', // Reasignado
                        updated_at: new Date().toISOString()
                    })
                    .eq('activity_id', activity.id)
                    .neq('participant_id', profile.id)
                    .eq('status', 'PE');
            }
        } catch (error) {
            /* console.error(`[Sync-Ticket] ❌ Error en ticket ${ticket.id}:`, error); */
        }
    },

    async syncGlobalTickets(daysBack: number = 30, onProgress?: (current: number, total: number) => void) {
        try {
            console.log(`[GlobalSync] 🌍 Iniciando sincronización global...`);

            // 1a. Tickets ABIERTOS: sin límite de fecha para capturar todos, sin importar antigüedad
            const openTickets = await WisphubService.getAllTickets({ status: '1,2,5' }, onProgress);
            console.log(`[GlobalSync] 📬 Tickets abiertos recibidos: ${openTickets.length}`);

            // 1b. Tickets CERRADOS: solo los últimos daysBack días (no necesitamos todo el historial)
            const pastDate = new Date();
            pastDate.setDate(pastDate.getDate() - daysBack);
            const startDateStr = pastDate.toISOString().split('T')[0];
            const closedTickets = await WisphubService.getAllTickets({ startDate: startDateStr, status: '3,4' }, onProgress);
            console.log(`[GlobalSync] 📪 Tickets cerrados recientes: ${closedTickets.length}`);

            // Deduplicar por ID (por si algún ticket aparece en ambas listas)
            const allMap = new Map<string, any>();
            [...openTickets, ...closedTickets].forEach(t => allMap.set(String(t.id), t));
            const allApiTickets = Array.from(allMap.values());

            console.log(`[GlobalSync] 📦 Total a sincronizar: ${allApiTickets.length} tickets de WispHub.`);

            // 2. Upsert Masivo en paralelo (lotes de 8 tickets simultáneos)
            const allProfiles = await this.getPlatformUsers();
            const PARALLEL = 8;
            for (let i = 0; i < allApiTickets.length; i += PARALLEL) {
                const batch = allApiTickets.slice(i, i + PARALLEL);
                await Promise.all(batch.map(ticket =>
                    this.syncSingleTicketMirror(ticket, allProfiles, undefined, { autoAssign: false })
                ));
                if (onProgress) onProgress(Math.min(i + PARALLEL, allApiTickets.length), allApiTickets.length);
            }

            console.log("[GlobalSync] ✅ Sincronización Global COMPLETADA.");
            return true;
        } catch (error) {
            console.error("[GlobalSync] 🚨 Error en syncGlobalTickets:", error);
            return false;
        }
    },

    async syncWithWispHub(forceFull: boolean = false) {
        return this.syncMyTickets(forceFull);
    },

    /**
     * Sincronización PROFUNDA del Espejo Local.
     * 1. Trae tickets nuevos (syncGlobalTickets).
     * 2. Purga cerrados y corrige técnicos (silentDetectiveSync).
     */
    async fullMirrorResync(onProgress?: (current: number, total: number) => void): Promise<boolean> {
        try {
            console.log('[FullSync] 🚀 Iniciando Resincronización Profunda del Espejo...');
            
            // Paso 1: Traer lo nuevo/actualizado de los últimos 60 días (acorde a nueva política)
            await this.syncGlobalTickets(60, onProgress);
            
            // Paso 2: Purga estricta de "fantasmas" re-revisando contra WispHub
            await this.silentDetectiveSync({ force: true });
            
            console.log('[FullSync] ✨ Espejo local actualizado y purgado.');
            return true;
        } catch (error) {
            console.error('[FullSync] ❌ Error en sincronización profunda:', error);
            return false;
        }
    },

    async changeWispHubTechnician(ticketId: string, supabaseUserId: string, options: { priority?: number, file?: File | Blob, descripcion?: string } = {}) {
        try {
            console.log(`[WispHub] 🔄 Iniciando sincronización FULL PUT para Ticket ${ticketId}...`);

            // 1. Obtener perfil
            const { data: profile } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', supabaseUserId)
                .single();

            if (!profile) {
                console.error(`[WispHub] 🛑 Error: No se encontró perfil para el usuario ${supabaseUserId}`);
                return false;
            }

            let finalWhId: string | number | undefined = profile.wisphub_id;

            // 2. Resolver ID Numérico (Necesario para persistencia efectiva en WispHub)
            try {
                const staff = await WisphubService.getStaff();
                const foundInStaff = staff.find(s =>
                    (profile.wisphub_id && s.usuario === profile.wisphub_id) ||
                    (profile.email && s.email === profile.email) ||
                    (profile.full_name && normalize(s.nombre).includes(normalize(profile.full_name))) ||
                    (profile.full_name && normalize(profile.full_name).includes(normalize(s.nombre)))
                );

                if (foundInStaff) {
                    console.log(`[WispHub] ✅ Técnico resuelto en Staff -> ID: ${foundInStaff.id}`);
                    finalWhId = foundInStaff.id;
                }
            } catch (staffErr) {
                console.error('[WispHub] Error consultando lista de Staff:', staffErr);
            }

            if (!finalWhId) {
                console.error(`[WispHub] 🛑 Error: No se pudo determinar el ID numérico de WispHub para ${profile.full_name}`);
                return false;
            }

            // 3. Obtener Datos Actuales — primero del espejo local, luego WispHub como fallback
            let rawTicket: any = null;
            try {
                const { data: mirrorRow } = await supabase
                    .from('workflow_processes')
                    .select('metadata')
                    .eq('reference_id', String(ticketId))
                    .eq('process_type', 'Ticket AXCES')
                    .maybeSingle();
                if (mirrorRow?.metadata) {
                    rawTicket = mirrorRow.metadata;
                    console.log(`[WispHub] 📦 Ticket ${ticketId} obtenido del espejo local.`);
                }
            } catch { /* ok, usamos WispHub */ }

            if (!rawTicket) {
                rawTicket = await WisphubService.getTicketRaw(ticketId);
            }

            if (!rawTicket) {
                console.error(`[WispHub] 🛑 Error: No se pudo obtener el ticket ${ticketId} para actualización completa.`);
                return false;
            }

            // 4. Mapeo de Etiquetas a IDs (WispHub PUT es sumamente estricto)
            const priorityMap: Record<string, number> = { "Baja": 1, "Normal": 2, "Media": 2, "Alta": 3, "Muy Alta": 4 };
            const statusMap: Record<string, number> = { "Nuevo": 1, "Abierto": 1, "En Progreso": 2, "Resuelto": 3, "Cerrado": 4 };

            // 4b. Validar Asunto (WispHub rechaza si asuntos_default no está en su catálogo)
            const validSubjects = (WisphubService as any).TICKET_SUBJECTS || [];
            const currentAsunto = rawTicket.asunto || "Otro Asunto";
            const isAsuntoValid = validSubjects.some((s: string) => s.toLowerCase() === currentAsunto.toLowerCase());
            const safeAsunto = isAsuntoValid ? currentAsunto : (validSubjects[0] || "Otro Asunto");

            // 5. Construir Payload Completo (PUT LIMPIO - descripción sin HTML + trazabilidad)
            const cleanBase = stripHtml(rawTicket.descripcion || ".");
            const finalDescription = options.descripcion
                ? `${cleanBase}\n\n${options.descripcion}`.trim()
                : cleanBase;

            const payload = {
                servicio: rawTicket.servicio?.id_servicio || rawTicket.servicio?.id || rawTicket.servicio,
                asunto: currentAsunto,
                asuntos_default: safeAsunto,
                descripcion: finalDescription,
                prioridad: options.priority || priorityMap[rawTicket.prioridad] || 2,
                estado: statusMap[rawTicket.estado] || 1,
                tecnico: Number(finalWhId),
                departamento: rawTicket.departamento || "Soporte Técnico",
                departamentos_default: rawTicket.departamento || "Soporte Técnico",
                archivo_ticket: options.file
            };

            // 6. Ejecutar PUT
            const success = await WisphubService.updateTicket(ticketId, payload, 'PUT');

            if (success) {
                console.log(`[WispHub] 🚀 REASIGNACIÓN EXITOSA (Full PUT) para Ticket ${ticketId}`);

                // --- 7. MAGIA BIDIRECCIONAL (DISPARO DE WEBSOCKETS LOCALES) ---
                try {
                    console.log(`[LocalSync] 🔄 Reflejando asignación de Ticket ${ticketId} a Perfil ${supabaseUserId} localmente...`);

                    // Buscamos si existe el proceso para amarrarlo a la actividad activa
                    const { data: existingProcess } = await supabase
                        .from('workflow_processes')
                        .select('id, workflow_activities(id, status)')
                        .eq('reference_id', String(ticketId))
                        .maybeSingle();

                    if (existingProcess) {
                        // Encontrar la 'Actividad' Activa de ese ticket
                        const activeActivity = existingProcess.workflow_activities?.find((a: any) => a.status === 'Active')
                            || existingProcess.workflow_activities?.[0];

                        if (activeActivity) {
                            // 7.1 Limpiar (Reasignar/Desvincular) al usuario anterior
                            await supabase
                                .from('workflow_workitems')
                                .update({ status: 'RE', updated_at: new Date().toISOString() })
                                .eq('activity_id', activeActivity.id)
                                .neq('participant_id', supabaseUserId)
                                .eq('status', 'PE');

                            // 7.2 Asignar / Upsertar al NUEVO usuario
                            await supabase
                                .from('workflow_workitems')
                                .upsert({
                                    activity_id: activeActivity.id,
                                    participant_id: supabaseUserId,
                                    participant_type: 'user',
                                    status: 'PE', // Pendiente = Tarea Viva
                                    updated_at: new Date().toISOString()
                                }, { onConflict: 'activity_id,participant_id' });

                            console.log(`[LocalSync] ✅ WorkItem actualizado. WebSocket disparado a ${profile.full_name || supabaseUserId} 🚀`);
                        }
                    } else {
                        // Si no existe localmente, lanzamos un DeepSync forzado a nombre de él para descargarlo
                        console.log(`[LocalSync] ⚠️ El Ticket ${ticketId} no existe localmente. Lanzando Sync Inmediato y Forzando Inserción Local...`);

                        // 1. Crear el Proceso Mínimo Viable (Metadata Básica)
                        const { data: newProcess, error: pErr } = await supabase
                            .from('workflow_processes')
                            .upsert({
                                reference_id: String(ticketId),
                                title: `${rawTicket.asunto || 'Ticket'} - ${rawTicket.nombre_cliente || 'Cliente'}`,
                                status: 'PE',
                                process_type: 'Ticket AXCES',
                                metadata: { ...rawTicket, current_level: profile.operational_level || 1 },
                                updated_at: new Date().toISOString()
                            }, { onConflict: 'reference_id' })
                            .select()
                            .single();

                        if (newProcess && !pErr) {
                            // 2. Crear Actividad
                            const { data: newActivity, error: aErr } = await supabase
                                .from('workflow_activities')
                                .upsert({
                                    process_id: newProcess.id,
                                    name: 'Gestión de Ticket',
                                    status: 'Active',
                                    activity_type: 'task',
                                    updated_at: new Date().toISOString()
                                }, { onConflict: 'process_id,activity_type' })
                                .select()
                                .single();

                            if (newActivity && !aErr) {
                                // 3. ¡EL GATILLO DEL WEBSOCKET! Crear el WorkItem para el Técnico
                                await supabase
                                    .from('workflow_workitems')
                                    .upsert({
                                        activity_id: newActivity.id,
                                        participant_id: supabaseUserId, // UUID local exacto
                                        participant_type: 'user',
                                        status: 'PE',
                                        updated_at: new Date().toISOString()
                                    }, { onConflict: 'activity_id,participant_id' });

                                console.log(`[LocalSync] 🎯 INYECCIÓN FORZADA EXITOSA. WebSocket disparado a ${profile.full_name || supabaseUserId} 🚀`);
                            }
                        }

                        // Por seguridad, dejamos que el mirror haga lo suyo detrás de escena
                        this.syncSingleTicketMirror(rawTicket, [profile], profile, { autoAssign: true, forceLocalOverride: true });
                    }
                } catch (localSyncErr) {
                    console.error('[LocalSync] ❌ Fallo al reflejar asignación local (El WebSocket no saltó):', localSyncErr);
                }

                return true;
            }
            return false;
        } catch (e) {
            console.error('[WispHub] ❌ Error crítico en changeWispHubTechnician:', e);
            return false;
        }
    },

    // --- AUDITORÍA DE DESPACHO ---
    async logDispatchBatch(technicianCount: number, ticketCount: number, metadata: any = {}) {
        try {
            const { data: { user } } = await safeGetUser();
            if (!user) {
                console.error('[logDispatchBatch] 🛑 Error: No hay sesión de usuario activa (user is null).');
                return false;
            }

            const { error } = await supabase.from('dispatch_events').insert({
                user_id: user.id,
                technician_count: technicianCount,
                total_tickets: ticketCount,
                metadata
            });

            if (error) {
                console.error('[logDispatchBatch] ❌ Error de Supabase al insertar:', error.message, error.details);
                return false;
            }

            console.log(`[logDispatchBatch] ✅ Auditoría guardada: ${ticketCount} tickets / ${technicianCount} técnicos`);
            return true;
        } catch (e) {
            console.error('[logDispatchBatch] Error crítico:', e);
            return false;
        }
    },

    // --- SISTEMA DE DESPACHO INTELIGENTE (NOC) ---

    /**
     * Calcula el Dispatch Score para un ticket basado en prioridad, SLA y recurrencia.
     * @param preCalculatedRecurrence Opcional. Si se pasa, evita la consulta a la BD.
     */
    async calculateDispatchScore(ticket: any, preCalculatedRecurrence?: number): Promise<number> {
        let score = 0;

        // 1. Prioridad (Peso Crítico)
        const priorityWeights: Record<number, number> = {
            1: 5,   // Baja
            2: 20,  // Normal
            3: 50,  // Alta
            4: 100, // Muy Alta
            5: 150  // Crítica
        };
        score += priorityWeights[ticket.id_prioridad] || 20;

        // 2. Antigüedad (SLA) - 1 punto por hora abierto
        const hoursOpen = ticket.horas_abierto || 0;
        score += hoursOpen;

        // 3. Recurrencia (Visitas en el mes)
        // Optimization: Use pre-calculated value if available to avoid N+1 DB calls
        let recurrence = preCalculatedRecurrence;

        if (recurrence === undefined) {
            const serviceId = ticket.servicio;
            if (serviceId) {
                const now = new Date();
                recurrence = await this.getClientRecurrence(String(serviceId), now.getFullYear(), now.getMonth() + 1);
            } else {
                recurrence = 0;
            }
        }

        if (recurrence > 1) {
            // Penalización/Prioridad por cada visita adicional
            score += (recurrence - 1) * 60;
        }

        return score;
    },

    /**
     * Obtiene la cantidad de tickets/procesos para un cliente en un mes específico.
     */
    async getClientRecurrence(clientId: string, year: number, month: number): Promise<number> {
        const { data, error } = await supabase
            .rpc('get_client_visit_count', {
                p_client_id: clientId,
                p_year: year,
                p_month: month
            });

        if (error) {
            console.error('[Dispatch] Error calculando recurrencia:', error);
            return 0;
        }
        return data || 0;
    },

    /**
     * Obtiene el conteo de visitas para múltiples clientes en una sola llamada (Batch Optimization).
     */
    async getClientsVisitCountsBatch(clientIds: string[], year: number, month: number): Promise<Record<string, number>> {
        if (!clientIds || clientIds.length === 0) return {};

        // Limpieza de IDs nulos
        const safeIds = clientIds.filter(id => id && id !== '0' && id !== '');
        if (safeIds.length === 0) return {};

        const { data, error } = await supabase
            .rpc('get_clients_visit_counts_batch', {
                p_client_ids: safeIds,
                p_year: year,
                p_month: month
            });

        if (error) {
            // FALLBACK SILENCIOSO: Si falla el RPC (ej. aún no existe), retornamos vacío para no romper la app
            console.warn('[Dispatch] Batch RPC not available or failed. Returning empty counts.', error.message);
            return {};
        }

        // Convertir array de resultados a Mapa rápido
        const counts: Record<string, number> = {};
        if (data && Array.isArray(data)) {
            data.forEach((item: any) => {
                counts[item.client_id] = item.visit_count;
            });
        }
        return counts;
    },

    /**
     * Obtiene la georreferenciación de un barrio desde la base de datos local.
     */
    async getNeighborhoodGeoref(name: string) {
        if (!name) return null;
        const { data, error } = await supabase
            .from('op_neighborhoods_georef')
            .select('*')
            .eq('name', name)
            .maybeSingle();

        if (error) {
            console.error('[Dispatch] Error obteniendo georef de barrio:', error);
            return null;
        }
        return data; // Contiene lat, lng, etc.
    },

    /**
     * Normaliza y guarda un barrio en el catálogo maestro (operación administrativa).
     */
    async saveNeighborhoodGeoref(data: { name: string, latitude: number, longitude: number, city?: string }) {
        const { error } = await supabase
            .from('op_neighborhoods_georef')
            .upsert({
                name: data.name,
                latitude: data.latitude,
                longitude: data.longitude,
                city: data.city || 'Desconocida',
                updated_at: new Date().toISOString()
            }, { onConflict: 'name' });

        return !error;
    },

    /**
     * Sincroniza el catálogo de barrios cruzando los datos de clientes de WispHub.
     */
    async syncNeighborhoodsWithClients() {
        try {
            const whBarrios = await WisphubService.getAllClientsBarrios();
            if (!whBarrios || whBarrios.length === 0) return { success: false, count: 0 };

            console.log(`[Workflow] Sincronizando ${whBarrios.length} candidatos de barrios...`);

            let newCount = 0;
            for (const item of whBarrios) {
                // Solo insertamos si no existe (no queremos sobreescribir coordenadas manuales con promedios de WH si ya existen)
                const { data: existing } = await supabase
                    .from('op_neighborhoods_georef')
                    .select('name')
                    .eq('name', item.name)
                    .maybeSingle();

                if (!existing) {
                    const { error } = await supabase
                        .from('op_neighborhoods_georef')
                        .insert({
                            name: item.name,
                            latitude: item.latitude || 0,
                            longitude: item.longitude || 0,
                            city: 'Detectada'
                        });

                    if (!error) newCount++;
                }
            }

            return { success: true, count: newCount };
        } catch (error) {
            console.error('[Workflow] Error en syncNeighborhoodsWithClients:', error);
            return { success: false, count: 0 };
        }
    },

    /**
     * Elimina un barrio del catálogo.
     */
    async deleteNeighborhood(name: string) {
        const { error } = await supabase
            .from('op_neighborhoods_georef')
            .delete()
            .eq('name', name);

        return !error;
    },

    /**
     * Obtiene todos los barrios del catálogo con sus estadísticas.
     */
    async getAllNeighborhoods() {
        const { data, error } = await supabase
            .from('op_neighborhoods_georef')
            .select('*')
            .order('name', { ascending: true });

        if (error) {
            console.error('[Workflow] Error obteniendo barrios:', error);
            return [];
        }
        return data;
    }
};
