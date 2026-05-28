import { useState, useEffect, useRef } from 'react';
import { CheckCircle2, Clock, ChevronRight, X, MessageSquare, AlertTriangle, AlertCircle, RefreshCw, Layers, Package, MapPin, Play, Camera, Trash2, Activity, Navigation, Zap } from 'lucide-react';
import { supabase, safeGetUser } from '../lib/supabase';
import { WorkflowService, REQUIREMENTS } from '../lib/workflowService';
import { WisphubService } from '../lib/wisphub';
import { WisphubCache } from '../lib/wisphubCache';
import { SmartOLTService } from '../lib/smartolt';
import { convertToJpeg, type ImageMetadata } from '../lib/imageUtils';
import { syncQueueService } from '../lib/syncQueueService';
import { draftService } from '../lib/draftService';
import { geoService } from '../lib/geoService';
import { orgService } from '../lib/orgService';
import { OperationsHeader } from '../components/operations/OperationsHeader';
import { EditTicketModal } from '../components/operations/EditTicketModal';
import { MaterialSelector } from '../components/operations/MaterialSelector';
import { canEditTicket, canEscalateTicket } from '../lib/permissions';
import clsx from 'clsx';

// Mapa de sugerencias de escalamiento por tipo de ticket
const ESCALATION_ROUTES: Record<string, { hint: string; preferredLevel: number; color: string }> = {
    'INSTALACION': { hint: 'Instalación → Supervisor Técnico', preferredLevel: 2, color: 'blue' },
    'FIBRA': { hint: 'Falla de Fibra → Nivel 2 / Redes', preferredLevel: 2, color: 'orange' },
    'SIN INTERNET': { hint: 'Sin Internet → Soporte Avanzado N2', preferredLevel: 2, color: 'red' },
    'ROUTER': { hint: 'Falla de Router → Técnico de Equipos', preferredLevel: 1, color: 'yellow' },
    'CABLE': { hint: 'Cableado → Técnico de Infraestructura', preferredLevel: 1, color: 'yellow' },
    'FACTURACION': { hint: 'Facturación → Área Administrativa', preferredLevel: 3, color: 'purple' },
    'SUSPENSION': { hint: 'Suspensión → Área Administrativa', preferredLevel: 3, color: 'purple' },
};

const getEscalationSuggestion = (asunto: string) => {
    const upper = (asunto || '').toUpperCase();
    for (const [key, val] of Object.entries(ESCALATION_ROUTES)) {
        if (upper.includes(key)) return val;
    }
    return null;
};
const dispatchToast = (message: string, type: 'success' | 'error' | 'info' | 'loading', description?: string, id?: string) => {
    window.dispatchEvent(new CustomEvent('app:toast', {
        detail: { message, type, description, id, duration: type === 'loading' ? 0 : 4000 }
    }));
};

export function OperationsMyTasks() {
    const [loading, setLoading] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [myTasks, setMyTasks] = useState<any[]>([]);
    const [selectedTask, setSelectedTask] = useState<any | null>(null);
    const [actionType, setActionType] = useState<'complete' | 'escalate' | 'validate' | null>(null);
    const [comment, setComment] = useState('');
    const [signal, setSignal] = useState(''); // Potencia Óptica
    const [targetTechnician, setTargetTechnician] = useState('');
    const [processing, setProcessing] = useState(false);
    const [platformUsers, setPlatformUsers] = useState<any[]>([]);
    const [evidenceFiles, setEvidenceFiles] = useState<File[]>([]);
    const [priority, setPriority] = useState<number>(2);
    const [finalStatus, setFinalStatus] = useState<number>(4); // 4=Cerrado, 3=Resuelto
    const [technicianStock, setTechnicianStock] = useState<any[]>([]);
    const [selectedMaterials, setSelectedMaterials] = useState<Record<string, number>>({});
    const [timelineStatus, setTimelineStatus] = useState<Record<string, { started?: boolean, arrived?: boolean }>>(() => {
        const saved = localStorage.getItem('tech_timeline_v1');
        return saved ? JSON.parse(saved) : {};
    });
    const [activeSubTab, setActiveSubTab] = useState<'nueva' | 'en_progreso'>('nueva');
    const [pendingSyncCount, setPendingSyncCount] = useState(0);
    const [userProfile, setUserProfile] = useState<any | null>(null); // RBAC State
    // ticketId del ticket cuyo botón de acción está en progreso (Iniciar / Llegada)
    const [actioningTicket, setActioningTicket] = useState<string | null>(null);
    // UUID de Supabase del técnico actual — se guarda una vez al cargar tareas
    const currentUserIdRef = useRef<string | null>(null);
    // IDs de workflow_processes pertenecientes a este técnico — para filtrar eventos Realtime
    const myProcessIdsRef = useRef<Set<string>>(new Set());
    const [companyName, setCompanyName] = useState<string>('ISP Reports');
    const [isEditModalOpen, setIsEditModalOpen] = useState(false); // Edit Modal State
    const [expandedTickets, setExpandedTickets] = useState<Set<string>>(new Set());
    const [manualTicketId, setManualTicketId] = useState('');
    const [customerHistory, setCustomerHistory] = useState<{ tickets: any[]; clientName: string; ticketId: string } | null>(null);
    const [showHistoryModal, setShowHistoryModal] = useState(false);
    const [historyFilter, setHistoryFilter] = useState('');
    const [historyDetails, setHistoryDetails] = useState<Record<string, { respuestas_tecnico: any[]; loaded: boolean }>>({});
    const historyAbortRef = useRef(false);
    const [signalAutoFetching, setSignalAutoFetching] = useState(false);
    const [signalAutoFailed, setSignalAutoFailed] = useState(false);
    const [smartoltTrigger, setSmartoltTrigger] = useState(0);
    const smartoltRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // --- SISTEMA DE BORRADORES (IndexedDB) ---
    // 1. Guardar fotos automáticamente cuando cambian
    useEffect(() => {
        if (selectedTask?.workflow_activities?.workflow_processes?.reference_id && evidenceFiles.length > 0) {
            const ticketId = selectedTask.workflow_activities.workflow_processes.reference_id;
            console.log(`[Drafts] 💾 Guardando borrador para Ticket #${ticketId} (${evidenceFiles.length} fotos)`);
            draftService.saveDraft(String(ticketId), evidenceFiles).catch(err => {
                console.error("[Drafts] Error guardando borrador:", err);
            });
        }
    }, [evidenceFiles, selectedTask]);

    // 2. Recuperar borrador al seleccionar tarea — siempre limpia fotos del ticket anterior
    useEffect(() => {
        setEvidenceFiles([]);
        if (selectedTask?.workflow_activities?.workflow_processes?.reference_id) {
            const ticketId = selectedTask.workflow_activities.workflow_processes.reference_id;
            draftService.getDraft(String(ticketId)).then(files => {
                if (files && files.length > 0) {
                    console.log(`[Drafts] 📦 Borrador recuperado para Ticket #${ticketId}: ${files.length} fotos`);
                    setEvidenceFiles(files);
                    dispatchToast("Borrador recuperado", "info", `Se cargaron ${files.length} fotos pendientes.`);
                }
            }).catch(err => {
                console.error("[Drafts] Error recuperando borrador:", err);
            });
        }
    }, [selectedTask]);

    // 3. Auto-query SmartOLT al abrir modal de finalización (3 reintentos con backoff)
    useEffect(() => {
        if ((actionType !== 'complete' && actionType !== 'validate') || !selectedTask) return;

        // Limpiar retries anteriores
        if (smartoltRetryRef.current) clearTimeout(smartoltRetryRef.current);
        setSignalAutoFetching(false);
        setSignalAutoFailed(false);
        setSignal('');

        const meta = selectedTask.workflow_activities?.workflow_processes?.metadata || {};
        const svc  = typeof meta.servicio === 'object' ? meta.servicio : (meta.servicio_completo || {});

        const extractSn = (obj: any): string =>
            (obj?.sn_onu || obj?.onu_serial || obj?.serial_onu || obj?.serial ||
             obj?.sn || obj?.numero_serie || obj?.onu_sn || obj?.serial_number || '').toString().trim();

        let sn = extractSn(meta) || extractSn(svc);

        let attempt = 0;
        const MAX_ATTEMPTS = 3;

        const query = async (resolvedSn: string) => {
            setSignalAutoFetching(true);
            try {
                const result = await SmartOLTService.getOnuSignal(resolvedSn);
                if (result?.rx !== null && result?.rx !== undefined) {
                    setSignal(String(result.rx));
                    setSignalAutoFailed(false);
                    console.log(`[SmartOLT] Señal obtenida: ${result.rx} dBm | SN: ${resolvedSn}`);
                } else {
                    throw new Error('No signal data');
                }
            } catch {
                attempt++;
                if (attempt < MAX_ATTEMPTS) {
                    const delay = 2000 * attempt;
                    smartoltRetryRef.current = setTimeout(() => query(resolvedSn), delay);
                } else {
                    console.warn('[SmartOLT] Todos los intentos fallaron.');
                    setSignalAutoFailed(true);
                }
            } finally {
                setSignalAutoFetching(false);
            }
        };

        if (sn) {
            query(sn);
        } else {
            // SN no está en la metadata del ticket — buscarlo en el detalle del servicio (cliente WispHub)
            const svcId = String(meta.id_servicio || (typeof meta.servicio !== 'object' ? meta.servicio : '') || '');
            if (!svcId) { setSignalAutoFailed(true); return; }

            setSignalAutoFetching(true);
            WisphubService.getServiceDetail(svcId)
                .then((detail: any) => {
                    // El detalle del servicio puede traer el equipo ONU en distintos campos
                    const snFromSvc = extractSn(detail) || extractSn(detail?.onu) || extractSn(detail?.equipo);
                    console.log('[SmartOLT] SN desde servicio:', snFromSvc || '(no encontrado)', '| keys:', detail ? Object.keys(detail).filter((k: string) => /sn|serial|onu|equipo/i.test(k)) : []);
                    if (snFromSvc) {
                        query(snFromSvc);
                    } else {
                        setSignalAutoFailed(true);
                        setSignalAutoFetching(false);
                    }
                })
                .catch(() => { setSignalAutoFailed(true); setSignalAutoFetching(false); });
        }

        return () => {
            if (smartoltRetryRef.current) clearTimeout(smartoltRetryRef.current);
        };
    }, [actionType, selectedTask, smartoltTrigger]);

    const toggleTicketExpansion = (id: string) => {
        const newSet = new Set(expandedTickets);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setExpandedTickets(newSet);
    };


    // Función principal: Cargar tareas desde Supabase
    const loadMyTasks = async () => {
        setLoading(true);
        try {
            console.log('\n=======================================');
            console.log('[MyTasks] 1. INICIANDO CARGA DE TAREAS');
            const { data: { user }, error: authError } = await safeGetUser();

            if (authError || !user) {
                console.warn('[MyTasks] ❌ No hay usuario autenticado. Cancelando.');
                return;
            }

            // Inicializar encriptación de borradores con la clave del técnico
            await draftService.init(user.id);

            // Perfil COMPLETO: necesitamos wisphub_id para el matching por nombre
            const { data: profile, error: profileError } = await supabase
                .from('profiles')
                .select('id, full_name, wisphub_id, email')
                .eq('id', user.id)
                .maybeSingle();

            if (profileError && (profileError.message?.includes('aborted') || (profileError as any).name === 'AbortError')) {
                console.warn('[MyTasks] ⚠️ Perfil abortado. Reintentando después...');
                return;
            }

            let finalProfile = profile;
            if (!finalProfile && user.email) {
                const { data: ep } = await supabase
                    .from('profiles')
                    .select('id, full_name, wisphub_id, email')
                    .eq('email', user.email)
                    .maybeSingle();
                if (ep) finalProfile = ep;
            }

            const participantId  = finalProfile?.id      || user.id;
            const wisphubMapping = String(finalProfile?.wisphub_id ?? '').trim();
            const userEmail      = String(finalProfile?.email ?? user.email ?? '').trim();
            const userFullName   = String(finalProfile?.full_name ?? '').trim();

            // Persistir UUID para uso en handleStartWork / handleArrival
            currentUserIdRef.current = participantId;

            // LOG DE DIAGNÓSTICO REQUERIDO
            console.log(`[MyTasks] Buscando tareas para el usuario: ${participantId} con mapping: "${wisphubMapping}"`);
            console.log(`[MyTasks] Email: "${userEmail}" | Nombre completo: "${userFullName}"`);

            // ── CONSULTA 1: workitems asignados directamente por UUID ─────────
            const { data: byParticipantRaw, error: wiError } = await supabase
                .from('workflow_workitems')
                .select(`
                    id, status, participant_id, created_at,
                    workflow_activities (
                        name,
                        workflow_processes (
                            id, title, reference_id, priority, metadata
                        )
                    )
                `)
                .eq('participant_id', participantId)
                .eq('status', 'PE')
                .order('created_at', { ascending: false });

            if (wiError) {
                if (wiError.message?.includes('aborted') || (wiError as any).name === 'AbortError') {
                    console.warn('[MyTasks] ⚠️ Consulta 1 abortada.');
                    return;
                }
                console.error('[MyTasks] ❌ Error consulta 1 (workitems):', wiError);
            }

            const byParticipant = byParticipantRaw || [];
            console.log(`[MyTasks] Consulta 1 (participant_id UUID): ${byParticipant.length} tickets`);

            // ── CONSULTA 2: procesos por nombre_tecnico / email_tecnico ────────
            // Cubre el caso donde el sync no pudo resolver el participant_id
            // pero el ticket SÍ tiene el nombre o email del técnico en metadata.
            // NOTA: no filtramos por strategic_location — un valor nulo no debe
            //       ocultar tareas. El campo puede no estar migrado aún.
            const nameConditions: string[] = [];
            if (wisphubMapping) nameConditions.push(`metadata->>nombre_tecnico.ilike.%${wisphubMapping}%`);
            if (userFullName)   nameConditions.push(`metadata->>nombre_tecnico.ilike.%${userFullName}%`);
            if (userEmail)      nameConditions.push(`metadata->>email_tecnico.ilike.%${userEmail}%`);

            let byName: any[] = [];

            if (nameConditions.length > 0) {
                console.log(`[MyTasks] Consulta 2 — condiciones OR: ${nameConditions.join(' | ')}`);

                const { data: procs } = await supabase
                    .from('workflow_processes')
                    .select(`
                        id, title, reference_id, priority, metadata, created_at,
                        workflow_activities (
                            name,
                            workflow_workitems (id, status, participant_id, created_at)
                        )
                    `)
                    .or(nameConditions.join(','))
                    .order('created_at', { ascending: false });

                // Solo procesos con workitem PE activo — excluye si el usuario ya escaló/completó
                const relevant = (procs || []).filter(proc => {
                    const wis = (proc.workflow_activities || []).flatMap((a: any) => a.workflow_workitems || []);
                    if (wis.length === 0) return true;
                    // Si el usuario tiene workitem terminal (SS=escalado, CO=completado, ST=timeout), excluir
                    const myTerminal = wis.find((wi: any) =>
                        wi.participant_id === participantId &&
                        (wi.status === 'SS' || wi.status === 'CO' || wi.status === 'ST')
                    );
                    if (myTerminal) return false;
                    return wis.some((wi: any) => wi.status === 'PE');
                });

                // Deduplicar contra Consulta 1 (evitar mostrar el mismo ticket dos veces)
                const coveredProcessIds = new Set(
                    byParticipant
                        .map((wi: any) => wi.workflow_activities?.workflow_processes?.id)
                        .filter(Boolean)
                );

                // Convertir al mismo shape que un workitem para que el sort funcione sin cambios
                byName = relevant
                    .filter(proc => !coveredProcessIds.has(proc.id))
                    .map(proc => {
                        const allWi = (proc.workflow_activities || []).flatMap((a: any) =>
                            (a.workflow_workitems || []).map((wi: any) => ({ ...wi, _actName: a.name }))
                        );
                        const peWi = allWi.find((wi: any) => wi.status === 'PE');
                        return {
                            id:             peWi?.id || `proc-${proc.id}`,
                            status:         'PE',
                            participant_id: peWi?.participant_id || participantId,
                            created_at:     peWi?.created_at || proc.created_at,
                            // Marca interna: este ticket llegó por matching de nombre, no por workitem UUID
                            __fromNameQuery: true,
                            __ownerId:       participantId,
                            workflow_activities: {
                                name: peWi?._actName || 'Tarea Asignada',
                                workflow_processes: {
                                    id:           proc.id,
                                    title:        proc.title,
                                    reference_id: proc.reference_id,
                                    priority:     proc.priority,
                                    metadata:     proc.metadata,
                                }
                            }
                        };
                    });

                console.log(`[MyTasks] Consulta 2 (nombre/email): ${relevant.length} coincidencias → ${byName.length} nuevas (sin duplicados)`);
            } else {
                console.warn('[MyTasks] ⚠️ Consulta 2 omitida: wisphub_id, full_name y email están vacíos');
            }

            const allTasks = [...byParticipant, ...byName];
            console.log(`[MyTasks] Total combinado: ${allTasks.length} tareas`);

            if (allTasks.length === 0) {
                console.warn('[MyTasks] Lista vacía. Verifica: ¿El campo wisphub_id del perfil coincide con metadata.nombre_tecnico de los tickets?');
            }

            // === Ordenamiento Inteligente: Prioridad > Sin Internet > Atrasados > Proximidad/Barrio > Fecha ===
            const officeCoords = geoService.getOfficeCoords();

            const sortedData = [...allTasks].sort((a, b) => {
                const getMeta = (t: any) => t.workflow_activities?.workflow_processes?.metadata || {};

                const getPrio = (t: any) => {
                    const p = getMeta(t).prioridad || 'Normal';
                    const map: Record<string, number> = { 'Muy Alta': 4, 'Alta': 3, 'Normal': 2, 'Media': 2, 'Baja': 1 };
                    return map[p] || 2;
                };

                const isSinInternet = (t: any) =>
                    (getMeta(t).asunto || '').toUpperCase().includes('SIN INTERNET');

                const isDelayed = (t: any) => {
                    const dt = new Date(getMeta(t).fecha_creacion || t.created_at);
                    const today = new Date(); today.setHours(0, 0, 0, 0);
                    return dt < today;
                };

                const getDistanceKm = (t: any): number => {
                    if (!officeCoords) return 0;
                    const lat = parseFloat(getMeta(t).latitud || getMeta(t).lat || '0');
                    const lng = parseFloat(getMeta(t).longitud || getMeta(t).lng || getMeta(t).lon || '0');
                    if (!lat && !lng) return 999; // Sin coordenadas va al final
                    return geoService.haversineKm(officeCoords, { lat, lng });
                };

                const getBarrio = (t: any) => (getMeta(t).barrio || 'ZZZ').toLowerCase().trim();
                const getDate = (t: any) => new Date(getMeta(t).fecha_creacion || t.created_at).getTime();

                // 1. Prioridad numérica (4 > 1)
                const pA = getPrio(a); const pB = getPrio(b);
                if (pA !== pB) return pB - pA;

                // 2. "Sin Internet" tiene precedencia explícita
                const siA = isSinInternet(a); const siB = isSinInternet(b);
                if (siA && !siB) return -1;
                if (!siA && siB) return 1;

                // 3. Atrasados van antes que los de hoy
                const dA = isDelayed(a); const dB = isDelayed(b);
                if (dA && !dB) return -1;
                if (!dA && dB) return 1;

                // 4a. Si hay coordenadas de oficina: ordenar por proximidad Haversine
                if (officeCoords) {
                    const distA = getDistanceKm(a); const distB = getDistanceKm(b);
                    if (Math.abs(distA - distB) > 0.2) return distA - distB; // Diferencia > 200m
                }

                // 4b. Sin coordenadas: agrupar por barrio (orden alfabético)
                const barA = getBarrio(a); const barB = getBarrio(b);
                if (barA < barB) return -1;
                if (barA > barB) return 1;

                // 5. Antigüedad: el más viejo primero
                return getDate(a) - getDate(b);
            });

            setMyTasks(sortedData);
            myProcessIdsRef.current = new Set(
                sortedData.map(t => t.workflow_activities?.workflow_processes?.id).filter(Boolean)
            );
            console.log(`[MyTasks] ✅ ${sortedData.length} tareas cargadas y ordenadas.`);
            console.log('=======================================\n');

            // Si hay alguna tarea rechazada, siempre ir a la pestaña En Progreso
            const hasRejected = sortedData.some(
                wi => wi.workflow_activities?.workflow_processes?.metadata?.validation_rejected
            );
            if (hasRejected) setActiveSubTab('en_progreso');

            // Toast de rechazo — solo una vez por rechazo (ack via localStorage)
            try {
                const ackRaw = localStorage.getItem('ack_rejections_v1');
                const ackSet = new Set<string>(ackRaw ? JSON.parse(ackRaw) : []);
                const newRejections = sortedData.filter(wi => {
                    const proc = wi.workflow_activities?.workflow_processes;
                    if (!proc?.metadata?.validation_rejected) return false;
                    const key = `${proc.id}:${proc.metadata.validation_rejected_at || 'x'}`;
                    return !ackSet.has(key);
                });
                if (newRejections.length > 0) {
                    newRejections.forEach(wi => {
                        const proc = wi.workflow_activities?.workflow_processes;
                        const key = `${proc.id}:${proc.metadata.validation_rejected_at || 'x'}`;
                        ackSet.add(key);
                        const note = proc?.metadata?.validation_rejected_note || 'Revisar trabajo';
                        dispatchToast('Validación rechazada', 'error', `Motivo: ${note}`);
                    });
                    localStorage.setItem('ack_rejections_v1', JSON.stringify([...ackSet]));
                }
            } catch { /* no bloquear */ }

            // Guardamos el perfil completo para RBAC
            if (finalProfile) {
                const { data: fullProfile } = await supabase.from('profiles').select('*').eq('id', finalProfile.id).maybeSingle();
                if (fullProfile) setUserProfile(fullProfile);
            }
            orgService.getCompanyName().then(name => setCompanyName(name));

        } catch (error) {
            console.error('[MyTasks] ❌ Error general en loadMyTasks:', error);
        } finally {
            setLoading(false);
        }
    };


    // Función para sincronización profunda (30 días)
    const handleDeepSync = async () => {
        if (syncing) return;
        setSyncing(true);
        try {
            console.log('[MyTasks] 🚀 Iniciando Sincronización Profunda (30 días)...');
            await WorkflowService.syncMyTickets(true);
            await loadMyTasks();
            await syncTimelineWithEvents();
            console.log('[MyTasks] ✅ Sincronización Profunda completada.');
        } catch (error) {
            console.error('[MyTasks] ❌ Error en Deep Sync:', error);
        } finally {
            setSyncing(false);
        }
    };

    // Función para buscar y sincronizar un ticket específico por ID
    const handleManualTicketSync = async () => {
        if (!manualTicketId || syncing) return;
        setSyncing(true);
        const toastId = "manual-sync-" + Date.now();
        dispatchToast("Buscando ticket...", "loading", `Consultando ID #${manualTicketId}`, toastId);

        try {
            const ticket = await WisphubService.getTicketDetail(manualTicketId);
            if (!ticket) {
                dispatchToast("No encontrado", "error", `El ticket #${manualTicketId} no existe en WispHub.`, toastId);
                return;
            }

            // Mapeamos perfiles para el sync mirror
            const profiles = await WorkflowService.getPlatformUsers();
            const { data: { user } } = await safeGetUser();
            const authProfile = profiles.find((p: any) => p.id === user?.id || p.email === user?.email);

            await WorkflowService.syncSingleTicketMirror(ticket, profiles, authProfile, { forceLocalOverride: true });

            dispatchToast("Ticket Sincronizado", "success", `Se encontró y vinculó el ticket de ${ticket.nombre_cliente}`, toastId);
            setManualTicketId('');
            await loadMyTasks();
        } catch (error) {
            console.error('[ManualSync] Error:', error);
            dispatchToast("Error de conexión", "error", "No se pudo sincronizar el ticket. Reintente.", toastId);
        } finally {
            setSyncing(false);
        }
    };

    const loadPlatformData = async () => {
        const users = await WorkflowService.getPlatformUsers();
        setPlatformUsers(users);
    };

    const loadStock = async () => {
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;

            const { data: assets } = await supabase
                .from('inventory_assets')
                .select('*, inventory_items(name, is_serialized, inventory_categories(unit_type))')
                .eq('current_holder_id', user.id);

            setTechnicianStock(assets || []);
        } catch (e) {
            console.error('Error cargando stock:', e);
        }
    };

    const saveTimeline = (newTimeline: any) => {
        setTimelineStatus(newTimeline);
        localStorage.setItem('tech_timeline_v1', JSON.stringify(newTimeline));
    };

    const fetchCustomerHistory = async (serviceId: string, clientName: string, cedula: string, currentTicketId: string) => {
        try {
            historyAbortRef.current = false;
            let effectiveCedula = cedula;
            let effectiveName = clientName;

            if (!effectiveCedula && serviceId) {
                const client = await WisphubService.getClientForSmartOlt(undefined, Number(serviceId)).catch(() => null);
                if (client) {
                    effectiveCedula = client.cedula || client.dni || '';
                    if (!effectiveName || effectiveName.startsWith('SERVICIO:')) {
                        const n = client.nombre || client.nombre_completo || client.cliente_nombre || '';
                        if (n) effectiveName = n;
                    }
                }
            }

            const svcId = String(serviceId || '').trim();
            const ced   = String(effectiveCedula || '').replace(/^0+/, '').trim();

            const cached = WisphubCache.getCached();
            const all = cached.length > 0 ? cached : await WisphubCache.getAll();

            const found = all
                .filter(t =>
                    String(t.servicio ?? '') === svcId ||
                    String(t.id_servicio ?? '') === svcId ||
                    (ced.length > 3 && String(t.cedula || '').replace(/^0+/, '').trim() === ced)
                )
                .filter(t => String(t.id) !== String(currentTicketId))
                .sort((a: any, b: any) => Number(b.id) - Number(a.id))
                .slice(0, 20);

            setHistoryDetails({});
            setCustomerHistory({ tickets: found, clientName: effectiveName, ticketId: String(currentTicketId) });
            setShowHistoryModal(true);

            // Cargar respuestas completas en lotes de 3
            const BATCH = 3;
            const AUTO_PATTERNS = [
                'llegada al destino', 'llegada al sitio', 'ha llegado a la ubicación',
                'inicio de trabajo', 'ha sido iniciado', 'inició el ticket',
                'pendiente de validación', 'validación rechazada',
            ];
            for (let i = 0; i < found.length; i += BATCH) {
                if (historyAbortRef.current) break;
                const batch = found.slice(i, i + BATCH);
                await Promise.all(batch.map(async (t: any) => {
                    try {
                        const raw = await WisphubService.getTicketRaw(t.id);
                        if (historyAbortRef.current) return;
                        const respuestas_tecnico = (raw?.respuestas || [])
                            .filter((r: any) => {
                                const text = (r.respuesta || '').toLowerCase();
                                return text.trim().length > 3 && !AUTO_PATTERNS.some(p => text.includes(p));
                            })
                            .map((r: any) => ({
                                texto: (r.respuesta || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim(),
                                fecha: r.created || '',
                                autor: r.autor || '',
                            }));
                        if (!historyAbortRef.current)
                            setHistoryDetails(prev => ({ ...prev, [t.id]: { respuestas_tecnico, loaded: true } }));
                    } catch {
                        if (!historyAbortRef.current)
                            setHistoryDetails(prev => ({ ...prev, [t.id]: { respuestas_tecnico: [], loaded: true } }));
                    }
                }));
                if (i + BATCH < found.length) await new Promise(r => setTimeout(r, 250));
            }
        } catch (e) {
            console.error('[fetchCustomerHistory] Error:', e);
        }
    };

    const handleStartWork = async (wi: any) => {
        const proc    = wi.workflow_activities?.workflow_processes;
        const ticketId = String(proc?.reference_id ?? '').trim();

        console.log(`[handleStartWork] Iniciando ticket: "${ticketId}" | fromNameQuery: ${!!wi.__fromNameQuery} | ownerId: ${wi.__ownerId ?? currentUserIdRef.current}`);

        if (!ticketId || ticketId === '---') {
            dispatchToast('Error: ID de ticket inválido', 'error', `El ticket no tiene reference_id. Datos: ${JSON.stringify(proc)}`);
            return;
        }

        setActioningTicket(ticketId + '_start');
        try {
            // Inyección de identidad: si el ticket vino por nombre (Consulta 2),
            // registrar participant_id en el workitem para que las consultas futuras lo encuentren por UUID.
            if (wi.__fromNameQuery) {
                const ownerId = wi.__ownerId || currentUserIdRef.current;
                if (ownerId && wi.id && !wi.id.startsWith('proc-')) {
                    console.log(`[handleStartWork] Inyectando participant_id=${ownerId} en workitem ${wi.id}`);
                    await supabase
                        .from('workflow_workitems')
                        .update({ participant_id: ownerId, updated_at: new Date().toISOString() })
                        .eq('id', wi.id);
                }
            }

            // Intentar PUT completo (cambia estado a En Proceso + agrega nota en WispHub)
            // Fallback: si falla, PATCH solo fecha_inicio (al menos registra el inicio)
            let ok = await WorkflowService.markTicketInProgress(ticketId, 'INICIO DE TRABAJO');
            if (!ok) {
                console.warn('[handleStartWork] PUT falló, usando fallback PATCH fecha_inicio');
                ok = await WisphubService.setTicketStartTime(ticketId);
            }

            // Siempre actualizar estado local — no bloquear en zonas de mala señal
            saveTimeline({ ...timelineStatus, [ticketId]: { ...timelineStatus[ticketId], started: true } });

            // Guardar started_at + id_estado:2 en metadata para que Supervisión detecte "En Progreso"
            const processId = proc?.id;
            if (processId) {
                await supabase
                    .from('workflow_processes')
                    .update({
                        metadata: {
                            ...(proc?.metadata || {}),
                            started_at: new Date().toISOString(),
                            id_estado: 2
                        }
                    })
                    .eq('id', processId);

                // workflow_logs solo cuando WispHub confirmó — trazabilidad verificada
                if (ok) {
                    WorkflowService.logEvent(
                        processId,
                        'Start',
                        'Técnico inició el ticket — fecha_inicio enviada a WispHub.',
                        currentUserIdRef.current || undefined
                    ).catch(() => {});
                }
            }

            // Notificar a Supervisión para que recargue (puede que el ticket sea nuevo)
            window.dispatchEvent(new CustomEvent('supervision:processes-updated', { detail: { ticketId } }));

            // Mover a sub-pestaña En Progreso
            setActiveSubTab('en_progreso');

            // Historial de antecedentes: obtener detalle fresco de WispHub (fire-and-forget)
            // Se usa getTicketDetail para tener cedula/id_servicio completos aunque el metadata
            // local venga del endpoint de lista (que omite esos campos).
            WisphubService.getTicketDetail(ticketId).then(detail => {
                const src = detail || proc?.metadata || {};
                const svcRaw = src.id_servicio || src.servicio;
                const svcId = typeof svcRaw === 'object' && svcRaw !== null
                    ? String(svcRaw.id_servicio || svcRaw.id || '')
                    : String(svcRaw || '');
                const cedula = src.cedula
                    || (typeof src.servicio === 'object' ? src.servicio?.cedula : '')
                    || (typeof src.cliente === 'object' ? src.cliente?.cedula : '')
                    || '';
                if (svcId || (cedula && cedula.length > 3)) {
                    fetchCustomerHistory(svcId, src.nombre_cliente || '', cedula, ticketId);
                }
            }).catch(() => {
                // Fallback al metadata local si WispHub no responde
                const meta = proc?.metadata || {};
                const svcRaw = meta.id_servicio || meta.servicio;
                const svcId = typeof svcRaw === 'object' && svcRaw !== null
                    ? String(svcRaw.id_servicio || svcRaw.id || '')
                    : String(svcRaw || '');
                const cedula = meta.cedula || '';
                if (svcId || (cedula && cedula.length > 3)) {
                    fetchCustomerHistory(svcId, meta.nombre_cliente || '', cedula, ticketId);
                }
            });

            if (ok) {
                dispatchToast('Ticket iniciado', 'success', `Ticket #${ticketId} — fecha de inicio registrada en WispHub.`);
            } else {
                dispatchToast('Inicio guardado localmente', 'info', `Sin respuesta de WispHub. El estado local está guardado.`);
            }
        } catch (err: any) {
            console.error('[handleStartWork] Error:', err);
            dispatchToast('Error al iniciar', 'error', err?.message || String(err));
        } finally {
            setActioningTicket(null);
        }
    };

    const handleArrival = async (wi: any) => {
        const proc     = wi.workflow_activities?.workflow_processes;
        const ticketId = String(proc?.reference_id ?? '').trim();

        console.log(`[handleArrival] Llegada para ticket: "${ticketId}" | fromNameQuery: ${!!wi.__fromNameQuery}`);

        if (!ticketId || ticketId === '---') {
            dispatchToast('Error: ID de ticket inválido', 'error', `El ticket no tiene reference_id. Datos: ${JSON.stringify(proc)}`);
            return;
        }

        setActioningTicket(ticketId + '_arrive');
        try {

            // Inyección de identidad igual que en Iniciar
            if (wi.__fromNameQuery) {
                const ownerId = wi.__ownerId || currentUserIdRef.current;
                if (ownerId && wi.id && !wi.id.startsWith('proc-')) {
                    await supabase
                        .from('workflow_workitems')
                        .update({ participant_id: ownerId, updated_at: new Date().toISOString() })
                        .eq('id', wi.id);
                }
            }

            // Mismo patrón: PUT completo primero, fallback a PATCH fecha_inicio
            let ok = await WorkflowService.markTicketInProgress(ticketId, 'LLEGADA AL SITIO');
            if (!ok) {
                console.warn('[handleArrival] PUT falló, usando fallback PATCH fecha_inicio');
                ok = await WisphubService.setTicketStartTime(ticketId);
            }

            // Audit log local — independiente de WispHub
            try {
                const { data: { user } } = await supabase.auth.getUser();
                await supabase.from('ticket_events').insert({
                    ticket_id: String(ticketId),
                    event_type: 'arrival',
                    technician_id: user?.id,
                    created_at: new Date().toISOString(),
                    metadata: { timestamp_display: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) }
                });
            } catch { /* no bloquear */ }

            // Siempre actualizar estado local
            saveTimeline({ ...timelineStatus, [ticketId]: { ...timelineStatus[ticketId], arrived: true } });

            // Confirmar id_estado:2 en metadata local (por si Iniciar no lo hizo)
            const procArrival = wi.workflow_activities?.workflow_processes;
            if (procArrival?.id) {
                supabase
                    .from('workflow_processes')
                    .update({ metadata: { ...(procArrival.metadata || {}), id_estado: 2 } })
                    .eq('id', procArrival.id)
                    .then(() => {
                        window.dispatchEvent(new CustomEvent('supervision:processes-updated', { detail: { ticketId } }));
                    });
            }

            if (ok) {
                WorkflowService.logEvent(
                    procArrival?.id,
                    'Arrival',
                    'Técnico llegó al sitio — ticket marcado En Proceso en WispHub.',
                    currentUserIdRef.current || undefined
                ).catch(() => {});
                dispatchToast('Llegada registrada', 'success', `Ticket #${ticketId} — llegada confirmada en WispHub.`);
            } else {
                dispatchToast('Llegada guardada localmente', 'info', `Sin respuesta de WispHub. El estado local está guardado.`);
            }
        } catch (err: any) {
            console.error('[handleArrival] Error:', err);
            dispatchToast('Error al registrar llegada', 'error', err?.message || String(err));
        } finally {
            setActioningTicket(null);
        }
    };


    // Nueva función para sincronizar el estado visual con los eventos reales en Supabase
    const syncTimelineWithEvents = async () => {
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;

            // Consultamos eventos de hoy para los tickets cargados
            const ticketIds = myTasks.map(wi => wi.workflow_activities?.workflow_processes?.reference_id).filter(id => id && id !== '---');
            if (ticketIds.length === 0) return;

            const { data: events, error } = await supabase
                .from('ticket_events')
                .select('ticket_id, event_type')
                .in('ticket_id', ticketIds)
                .in('event_type', ['arrival']);

            if (error) throw error;

            const newTimeline = { ...timelineStatus };
            events?.forEach(ev => {
                if (ev.event_type === 'arrival') {
                    newTimeline[ev.ticket_id] = { ...newTimeline[ev.ticket_id], arrived: true, started: true }; // Si llegó, asumimos iniciado
                }
            });

            saveTimeline(newTimeline);
        } catch (e) {
            console.error('[Sync] Error sincronizando línea de tiempo:', e);
        }
    };

    // CICLO DE VIDA (Patrón SWR + Realtime)
    useEffect(() => {
        let isMounted = true;
        let subscription: ReturnType<typeof supabase.channel> | null = null;

        const init = async () => {
            // 1. Carga PRIORITARIA: Mis Tareas (Para que el técnico no espere a metadatos)
            await loadMyTasks();

            if (!isMounted) return;

            // 2. Carga de Apoyo: Stock y Perfiles
            loadPlatformData(); // No await para no bloquear
            loadStock();        // No await para no bloquear

            // 3. Verificar Cola de Sincronización
            syncQueueService.getQueue().then(queue => {
                if (isMounted) setPendingSyncCount(queue.length);
            });

            // 4. SUPABASE REALTIME (WebSockets)
            try {
                const { data: { user } } = await safeGetUser();
                if (user && isMounted) {
                    const { data: profile } = await supabase.from('profiles').select('id').eq('id', user.id).maybeSingle();
                    let finalProfileId = profile?.id || user.id;

                    if (!profile && user.email) {
                        const { data: emailProfile } = await supabase.from('profiles').select('id').eq('email', user.email).maybeSingle();
                        if (emailProfile) finalProfileId = emailProfile.id;
                    }
                    const targetParticipantId = finalProfileId;

                    console.log(`[MyTasks:Realtime] 📡 Suscribiendo al canal Postgres para Participant: ${targetParticipantId}`);

                    if (subscription) { supabase.removeChannel(subscription); }

                    subscription = supabase
                        .channel('mis-tareas-realtime')
                        .on(
                            'postgres_changes',
                            { event: '*', schema: 'public', table: 'workflow_workitems' },
                            async (payload) => {
                                const isRelevant = ((payload.new as any) && (payload.new as any).participant_id === targetParticipantId) ||
                                    ((payload.old as any) && (payload.old as any).participant_id === targetParticipantId);

                                if (!isRelevant) return;

                                console.log('%c[MyTasks:Realtime] 🟣 EVENTO WEBSOCKET RECIBIDO 🟣', 'color: white; background: #8b5cf6; font-size: 14px; font-weight: bold; padding: 4px; border-radius: 4px;', payload);

                                const newRow = payload.new as any;
                                const oldRow = payload.old as any;
                                const changedId = newRow?.id || oldRow?.id;
                                const newStatus = newRow?.status;

                                if (payload.eventType === 'DELETE' || newStatus === 'SS' || newStatus === 'CO' || newStatus === 'ST') {
                                    // Remoción quirúrgica: no recarga la lista, solo elimina el item
                                    setMyTasks(prev => prev.filter(t => t.id !== changedId));
                                    if (payload.eventType === 'DELETE' || newStatus === 'SS') {
                                        dispatchToast("Ticket reasignado", "info", "Una tarea fue removida de tu bandeja.", "rm-ticket-ws");
                                    }
                                } else if (payload.eventType === 'INSERT') {
                                    // Nueva tarea: recarga para obtener datos completos con joins
                                    dispatchToast("¡Nueva Tarea!", "info", "El centro de despacho te ha asignado un nuevo ticket.", "new-ticket-ws");
                                    await loadMyTasks();
                                } else if (payload.eventType === 'UPDATE' && newRow?.status === 'PE') {
                                    // Recarga silenciosa — rejectValidation toca updated_at para disparar este evento
                                    // cuando workflow_processes no está en la publicación Realtime.
                                    await loadMyTasks();
                                }
                            }
                        )
                        .on(
                            'postgres_changes',
                            { event: 'UPDATE', schema: 'public', table: 'workflow_processes' },
                            async (payload) => {
                                const newProc = payload.new as any;

                                // Actualiza metadata en el estado local (si el proceso ya está en la lista)
                                setMyTasks(prev => prev.map(t => {
                                    const proc = t.workflow_activities?.workflow_processes;
                                    if (!proc || proc.id !== newProc.id) return t;
                                    return {
                                        ...t,
                                        workflow_activities: {
                                            ...t.workflow_activities,
                                            workflow_processes: {
                                                ...proc,
                                                ...newProc,
                                                metadata: { ...(proc.metadata || {}), ...(newProc.metadata || {}) }
                                            }
                                        }
                                    };
                                }));

                                // Rechazo: requestValidation limpia validation_rejected → false,
                                // así este bloque solo corre cuando el supervisor rechaza.
                                // loadMyTasks detecta vía localStorage si el rechazo es de este técnico.
                                if (newProc.metadata?.validation_rejected === true) {
                                    await loadMyTasks();
                                    setActiveSubTab('en_progreso');
                                }
                            }
                        )
                        .subscribe();
                }
            } catch (e) {
                console.error('[MyTasks:Realtime] Error al iniciar suscripción websocket:', e);
            }

            // 5. Sincronización en SEGUNDO PLANO (Silent Background)
            // Si el proxy de WispHub está caído (500) no bloqueamos la UI.
            // El técnico sigue viendo sus tareas desde Supabase (cargadas en paso 1).
            try {
                // Prueba rápida de disponibilidad antes de iniciar el sync completo
                const { ok: proxyHealthy } = await orgService.verifyWisphub().catch(() => ({ ok: false }));
                if (!proxyHealthy) {
                    console.warn('[OperationsMyTasks] ⚠️ Proxy WispHub no disponible. Sync omitido — las tareas ya se cargaron desde Supabase.');
                    dispatchToast(
                        'Sincronización WispHub no disponible',
                        'info',
                        'El proxy está caído (error 500). Tus tareas se muestran desde el espejo local. Contacta a tu administrador para redesplegar la Edge Function.',
                    );
                } else {
                    if (myTasks.length === 0) setSyncing(true);
                    console.log('[OperationsMyTasks] 🔄 Sincronización en segundo plano iniciada...');
                    // Timeout de 45s para evitar que la UI quede bloqueada si WispHub tarda
                    await Promise.race([
                        WorkflowService.syncMyTickets(),
                        new Promise<void>(resolve => setTimeout(resolve, 45000)),
                    ]);
                }
            } catch (syncError: any) {
                const is500 = syncError?.message?.includes('500') || syncError?.status === 500;
                if (is500) {
                    console.warn('[OperationsMyTasks] ⚠️ Sync falló con 500 (proxy caído). Tareas locales intactas.');
                } else {
                    console.warn('[OperationsMyTasks] ⚠️ Sincronización abortada/fallida:', syncError);
                }
            } finally {
                if (isMounted) {
                    await loadMyTasks();
                    await syncTimelineWithEvents();
                    setSyncing(false);
                }
            }
        };
        init();

        // Intervalo para procesar cola si hay internet
        const interval = setInterval(async () => {
            if (navigator.onLine && isMounted) {
                await syncQueueService.processQueue();
                const queue = await syncQueueService.getQueue();
                if (isMounted) setPendingSyncCount(queue.length);
            }
        }, 15000); // Cada 15 segs

        // Polling WispHub: detecta tickets nuevos asignados desde WispHub sin recargar
        const wisphubPollInterval = setInterval(async () => {
            if (!navigator.onLine || !isMounted) return;
            try {
                await WorkflowService.syncMyTickets();
            } catch {
                // silencioso — no interrumpir al técnico si falla
            }
        }, 90000); // Cada 90 segundos (~1.5 min)

        return () => {
            isMounted = false;
            clearInterval(interval);
            clearInterval(wisphubPollInterval);
            if (subscription) {
                console.log('[MyTasks:Realtime] 🔌 Apagando radio/desconectando WebSockets al desmontar.');
                supabase.removeChannel(subscription);
            }
        };
    }, []);

    // Respaldo same-tab: Supervision despacha este evento tras rechazar
    useEffect(() => {
        const handler = async () => {
            await loadMyTasks();
            setActiveSubTab('en_progreso');
        };
        window.addEventListener('mytasks:reload', handler);
        return () => window.removeEventListener('mytasks:reload', handler);
    }, []);

    // Cross-tab: rejectValidation escribe en localStorage desde la pestaña de Supervisión.
    // El storage event se dispara SOLO en otras pestañas del mismo browser (no en la actual).
    useEffect(() => {
        const handler = async (e: StorageEvent) => {
            if (e.key !== 'crm:rejection_signal') return;
            await loadMyTasks();
            setActiveSubTab('en_progreso');
        };
        window.addEventListener('storage', handler);
        return () => window.removeEventListener('storage', handler);
    }, []);

    return (
        <div className="space-y-6">
            <OperationsHeader
                title="Mis Tareas"
                description="Gestión centralizada de tickets y órdenes de servicio."
                onSyncComplete={loadMyTasks}
                customAction={
                    <div className="flex flex-col md:flex-row items-stretch md:items-center gap-2">
                        {/* Buscador Manual de Ticket */}
                        <div className="flex items-center gap-2 bg-white border border-zinc-200 rounded-xl px-3 py-1.5 focus-within:border-zinc-400 focus-within:ring-2 focus-within:ring-zinc-100 transition-all">
                            <RefreshCw size={14} className={clsx("text-zinc-400", syncing && "animate-spin")} />
                            <input
                                type="text"
                                placeholder="SYNC ID #"
                                value={manualTicketId}
                                onChange={(e) => setManualTicketId(e.target.value.replace(/\D/g, ''))}
                                onKeyDown={(e) => e.key === 'Enter' && handleManualTicketSync()}
                                className="bg-transparent border-none outline-none text-[10px] font-bold uppercase w-20 placeholder:text-zinc-300"
                            />
                            <button
                                onClick={handleManualTicketSync}
                                disabled={syncing || !manualTicketId}
                                className="text-[10px] font-black text-blue-600 hover:text-blue-700 disabled:opacity-30 uppercase tracking-tighter"
                            >
                                IR
                            </button>
                        </div>

                        {/* Botón de Deep Sync */}
                        <button
                            onClick={handleDeepSync}
                            disabled={syncing}
                            className="flex items-center gap-2 px-4 py-2 bg-white border border-zinc-200 hover:bg-zinc-50 hover:border-zinc-300 text-zinc-700 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                            title="Buscar tickets de hasta 30 días de antigüedad"
                        >
                            <Layers size={14} />
                            <span className="text-[10px] font-bold uppercase tracking-wide">Deep Sync</span>
                        </button>

                        {/* Indicador de Cola de Sync */}
                        {pendingSyncCount > 0 && (
                            <div className="flex items-center gap-2 bg-orange-50 text-orange-600 px-3 py-1.5 rounded-full border border-orange-200 shadow-sm animate-pulse">
                                <Clock size={12} />
                                <span className="text-[10px] font-bold uppercase tracking-wider">{pendingSyncCount} Pendientes</span>
                            </div>
                        )}
                    </div>
                }
            />

            <div className="bg-white border border-zinc-200 rounded-3xl p-4 md:p-8 animate-in fade-in duration-500 shadow-sm">
                <h2 className="text-lg font-bold mb-4 flex items-center gap-2 text-zinc-900 tracking-tight">
                    <CheckCircle2 className="text-zinc-900" size={20} /> Tareas Pendientes
                </h2>

                {/* Sub-pestañas Nueva / En Progreso */}
                {!loading && myTasks.length > 0 && (() => {
                    const isInProgress = (wi: any) => { const p = wi.workflow_activities?.workflow_processes; const tid = p?.reference_id || '---'; return !!(timelineStatus[tid]?.started || p?.metadata?.started_at || p?.metadata?.id_estado === 2 || p?.metadata?.estado === 'En Progreso' || p?.metadata?.validation_rejected); };
                    const countNueva    = myTasks.filter(wi => !isInProgress(wi)).length;
                    const countProgreso = myTasks.filter(wi =>  isInProgress(wi)).length;
                    return (
                        <div className="flex items-center gap-1 border-b border-zinc-100 mb-6">
                            {([
                                { key: 'nueva',       label: 'Nueva',       count: countNueva },
                                { key: 'en_progreso', label: 'En Progreso', count: countProgreso },
                            ] as const).map(tab => (
                                <button
                                    key={tab.key}
                                    onClick={() => setActiveSubTab(tab.key)}
                                    className={clsx(
                                        'flex items-center gap-2 px-5 py-2.5 text-xs font-black uppercase tracking-widest border-b-2 -mb-px transition-all',
                                        activeSubTab === tab.key
                                            ? 'border-zinc-900 text-zinc-900'
                                            : 'border-transparent text-zinc-400 hover:text-zinc-600'
                                    )}
                                >
                                    {tab.label}
                                    {tab.count > 0 && (
                                        <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-black bg-zinc-900 text-white leading-none">
                                            {tab.count}
                                        </span>
                                    )}
                                </button>
                            ))}
                        </div>
                    );
                })()}

                {loading ? (
                    <div className="p-12 text-center text-zinc-400 animate-pulse font-bold uppercase tracking-widest text-xs">
                        Sincronizando con la nube...
                    </div>
                ) : myTasks.length === 0 ? (
                    <div className="p-12 text-center bg-zinc-50 rounded-2xl border-2 border-dashed border-zinc-200 group hover:border-zinc-300 transition-colors">
                        <p className="text-zinc-500 font-medium group-hover:text-zinc-700 transition-colors text-sm">
                            Sin tareas pendientes. ¡Todo al día!
                        </p>
                    </div>
                ) : (
                    <div className="grid gap-4">
                        {myTasks.filter((wi) => {
                            const proc = wi.workflow_activities?.workflow_processes;
                            const ticketId = proc?.reference_id || '---';
                            const inProgress = !!(timelineStatus[ticketId]?.started || proc?.metadata?.started_at || proc?.metadata?.id_estado === 2 || proc?.metadata?.estado === 'En Progreso' || proc?.metadata?.validation_rejected);
                            return activeSubTab === 'en_progreso' ? inProgress : !inProgress;
                        }).map((wi) => {
                            const proc = wi.workflow_activities?.workflow_processes;
                            const ticketId = proc?.reference_id || '---';

                            return (
                                <div key={wi.id} className="group p-5 bg-white border border-zinc-200 rounded-2xl flex flex-col md:flex-row md:items-center justify-between hover:shadow-md hover:border-zinc-300 transition-all gap-4 w-full max-w-full overflow-hidden">
                                    <div className="flex gap-4 items-start md:items-center flex-1 min-w-0 w-full">
                                        <div className={clsx(
                                            "w-10 h-10 rounded-lg flex items-center justify-center font-bold text-sm shrink-0 border mt-1 md:mt-0",
                                            (proc?.metadata?.current_level ?? 1) > 2
                                                ? "bg-red-50 text-red-600 border-red-100"
                                                : "bg-zinc-50 text-zinc-700 border-zinc-100"
                                        )}>
                                            {proc?.metadata?.current_level ?? 1}
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2 flex-wrap">
                                                <h4 className="font-bold uppercase text-xs md:text-sm truncate text-zinc-900 flex-1 min-w-0">
                                                    {proc?.title || 'Sin Título'}
                                                </h4>

                                                {/* BOTÓN DE EXPANSIÓN (+) */}
                                                <button
                                                    onClick={() => toggleTicketExpansion(wi.id)}
                                                    className={clsx(
                                                        "p-1 rounded-md transition-all flex items-center justify-center border",
                                                        expandedTickets.has(wi.id)
                                                            ? "bg-zinc-900 border-zinc-900 text-white rotate-90"
                                                            : "bg-zinc-50 border-zinc-200 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                                                    )}
                                                    title={expandedTickets.has(wi.id) ? "Ver menos" : "Ver más detalles"}
                                                >
                                                    {expandedTickets.has(wi.id) ? <X size={12} strokeWidth={3} /> : <ChevronRight size={12} strokeWidth={3} />}
                                                </button>
                                            </div>

                                            <p className="text-xs text-zinc-500 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                                                <span className="whitespace-nowrap"><span className="font-bold text-zinc-800">TK-</span>{ticketId}</span>
                                                <span className="text-zinc-300 hidden md:inline">|</span>
                                                <span className="font-bold text-zinc-800 uppercase truncate">
                                                    {proc?.metadata?.nombre_cliente || 'Desconocido'}
                                                </span>
                                            </p>

                                            {/* PANEL DE DETALLE EXPANDIDO */}
                                            {expandedTickets.has(wi.id) && (
                                                <div className="mt-3 p-3 bg-zinc-50/50 rounded-xl border border-zinc-100 space-y-2 animate-in slide-in-from-top-1 duration-200">
                                                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                                        <div className="flex items-center gap-2 text-[10px]">
                                                            <MapPin size={12} className="text-zinc-400 shrink-0" />
                                                            <span className="text-zinc-500 font-bold uppercase tracking-tight">Dirección:</span>
                                                            <span className="text-zinc-700 font-medium truncate italic">{proc?.metadata?.direccion || 'N/A'}</span>
                                                        </div>
                                                        <div className="flex items-center gap-2 text-[10px]">
                                                            <Package size={12} className="text-zinc-400 shrink-0" />
                                                            <span className="text-zinc-500 font-bold uppercase tracking-tight">Barrio:</span>
                                                            <span className="text-zinc-700 font-medium truncate">{proc?.metadata?.barrio || 'N/A'}</span>
                                                        </div>
                                                        <div className="flex items-center gap-2 text-[10px]">
                                                            <MessageSquare size={12} className="text-zinc-400 shrink-0" />
                                                            <span className="text-zinc-500 font-bold uppercase tracking-tight">Tel:</span>
                                                            <span className="text-zinc-700 font-medium">{proc?.metadata?.telefono || proc?.metadata?.celular || 'N/A'}</span>
                                                        </div>
                                                        <div className="flex items-center gap-2 text-[10px]">
                                                            <RefreshCw size={12} className="text-zinc-400 shrink-0" />
                                                            <span className="text-zinc-500 font-bold uppercase tracking-tight">IP:</span>
                                                            <code className="bg-zinc-200/50 text-zinc-800 px-1.5 py-0.5 rounded font-mono font-bold">{proc?.metadata?.ip || '0.0.0.0'}</code>
                                                        </div>
                                                        <div className="flex items-center gap-2 text-[10px]">
                                                            <Activity size={12} className={clsx("shrink-0", (proc?.metadata?.potencia || proc?.metadata?.signal) ? "text-emerald-500" : "text-zinc-300")} />
                                                            <span className="text-zinc-500 font-bold uppercase tracking-tight">Potencia:</span>
                                                            <span className={clsx("font-black", (proc?.metadata?.potencia || proc?.metadata?.signal) ? "text-emerald-700" : "text-zinc-400 italic")}>
                                                                {proc?.metadata?.potencia || proc?.metadata?.signal || 'Pendiente'} { (proc?.metadata?.potencia || proc?.metadata?.signal) ? 'dBm' : ''}
                                                            </span>
                                                        </div>
                                                    </div>
                                                </div>
                                            )}

                                            <p className="text-[10px] text-muted-foreground mt-1 truncate">
                                                <span className="font-bold">Asunto: </span>
                                                {proc?.metadata?.asunto || 'No especificado'}
                                            </p>

                                            <div className="flex items-center gap-2 mt-2.5 flex-wrap">
                                                <span className="text-[9px] font-bold px-2 py-1 rounded-md uppercase bg-zinc-100 text-zinc-600 border border-zinc-200 tracking-wide">
                                                    {wi.workflow_activities?.name || 'SOPORTE'}
                                                </span>

                                                {/* Badge de Atraso */}
                                                {(() => {
                                                    const dt = new Date(proc?.metadata?.fecha_creacion || wi.created_at);
                                                    const today = new Date();
                                                    today.setHours(0,0,0,0);
                                                    if (dt < today) {
                                                        return (
                                                            <span className="text-[9px] font-black px-2 py-1 rounded-md uppercase bg-red-100 text-red-700 border border-red-200 animate-pulse">
                                                                ATRASADO
                                                            </span>
                                                        );
                                                    }
                                                    return null;
                                                })()}

                                                {/* Badge de Potencia Rápido */}
                                                {(proc?.metadata?.potencia || proc?.metadata?.signal) && (
                                                    <span className="text-[9px] font-black px-2 py-1 rounded-md uppercase bg-emerald-50 text-emerald-700 border border-emerald-100 flex items-center gap-1">
                                                        <Activity size={10} strokeWidth={3} />
                                                        {proc?.metadata?.potencia || proc?.metadata?.signal}
                                                    </span>
                                                )}

                                                {/* Badge de Prioridad */}
                                                <span className={clsx(
                                                    "text-[9px] font-bold px-2 py-1 rounded-md uppercase border tracking-wide",
                                                    proc?.metadata?.prioridad === 'Muy Alta' && "bg-red-50 text-red-700 border-red-100",
                                                    proc?.metadata?.prioridad === 'Alta' && "bg-orange-50 text-orange-700 border-orange-100",
                                                    proc?.metadata?.prioridad === 'Normal' && "bg-blue-50 text-blue-700 border-blue-100",
                                                    (proc?.metadata?.prioridad === 'Baja' || proc?.metadata?.prioridad === 'Media') && "bg-emerald-50 text-emerald-700 border-emerald-100",
                                                    !proc?.metadata?.prioridad && "bg-zinc-50 text-zinc-500 border-zinc-100"
                                                )}>
                                                    {proc?.metadata?.prioridad || 'Sin prioridad'}
                                                </span>

                                                {/* Badge de Estado */}
                                                {(() => {
                                                    const estadoId = proc?.metadata?.id_estado || proc?.metadata?.estado_id;
                                                    const estadoMap: Record<number, string> = {
                                                        1: 'Abierto',
                                                        2: 'En Progreso',
                                                        3: 'Resuelto',
                                                        4: 'Cerrado'
                                                    };
                                                    const estadoTexto = estadoId ? estadoMap[Number(estadoId)] || proc?.metadata?.estado || 'Desconocido' : (proc?.metadata?.estado || 'Sin estado');

                                                    return (
                                                        <span className={clsx(
                                                            "text-[9px] font-bold px-2 py-1 rounded-md uppercase border tracking-wide",
                                                            estadoTexto === 'Abierto' && "bg-yellow-50 text-yellow-700 border-yellow-100",
                                                            estadoTexto === 'En Progreso' && "bg-blue-50 text-blue-700 border-blue-100",
                                                            (estadoTexto === 'Cerrado' || estadoTexto === 'Resuelto') && "bg-emerald-50 text-emerald-700 border-emerald-100",
                                                            !estadoTexto && "bg-zinc-50 text-zinc-500 border-zinc-100"
                                                        )}>
                                                            {estadoTexto}
                                                        </span>
                                                    );
                                                })()}

                                                <div className="flex items-center gap-1.5 text-zinc-400">
                                                    <Clock size={10} />
                                                    <span className="text-[9px] font-bold uppercase">
                                                        {proc?.metadata?.fecha_creacion ? new Date(proc.metadata.fecha_creacion).toLocaleDateString() : new Date(wi.created_at).toLocaleDateString()}
                                                    </span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                    <div className="flex gap-2 w-full md:w-auto overflow-x-auto pb-2 md:pb-0 scrollbar-hide snap-x">
                                        {/* Ver Historial — visible después de iniciar si hay historial cargado para este ticket */}
                                        {timelineStatus[ticketId]?.started && customerHistory?.ticketId === ticketId && (
                                            <button
                                                onClick={() => setShowHistoryModal(true)}
                                                className="px-3 py-2 bg-amber-50 text-amber-700 border border-amber-100 rounded-xl text-[10px] font-bold uppercase transition-all flex items-center gap-1.5 shrink-0 hover:bg-amber-100"
                                                title="Ver antecedentes del cliente"
                                            >
                                                <Clock size={12} /> Ver Historial
                                            </button>
                                        )}

                                        {/* Botón de Inicio si no ha empezado */}
                                        {!timelineStatus[ticketId]?.started && (
                                            <button
                                                onClick={() => handleStartWork(wi)}
                                                disabled={actioningTicket === ticketId + '_start'}
                                                className={clsx(
                                                    'px-3 py-2 bg-emerald-50 text-emerald-600 border border-emerald-100 rounded-xl text-[10px] font-bold uppercase transition-all flex items-center gap-1.5 shrink-0',
                                                    actioningTicket === ticketId + '_start'
                                                        ? 'opacity-60 cursor-not-allowed'
                                                        : 'hover:bg-emerald-100'
                                                )}
                                                title="Marcar Inicio de Trabajo"
                                            >
                                                {actioningTicket === ticketId + '_start'
                                                    ? <><RefreshCw size={12} className="animate-spin" /> Iniciando...</>
                                                    : <><Play size={12} fill="currentColor" /> Iniciar</>
                                                }
                                            </button>
                                        )}

                                        {/* Botón de Llegada si ya inició pero no ha llegado */}
                                        {timelineStatus[ticketId]?.started && !timelineStatus[ticketId]?.arrived && (
                                            <button
                                                onClick={() => handleArrival(wi)}
                                                disabled={actioningTicket === ticketId + '_arrive'}
                                                className={clsx(
                                                    'px-3 py-2 bg-blue-50 text-blue-600 border border-blue-100 rounded-xl text-[10px] font-bold uppercase transition-all flex items-center gap-1.5 shrink-0',
                                                    actioningTicket === ticketId + '_arrive'
                                                        ? 'opacity-60 cursor-not-allowed'
                                                        : 'hover:bg-blue-100'
                                                )}
                                                title="Reportar Llegada al sitio"
                                            >
                                                {actioningTicket === ticketId + '_arrive'
                                                    ? <><RefreshCw size={12} className="animate-spin" /> Llegando...</>
                                                    : <><MapPin size={12} fill="currentColor" /> Llegada</>
                                                }
                                            </button>
                                        )}

                                        {/* Pasar a Validar — visible cuando ya llegó y no está en validación activa */}
                                        {timelineStatus[ticketId]?.arrived && !proc?.metadata?.pending_validation && (
                                            <div className="flex flex-col gap-1 shrink-0">
                                                {proc?.metadata?.validation_rejected && (
                                                    <div className="px-3 py-1.5 bg-red-50 text-red-600 border border-red-200 rounded-xl text-[10px] font-bold uppercase flex items-center gap-1.5">
                                                        <AlertCircle size={11} /> Rechazado: {proc.metadata.validation_rejected_note || 'revisar trabajo'}
                                                    </div>
                                                )}
                                                <button
                                                    onClick={() => { setSelectedTask(wi); setActionType('validate'); }}
                                                    className="px-3 py-2 bg-violet-50 text-violet-600 border border-violet-100 rounded-xl text-[10px] font-bold uppercase transition-all flex items-center gap-1.5 hover:bg-violet-100"
                                                    title="Enviar al supervisor para validación"
                                                >
                                                    <Activity size={12} /> {proc?.metadata?.validation_rejected ? 'Volver a Validar' : 'Validar'}
                                                </button>
                                            </div>
                                        )}
                                        {proc?.metadata?.pending_validation && (
                                            <span className="px-3 py-2 bg-violet-50 text-violet-400 border border-violet-100 rounded-xl text-[10px] font-bold uppercase flex items-center gap-1.5 shrink-0">
                                                <Activity size={12} /> En Validación
                                            </span>
                                        )}

                                        {/* RBAC: Permisos Gestionados */}
                                        {canEditTicket(userProfile, wi) && (
                                            <button
                                                onClick={() => {
                                                    setSelectedTask(wi);
                                                    setIsEditModalOpen(true);
                                                }}
                                                className="px-4 py-2.5 bg-zinc-50 border border-zinc-200 text-zinc-600 hover:bg-zinc-100 hover:border-zinc-300 rounded-xl text-[10px] font-bold uppercase transition-all shadow-sm flex items-center gap-2 shrink-0"
                                            >
                                                Editar
                                            </button>
                                        )}

                                        {canEscalateTicket(userProfile, wi) && (
                                            <button
                                                onClick={() => {
                                                    const currentPriorityStr = wi.workflow_activities?.workflow_processes?.priority || 'Media';
                                                    const pMap: Record<string, number> = { "Baja": 1, "Normal": 2, "Media": 2, "Alta": 3, "Muy Alta": 4 };
                                                    setPriority(pMap[currentPriorityStr] || 2);
                                                    setSelectedTask(wi);
                                                    setActionType('escalate');
                                                }}
                                                className="px-4 py-2.5 bg-zinc-50 border border-zinc-200 text-zinc-600 hover:bg-zinc-100 hover:border-zinc-300 rounded-xl text-[10px] font-bold uppercase transition-all shadow-sm shrink-0"
                                            >
                                                Escalar
                                            </button>
                                        )}

                                        <button
                                            onClick={() => {
                                                setSelectedTask(wi);
                                                setActionType('complete');
                                            }}
                                            className="px-5 py-2.5 bg-zinc-900 hover:bg-black text-white rounded-xl text-[10px] font-bold shadow-sm hover:shadow-lg hover:shadow-zinc-900/10 flex items-center gap-2 active:scale-95 transition-all uppercase tracking-wide shrink-0 ml-auto md:ml-0"
                                        >
                                            Finalizar <ChevronRight size={14} />
                                        </button>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {/* Modal de Gestión */}
            {selectedTask && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-zinc-900/40 backdrop-blur-sm animate-in fade-in duration-200">
                    <div className="bg-white border border-zinc-200 w-full max-w-2xl max-h-[90vh] rounded-2xl shadow-2xl overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col">
                        <div className="p-5 border-b border-zinc-100 flex justify-between items-center bg-white shrink-0">
                            <div>
                                <h3 className="text-base font-bold uppercase flex items-center gap-2 text-zinc-900 tracking-tight">
                                    {actionType === 'complete' ? <CheckCircle2 className="text-emerald-600" size={18} /> : actionType === 'validate' ? <Activity className="text-violet-600" size={18} /> : <AlertTriangle className="text-orange-500" size={18} />}
                                    {actionType === 'complete' ? 'Finalizar Tarea' : actionType === 'validate' ? 'Pasar a Validación' : 'Escalar Proceso'}
                                </h3>
                                <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mt-1">
                                    Ticket #{selectedTask.workflow_activities?.workflow_processes?.reference_id}
                                </p>
                            </div>
                            <button onClick={() => setSelectedTask(null)} className="p-2 hover:bg-zinc-50 rounded-full transition-colors text-zinc-400 hover:text-zinc-600">
                                <X size={18} />
                            </button>
                        </div>

                        <div className="p-6 space-y-6 bg-white overflow-y-auto">
                            {/* Materiales + Potencia + Estado — Finalizar y Validar */}
                            {(actionType === 'complete' || actionType === 'validate') && (
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between">
                                        <label className="text-[11px] font-black text-zinc-800 uppercase flex items-center gap-2 tracking-widest">
                                            <Package size={14} className="text-zinc-400" />
                                            Materiales Utilizados
                                        </label>
                                        <div className="flex items-center gap-2">
                                            <button
                                                onClick={() => {
                                                    // Buscamos materiales comunes en el stock
                                                    const kit: Record<string, number> = {};
                                                    const ont = technicianStock.find(a => a.inventory_items?.name?.toLowerCase().includes('ont'));
                                                    const router = technicianStock.find(a => a.inventory_items?.name?.toLowerCase().includes('router'));
                                                    const cable = technicianStock.find(a => a.inventory_items?.name?.toLowerCase().includes('cable') || a.inventory_items?.name?.toLowerCase().includes('drop'));

                                                    if (ont) kit[ont.id] = 1;
                                                    if (router) kit[router.id] = 1;
                                                    if (cable) kit[cable.id] = 120; // Default reasonable amount

                                                    setSelectedMaterials({ ...selectedMaterials, ...kit });
                                                }}
                                                className="text-[9px] font-black text-blue-600 uppercase bg-blue-50 hover:bg-blue-100 px-3 py-1 rounded-full border border-blue-100 transition-all active:scale-95"
                                            >
                                                + Kit Instalación
                                            </button>
                                            <span className="text-[9px] font-bold text-zinc-400 uppercase bg-zinc-50 px-2 py-1 rounded border border-zinc-100">Stock Técnico</span>
                                        </div>
                                    </div>

                                    <MaterialSelector
                                        stock={technicianStock}
                                        selectedMaterials={selectedMaterials}
                                        onChange={setSelectedMaterials}
                                    />

                                    <div className="grid grid-cols-2 gap-4">
                                        <div className="space-y-2">
                                            <label className="text-[11px] font-black text-zinc-800 uppercase flex items-center gap-2 tracking-widest">
                                                <RefreshCw size={14} className="text-zinc-400" />
                                                Estado Final
                                            </label>
                                            <div className="flex bg-zinc-100 p-1 rounded-xl gap-1 w-full">
                                                <button
                                                    onClick={() => setFinalStatus(3)}
                                                    className={clsx(
                                                        "flex-1 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider transition-all",
                                                        finalStatus === 3
                                                            ? "bg-blue-600 text-white shadow-md shadow-blue-500/20"
                                                            : "text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200/50"
                                                    )}
                                                >
                                                    Resuelto
                                                </button>
                                                <button
                                                    onClick={() => setFinalStatus(4)}
                                                    className={clsx(
                                                        "flex-1 py-1 rounded-lg text-[8px] font-black uppercase tracking-wider transition-all",
                                                        finalStatus === 4
                                                            ? "bg-emerald-600 text-white shadow-md shadow-emerald-500/20"
                                                            : "text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200/50"
                                                    )}
                                                >
                                                    Cerrado
                                                </button>
                                            </div>
                                        </div>
                                        <div className="space-y-2">
                                            <label className="text-[11px] font-black text-zinc-800 uppercase flex items-center gap-2 tracking-widest">
                                                <Activity size={14} className={clsx(signalAutoFetching ? "text-blue-400 animate-pulse" : signalAutoFailed ? "text-orange-400" : "text-emerald-500")} />
                                                Potencia (dBm)
                                                <button
                                                    type="button"
                                                    disabled={signalAutoFetching}
                                                    onClick={() => {
                                                        setSignal('');
                                                        setSignalAutoFailed(false);
                                                        setSmartoltTrigger(t => t + 1);
                                                    }}
                                                    className={clsx(
                                                        'ml-auto flex items-center gap-1 px-2 py-0.5 rounded-lg text-[9px] font-black uppercase tracking-wide border transition-all',
                                                        signalAutoFetching
                                                            ? 'opacity-50 cursor-not-allowed bg-zinc-50 border-zinc-200 text-zinc-400'
                                                            : 'bg-blue-50 border-blue-100 text-blue-600 hover:bg-blue-100'
                                                    )}
                                                    title="Consultar señal en SmartOLT"
                                                >
                                                    <RefreshCw size={9} className={signalAutoFetching ? 'animate-spin' : ''} />
                                                    {signalAutoFetching ? 'Consultando…' : 'Recargar'}
                                                </button>
                                            </label>
                                            <div className="relative">
                                                <input
                                                    type="text"
                                                    placeholder={signalAutoFetching ? "Consultando SmartOLT..." : "-22.5"}
                                                    disabled={signalAutoFetching}
                                                    className={clsx(
                                                        "w-full border rounded-xl px-4 py-2 text-xs font-bold outline-none transition-all",
                                                        signalAutoFetching && "bg-blue-50 border-blue-200 text-blue-400 cursor-wait",
                                                        !signalAutoFetching && signal && "bg-emerald-50 border-emerald-200 text-emerald-700",
                                                        !signalAutoFetching && !signal && "bg-zinc-50 border-zinc-200 text-zinc-700 focus:bg-white focus:border-zinc-900"
                                                    )}
                                                    value={signal}
                                                    onChange={(e) => setSignal(e.target.value)}
                                                />
                                                {signalAutoFetching && (
                                                    <RefreshCw size={12} className="absolute right-3 top-1/2 -translate-y-1/2 text-blue-400 animate-spin" />
                                                )}
                                                {!signalAutoFetching && signal && (
                                                    <Zap size={12} className="absolute right-3 top-1/2 -translate-y-1/2 text-emerald-500" />
                                                )}
                                            </div>
                                            {signalAutoFailed && (
                                                <p className="text-[9px] font-bold text-orange-500 uppercase flex items-center gap-1">
                                                    <AlertTriangle size={9} /> SmartOLT sin respuesta — ingreso manual bajo excepción
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            )}

                            <div className="space-y-2">
                                <label className="text-[11px] font-black text-zinc-800 uppercase flex items-center gap-2 tracking-widest">
                                    <MessageSquare size={14} className="text-zinc-400" />
                                    {actionType === 'complete' ? 'Reporte Técnico' : actionType === 'validate' ? 'Nota del técnico' : 'Motivo del escalamiento'}
                                </label>
                                <textarea
                                    className="w-full h-32 bg-zinc-50 border border-zinc-200 rounded-2xl p-4 text-xs font-medium outline-none focus:bg-white focus:border-zinc-900 focus:ring-4 focus:ring-zinc-100 transition-all resize-none placeholder:text-zinc-300 text-zinc-700 leading-relaxed"
                                    placeholder={actionType === 'complete' ? 'Detalla la solución técnica aplicada...' : actionType === 'validate' ? 'Describe el trabajo realizado para validación...' : 'Explica el motivo del escalamiento...'}
                                    value={comment}
                                    onChange={(e) => setComment(e.target.value)}
                                    autoFocus
                                />
                            </div>

                            {/* Evidencias Múltiples */}
                            <div className="space-y-4">
                                <div className="flex items-center justify-between">
                                    <label className="text-[11px] font-black text-zinc-800 uppercase flex items-center gap-2 tracking-widest">
                                        <Camera size={14} className="text-zinc-400" />
                                        Evidencias Fotográficas
                                    </label>
                                    <span className="text-[9px] font-bold text-zinc-400 uppercase bg-zinc-50 px-2 py-0.5 rounded border border-zinc-100">{evidenceFiles.length} de 5</span>
                                </div>

                                <div className="grid grid-cols-5 gap-3">
                                    {/* Muestra de fotos seleccionadas */}
                                    {evidenceFiles.map((_, idx) => (
                                        <div key={idx} className="aspect-square bg-zinc-100 rounded-xl border border-zinc-200 relative group overflow-hidden">
                                            <div className="absolute inset-0 flex items-center justify-center text-[10px] font-black text-zinc-400 bg-zinc-50">
                                                IMG_{idx + 1}
                                            </div>
                                            <button
                                                onClick={() => setEvidenceFiles(evidenceFiles.filter((_, i) => i !== idx))}
                                                className="absolute top-1 right-1 p-1 bg-red-500 text-white rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
                                            >
                                                <Trash2 size={10} />
                                            </button>
                                            {idx === 0 && (
                                                <div className="absolute bottom-0 left-0 right-0 bg-emerald-500/90 text-white text-[8px] font-black py-0.5 px-1 uppercase tracking-tighter text-center">PRINCIPAL</div>
                                            )}
                                        </div>
                                    ))}

                                    {evidenceFiles.length < 5 && (
                                        <label className="aspect-square bg-zinc-50 border-2 border-dashed border-zinc-200 rounded-xl flex flex-col items-center justify-center cursor-pointer hover:bg-zinc-100 hover:border-zinc-300 transition-all group">
                                            <input
                                                type="file"
                                                className="hidden"
                                                accept="image/*"
                                                multiple
                                                onChange={(e) => {
                                                    const files = Array.from(e.target.files || []);
                                                    setEvidenceFiles([...evidenceFiles, ...files].slice(0, 5));
                                                }}
                                            />
                                            <Camera size={16} className="text-zinc-300 group-hover:text-zinc-500 transition-colors" />
                                            <span className="text-[8px] font-black text-zinc-400 group-hover:text-zinc-600 mt-1 uppercase">Añadir</span>
                                        </label>
                                    )}
                                </div>
                            </div>

                            {actionType === 'escalate' && (
                                <div className="space-y-4">
                                {/* Sugerencia automática basada en tipo de ticket */}
                                {(() => {
                                    const asunto = selectedTask?.workflow_activities?.workflow_processes?.metadata?.asunto || '';
                                    const suggestion = getEscalationSuggestion(asunto);
                                    if (!suggestion) return null;
                                    const colorMap: Record<string, string> = {
                                        blue: 'bg-blue-50 border-blue-200 text-blue-700',
                                        orange: 'bg-orange-50 border-orange-200 text-orange-700',
                                        red: 'bg-red-50 border-red-200 text-red-700',
                                        yellow: 'bg-yellow-50 border-yellow-200 text-yellow-700',
                                        purple: 'bg-purple-50 border-purple-200 text-purple-700',
                                    };
                                    return (
                                        <div className={clsx("p-3 rounded-xl border text-[10px] font-black uppercase flex items-center gap-2", colorMap[suggestion.color] || colorMap.blue)}>
                                            <Navigation size={12} />
                                            <span>Sugerido: {suggestion.hint}</span>
                                        </div>
                                    );
                                })()}
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <label className="text-[11px] font-black text-zinc-800 uppercase tracking-widest">Prioridad</label>
                                        <select
                                            value={priority}
                                            onChange={(e) => setPriority(Number(e.target.value))}
                                            className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3 text-xs font-bold outline-none focus:bg-white focus:border-zinc-900 transition-all font-bold uppercase tracking-wide"
                                        >
                                            <option value={1}>1 - BAJA</option>
                                            <option value={2}>2 - NORMAL</option>
                                            <option value={3}>3 - ALTA</option>
                                            <option value={4}>4 - CRÍTICA</option>
                                        </select>
                                    </div>

                                    <div className="space-y-2">
                                        <label className="text-[11px] font-black text-zinc-800 uppercase tracking-widest inline-flex items-center gap-2">
                                            Reasignar a
                                        </label>
                                        <select
                                            value={targetTechnician}
                                            onChange={(e) => setTargetTechnician(e.target.value)}
                                            className="w-full bg-zinc-50 border border-zinc-200 rounded-xl px-4 py-3 text-xs font-bold outline-none focus:bg-white focus:border-zinc-900 transition-all font-bold uppercase tracking-wide truncate"
                                        >
                                            <option value="">Seleccionar responsable...</option>
                                            {(() => {
                                                const currentLevel = selectedTask?.workflow_activities?.workflow_processes?.metadata?.current_level ?? 1;
                                                let targetLevel = currentLevel + 1;
                                                if (currentLevel === 0 || currentLevel === 1) targetLevel = 2;

                                                const filtered = platformUsers.filter(u => Number(u.operational_level) === targetLevel);

                                                return filtered.map(u => (
                                                    <option key={u.id} value={u.id}>
                                                        {u.full_name} ({u.operational_role || 'SOPORTE'})
                                                    </option>
                                                ));
                                            })()}
                                        </select>
                                    </div>
                                </div>
                                </div>
                            )}

                            <button
                                disabled={(() => {
                                    if (processing) return true;
                                    if (!comment.trim()) return true;
                                    if (actionType === 'complete') {
                                        const asunto = selectedTask?.workflow_activities?.workflow_processes?.metadata?.asunto?.toUpperCase() || '';
                                        let req = REQUIREMENTS.DEFAULT;
                                        for (const key in REQUIREMENTS) {
                                            if (asunto.includes(key)) req = REQUIREMENTS[key];
                                        }
                                        if (evidenceFiles.length < req.minPhotos) return true;
                                        if (req.requiresMaterials && Object.keys(selectedMaterials).length === 0) return true;
                                        // Bloquear si alguna cantidad supera el stock disponible
                                        const hasOverflow = Object.entries(selectedMaterials).some(([assetId, qty]) => {
                                            const asset = technicianStock.find((a: any) => a.id === assetId);
                                            if (!asset) return false;
                                            const available = asset.inventory_items?.is_serialized
                                                ? 1
                                                : (asset.quantity ?? asset.current_quantity ?? 1);
                                            return qty > available;
                                        });
                                        if (hasOverflow) return true;
                                    }
                                    return false;
                                })()}
                                onClick={async () => {
                                    setProcessing(true);
                                    try {
                                        let success = false;
                                        const ticketId = selectedTask.workflow_activities?.workflow_processes?.reference_id;
                                        const materialList = actionType === 'complete' ? Object.entries(selectedMaterials).map(([id, qty]) => ({
                                            asset_id: id,
                                            quantity: qty
                                        })) : [];

                                        if (actionType === 'complete') {
                                            // 1. Intentar Registro Directo
                                            try {
                                                if (materialList.length > 0) {
                                                    await WorkflowService.trackMaterialConsumption(ticketId, materialList);
                                                }

                                                // --- CONVERSIÓN DE IMÁGENES & MARCA DE AGUA ---
                                                // Procesar todas las fotos para asegurar que sean JPEG y WispHub no las rechace
                                                const processedFiles: Blob[] = [];
                                                if (evidenceFiles.length > 0) {
                                                    dispatchToast("Procesando fotos...", "loading", "Aplicando marca de agua y optimizando JPEG", "image-proc");
                                                    
                                                    // Capturar ubicación si es posible
                                                    let location: { lat: number, lng: number } | undefined;
                                                    try {
                                                        const pos: any = await new Promise((res, rej) => {
                                                            navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 });
                                                        });
                                                        location = { lat: pos.coords.latitude, lng: pos.coords.longitude };
                                                        console.log("[Watermark] Ubicación capturada para marca de agua:", location);
                                                    } catch (locErr) {
                                                        console.warn("[Watermark] No se pudo obtener ubicación GPS:", locErr);
                                                    }

                                                    const watermarkMeta: ImageMetadata = {
                                                        company: companyName,
                                                        technician: userProfile?.full_name || 'TÉCNICO',
                                                        location,
                                                        timestamp: new Date().toLocaleString()
                                                    };

                                                    for (const file of evidenceFiles) {
                                                        try {
                                                            const jpegBlob = await convertToJpeg(file, 2000, 0.8, watermarkMeta);
                                                            processedFiles.push(jpegBlob);
                                                        } catch (err) {
                                                            console.error("Error convirtiendo imagen:", err);
                                                            // No se sube la imagen si falla la conversión — el spec prohíbe subir la original
                                                            dispatchToast("Error en foto", "error", `No se pudo procesar una imagen. Reintente.`, "img-err");
                                                        }
                                                    }
                                                    dispatchToast("Fotos listas ✅", "success", "Imágenes con marca de agua y optimizadas", "image-proc");
                                                }

                                                success = await WorkflowService.completeAndSyncWorkItem(selectedTask.id, comment, {
                                                    files: processedFiles,
                                                    statusId: finalStatus,
                                                    signal: signal // Envío de potencia
                                                });

                                                if (success) {
                                                    // Limpiar borrador al finalizar con éxito
                                                    await draftService.clearDraft(String(ticketId));
                                                }
                                            } catch (e) {
                                                console.warn('[MyTasks] 📡 Falla de red detectada, moviendo a cola...');
                                                success = false;
                                            }

                                            if (!success) {
                                                // 2. Mover a Cola si falla (Resiliencia)
                                                await syncQueueService.addToQueue({
                                                    id: ticketId,
                                                    type: 'COMPLETE',
                                                    data: {
                                                        workItemId: selectedTask.id,
                                                        resolution: comment,
                                                        files: evidenceFiles,
                                                        materials: materialList,
                                                        statusId: finalStatus,
                                                        signal: signal
                                                    },
                                                    timestamp: Date.now(),
                                                    attempts: 0
                                                });
                                                setPendingSyncCount(prev => prev + 1);
                                                success = true; // Marcamos como "éxito local" para cerrar el modal
                                            }

                                            // 3. Limpiar Timeline local siempre
                                            const newTimeline = { ...timelineStatus };
                                            delete newTimeline[ticketId];
                                            saveTimeline(newTimeline);

                                        } else {
                                            // Lógica de Escalamiento Simétrica
                                            try {
                                                success = await WorkflowService.escalateWorkItem(selectedTask.id, comment, targetTechnician || undefined, {
                                                    priority: priority,
                                                    file: evidenceFiles[0]
                                                });
                                            } catch (e) {
                                                success = false;
                                            }

                                            if (!success) {
                                                await syncQueueService.addToQueue({
                                                    id: ticketId,
                                                    type: 'ESCALATE',
                                                    data: {
                                                        workItemId: selectedTask.id,
                                                        resolution: comment,
                                                        files: [evidenceFiles[0]],
                                                        targetTechnicianId: targetTechnician || undefined,
                                                        priority: priority
                                                    },
                                                    timestamp: Date.now(),
                                                    attempts: 0
                                                });
                                                setPendingSyncCount(prev => prev + 1);
                                                success = true;
                                            }
                                        }

                                        if (actionType === 'validate') {
                                            const proc = selectedTask.workflow_activities?.workflow_processes;
                                            const processId = proc?.id;
                                            if (processId && ticketId) {
                                                const firstFile = evidenceFiles[0] || undefined;
                                                success = await WorkflowService.requestValidation(processId, String(ticketId), comment, firstFile);
                                                if (success) {
                                                    window.dispatchEvent(new CustomEvent('supervision:processes-updated', { detail: { ticketId } }));
                                                    dispatchToast('Enviado a validación', 'success', `Ticket #${ticketId} — el supervisor fue notificado.`);
                                                }
                                            }
                                        }

                                        if (success) {
                                            if (actionType === 'escalate') {
                                                // Remoción instantánea del estado local
                                                setMyTasks(prev => prev.filter(t => t.id !== selectedTask.id));
                                                // Notificar a Supervisión para que refresque conteos
                                                window.dispatchEvent(new CustomEvent('supervision:processes-updated', {
                                                    detail: { ticketId, workItemId: selectedTask.id }
                                                }));
                                                dispatchToast(
                                                    'Ticket escalado y removido de tu lista',
                                                    'success',
                                                    `Ticket #${ticketId} transferido al siguiente nivel.`
                                                );
                                            }
                                            setSelectedTask(null);
                                            setComment('');
                                            setSelectedMaterials({});
                                            setSignal('');
                                            await loadMyTasks();
                                        }
                                    } finally {
                                        setProcessing(false);
                                    }
                                }}
                                className={clsx(
                                    "w-full py-4 rounded-2xl font-black uppercase text-xs flex items-center justify-center gap-3 transition-all shadow-xl tracking-widest",
                                    actionType === 'complete' ? "bg-zinc-900 text-white hover:bg-black hover:shadow-zinc-900/30"
                                        : actionType === 'validate' ? "bg-violet-600 text-white hover:bg-violet-700 shadow-violet-500/30"
                                        : "bg-orange-500 text-white hover:bg-orange-600 shadow-orange-500/30",
                                    (!comment.trim() || processing) && "opacity-50 cursor-not-allowed scale-95"
                                )}
                            >
                                {processing ? (
                                    <> <RefreshCw size={16} className="animate-spin" /> Procesando... </>
                                ) : (
                                    <>
                                        {(() => {
                                            if (actionType === 'validate') return 'Enviar a Validación';
                                            if (actionType !== 'complete') return 'Confirmar Escalamiento';

                                            const asunto = selectedTask?.workflow_activities?.workflow_processes?.metadata?.asunto?.toUpperCase() || '';
                                            let req = REQUIREMENTS.DEFAULT;
                                            for (const key in REQUIREMENTS) {
                                                if (asunto.includes(key)) req = REQUIREMENTS[key];
                                            }

                                            if (evidenceFiles.length < req.minPhotos) return `Faltan Fotos (${evidenceFiles.length}/${req.minPhotos})`;
                                            if (req.requiresMaterials && Object.keys(selectedMaterials).length === 0) return 'Reportar Materiales';

                                            const overflowAsset = Object.entries(selectedMaterials).find(([assetId, qty]) => {
                                                const asset = technicianStock.find((a: any) => a.id === assetId);
                                                if (!asset) return false;
                                                const available = asset.inventory_items?.is_serialized ? 1 : (asset.quantity ?? asset.current_quantity ?? 1);
                                                return qty > available;
                                            });
                                            if (overflowAsset) return 'Stock Insuficiente';

                                            return 'Finalizar Tarea';
                                        })()}
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal de Antecedentes de Soporte */}
            {showHistoryModal && customerHistory && (
                <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={() => setShowHistoryModal(false)} />
                    <div className="relative z-10 bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
                        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-100">
                            <div>
                                <h3 className="text-sm font-black text-zinc-900 uppercase tracking-wide flex items-center gap-2">
                                    <Activity size={14} className="text-amber-500" /> Antecedentes de Soporte
                                </h3>
                                <p className="text-[10px] text-zinc-500 mt-0.5">
                                    {customerHistory.clientName || 'Cliente'} — Últimos 60 días
                                </p>
                            </div>
                            <button onClick={() => { historyAbortRef.current = true; setShowHistoryModal(false); setHistoryFilter(''); }} className="p-1.5 hover:bg-zinc-100 rounded-full text-zinc-400 hover:text-zinc-600 transition-colors">
                                <X size={16} />
                            </button>
                        </div>

                        {/* Buscador libre */}
                        <div className="px-5 pt-3 pb-2 border-b border-zinc-100">
                            <input
                                type="text"
                                value={historyFilter}
                                onChange={e => setHistoryFilter(e.target.value)}
                                placeholder="Buscar en asunto, estado, técnico, notas…"
                                className="w-full text-[11px] px-3 py-2 bg-zinc-50 border border-zinc-200 rounded-xl focus:outline-none focus:border-zinc-400 focus:ring-2 focus:ring-zinc-100 placeholder:text-zinc-400"
                                autoFocus
                            />
                        </div>

                        <div className="overflow-y-auto flex-1 px-5 py-4">
                            {(() => {
                                const q = historyFilter.trim().toLowerCase();
                                const visible = q
                                    ? customerHistory.tickets.filter(t => {
                                        const fields = [
                                            t.asunto,
                                            t.nombre_estado,
                                            t.nombre_tecnico,
                                            t.descripcion,
                                            t.ultima_respuesta?.texto,
                                            String(t.id),
                                        ].map(f => (f || '').toLowerCase());
                                        return fields.some(f => f.includes(q));
                                    })
                                    : customerHistory.tickets;
                                if (visible.length === 0) return (
                                    <div className="text-center py-10">
                                        <CheckCircle2 size={36} className="text-emerald-400 mx-auto mb-3" />
                                        <p className="text-sm font-bold text-zinc-700">{q ? 'Sin resultados para tu búsqueda' : 'Sin antecedentes de soporte recientes'}</p>
                                        <p className="text-[11px] text-zinc-400 mt-1">{q ? 'Intenta con otra palabra clave' : 'para este cliente en los últimos 365 días'}</p>
                                    </div>
                                );
                                return (
                                <div className="space-y-3">
                                    <p className="text-[10px] text-zinc-500 mb-2">
                                        Este cliente presentó los siguientes tickets recientemente:
                                    </p>
                                    {visible.map(t => {
                                        const detail = historyDetails[t.id];
                                        const respuestas = detail?.respuestas_tecnico ?? [];
                                        const loaded = detail?.loaded ?? false;
                                        return (
                                        <div key={t.id} className="p-3 bg-zinc-50 rounded-xl border border-zinc-100">
                                            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
                                                <span className="text-[9px] font-black text-zinc-500 bg-zinc-200/70 px-2 py-0.5 rounded-md">
                                                    {t.fecha_creacion
                                                        ? new Date(t.fecha_creacion).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' })
                                                        : '—'}
                                                </span>
                                                <span className={clsx(
                                                    'text-[9px] font-black px-2 py-0.5 rounded-md uppercase',
                                                    t.id_estado === 4 && 'bg-zinc-100 text-zinc-500',
                                                    t.id_estado === 3 && 'bg-blue-50 text-blue-600',
                                                    t.id_estado === 2 && 'bg-amber-50 text-amber-600',
                                                    t.id_estado === 1 && 'bg-red-50 text-red-500',
                                                )}>
                                                    {t.nombre_estado}
                                                </span>
                                                <span className="text-[9px] text-zinc-400 font-mono">#{t.id}</span>
                                            </div>
                                            <p className="text-[11px] font-bold text-zinc-800 leading-tight">{t.asunto}</p>
                                            {!loaded ? (
                                                <div className="mt-2 flex items-center gap-1.5 text-zinc-300">
                                                    <Clock size={10} className="animate-pulse" />
                                                    <span className="text-[9px]">Cargando respuestas…</span>
                                                </div>
                                            ) : respuestas.length > 0 ? (
                                                <div className="mt-2 space-y-1.5">
                                                    <p className="text-[9px] font-black text-amber-600 uppercase tracking-wide">Hilo de respuestas ({respuestas.length})</p>
                                                    {respuestas.map((r: any, i: number) => (
                                                        <div key={i} className="pl-2.5 border-l-2 border-amber-200">
                                                            {r.fecha && (
                                                                <p className="text-[8px] text-zinc-400 mb-0.5">
                                                                    {new Date(r.fecha).toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                                                    {r.autor ? ` · ${r.autor}` : ''}
                                                                </p>
                                                            )}
                                                            <p className="text-[10px] text-zinc-600 leading-relaxed">{r.texto}</p>
                                                        </div>
                                                    ))}
                                                </div>
                                            ) : t.descripcion ? (
                                                <div className="mt-2 pl-2.5 border-l-2 border-zinc-200">
                                                    <p className="text-[9px] font-black text-zinc-400 uppercase mb-0.5 tracking-wide">Problema reportado</p>
                                                    <p className="text-[10px] text-zinc-500 leading-relaxed">{t.descripcion.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()}</p>
                                                </div>
                                            ) : (
                                                <p className="text-[10px] text-zinc-400 italic mt-1.5">Sin notas registradas</p>
                                            )}
                                        </div>
                                        );
                                    })}
                                </div>
                                ); })()}
                        </div>

                        <div className="px-5 py-3 border-t border-zinc-100 flex items-center justify-between">
                            <p className="text-[10px] text-zinc-400">
                                {customerHistory.tickets.length} ticket{customerHistory.tickets.length !== 1 ? 's' : ''} encontrado{customerHistory.tickets.length !== 1 ? 's' : ''}
                            </p>
                            <button
                                onClick={() => { historyAbortRef.current = true; setShowHistoryModal(false); setHistoryFilter(''); }}
                                className="px-5 py-2 bg-zinc-900 text-white text-[11px] font-black uppercase rounded-xl hover:bg-zinc-700 transition-colors"
                            >
                                Entendido
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal de Edición (Restaurado) */}
            {isEditModalOpen && selectedTask && (() => {
                const proc = selectedTask.workflow_activities?.workflow_processes;
                const metadata = proc?.metadata || {};

                // Mapeo robusto de prioridad y estado (de string a ID)
                const pMap: Record<string, number> = { "Baja": 1, "Normal": 2, "Media": 2, "Alta": 3, "Muy Alta": 4 };
                const eMap: Record<string, number> = { "Abierto": 1, "En Progreso": 2, "Resuelto": 3, "Cerrado": 4 };

                const ticketData = {
                    id: proc?.reference_id,
                    asunto: metadata.asunto || proc?.title || '',
                    id_prioridad: metadata.id_prioridad || metadata.prioridad_id || pMap[proc?.priority as string] || pMap[metadata.prioridad] || 2,
                    id_estado: metadata.id_estado || metadata.estado_id || eMap[metadata.estado] || 1,
                    tecnico_id: metadata.tecnico?.id || metadata.tecnico_id || '',
                    tecnico_usuario: metadata.tecnico_usuario || '',
                    nombre_tecnico: metadata.nombre_tecnico || '',
                    descripcion: metadata.descripcion || '',
                    fecha_estimada_inicio: metadata.fecha_estimada_inicio || '',
                    fecha_estimada_fin: metadata.fecha_estimada_fin || '',
                    nombre_cliente: metadata.nombre_cliente || 'Desconocido'
                };

                return (
                    <EditTicketModal
                        onClose={() => {
                            setIsEditModalOpen(false);
                            setSelectedTask(null);
                        }}
                        ticket={ticketData}
                        onUpdate={() => {
                            setIsEditModalOpen(false);
                            setSelectedTask(null);
                            loadMyTasks();
                        }}
                    />
                );
            })()}
        </div>
    );
}
