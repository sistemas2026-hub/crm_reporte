import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
    Search, Calendar, RefreshCcw,
    ChevronLeft, ChevronRight, Users, Filter,
    CheckSquare, Square, AlertCircle, Loader2, X,
    ArrowRight, Zap, ClipboardList, History, Clock, CheckCircle2, Activity, Eye
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { WorkflowService } from '../lib/workflowService';
import { WisphubService } from '../lib/wisphub';
import { OperationsHeader } from '../components/operations/OperationsHeader';
import { orgService } from '../lib/orgService';
import clsx from 'clsx';

// ─── Column search helpers ────────────────────────────────────────────────────

function ColSearch({ value, onChange, placeholder }: {
    value: string; onChange: (v: string) => void; placeholder: string;
}) {
    return (
        <div className="relative">
            <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-zinc-300 pointer-events-none" />
            <input
                type="text"
                value={value}
                onChange={e => onChange(e.target.value)}
                placeholder={placeholder}
                className="w-full pl-6 pr-2 py-1 text-[10px] border border-zinc-200 rounded-lg outline-none focus:border-zinc-400 bg-white font-medium placeholder:text-zinc-300 transition-colors"
            />
            {value && (
                <button
                    onClick={() => onChange('')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-zinc-300 hover:text-zinc-600"
                >
                    <X size={10} />
                </button>
            )}
        </div>
    );
}

function Highlight({ text, query }: { text: string; query: string }) {
    const q = query.trim().toLowerCase();
    if (!q || !text) return <>{text}</>;
    const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const idx = norm(text).indexOf(norm(q));
    if (idx === -1) return <>{text}</>;
    return (
        <>
            {text.slice(0, idx)}
            <mark className="bg-yellow-200 text-zinc-900 rounded px-0.5 not-italic">{text.slice(idx, idx + q.length)}</mark>
            {text.slice(idx + q.length)}
        </>
    );
}

// ─── SLA helpers ──────────────────────────────────────────────────────────────

interface SlaConfig { max_hours: number; threshold_pct: number; }
type SlaStatus = 'ok' | 'warning' | 'critical';

function getSlaInfo(
    createdAt: string,
    ticketType: string,
    slaMap: Record<string, SlaConfig>
): { hoursOpen: number; pct: number; status: SlaStatus; maxHours: number } {
    const isolated = ticketType.includes(' - ') ? ticketType.split(' - ')[0] : ticketType;
    const key = isolated.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();
    const cfg = slaMap[key] || slaMap['ADMINISTRATIVO'] || { max_hours: 24, threshold_pct: 80 };
    const hoursOpen = (Date.now() - new Date(createdAt).getTime()) / 3_600_000;
    const pct = Math.min(Math.round((hoursOpen / cfg.max_hours) * 100), 999);
    const status: SlaStatus = pct >= 100 ? 'critical' : pct >= cfg.threshold_pct ? 'warning' : 'ok';
    return { hoursOpen: Math.round(hoursOpen * 10) / 10, pct, status, maxHours: cfg.max_hours };
}

const REMOTE_TESTS = [
    'Ping exitoso al router del cliente',
    'Speed test realizado (bajada/subida)',
    'Reinicio remoto de OLT/puerto',
    'Revisión de señal óptica en SmartOLT',
    'Verificación de VLAN y configuración',
    'Contacto telefónico con el cliente',
];

export function OperationsSupervision() {
    // ── Datos principales
    const [processes, setProcesses] = useState<any[]>([]);
    const [platformUsers, setPlatformUsers] = useState<any[]>([]);
    const [slaMap, setSlaMap] = useState<Record<string, SlaConfig>>({});
    const [loading, setLoading] = useState(false);
    const [totalCount, setTotalCount] = useState(0);
    const [page, setPage] = useState(0);
    const [pageSize, setPageSize] = useState<25 | 50 | 100 | 9999>(50);

    // ── Pestañas de estado
    const [activeTab, setActiveTab] = useState<'todos' | 'pendientes' | 'en_progreso' | 'en_validacion' | 'finalizados'>('todos');

    // ── Filtro de ubicación (campo / oficina / todos)
    const [filterLocation, setFilterLocation] = useState<'all' | 'campo' | 'oficina'>('all');

    // ── Historial de actividad
    const [historyProcess, setHistoryProcess] = useState<any | null>(null);
    const [historyLogs, setHistoryLogs] = useState<any[]>([]);
    const [historyLoading, setHistoryLoading] = useState(false);

    // ── Finalizar ticket (supervisor)
    const [closeTarget, setCloseTarget] = useState<any | null>(null);
    const [closeNote, setCloseNote] = useState('');
    const [closeStatusId, setCloseStatusId] = useState<3 | 4>(4);
    const [closing, setClosing] = useState(false);

    // ── Validar ticket (supervisor)
    const [validateTarget, setValidateTarget] = useState<any | null>(null);
    const [validateNote, setValidateNote] = useState('');
    const [validating, setValidating] = useState(false);
    const [validateHistory, setValidateHistory] = useState<any[]>([]);
    const [validateHistoryLoading, setValidateHistoryLoading] = useState(false);
    const [showRejectForm, setShowRejectForm] = useState(false);
    const [rejectNote, setRejectNote] = useState('');
    const [rejecting, setRejecting] = useState(false);

    // ── Filtros
    const [searchTerm, setSearchTerm] = useState('');
    const [filterTech, setFilterTech] = useState('');
    const [filterBarrio, setFilterBarrio] = useState('');
    const [filterEscalated, setFilterEscalated] = useState<'all' | 'yes' | 'no'>('all');
    const [dateRange, setDateRange] = useState({
        start: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        end: new Date().toISOString().split('T')[0],
    });

    // ── Bulk reassign
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [bulkTech, setBulkTech] = useState('');
    const [bulkReassigning, setBulkReassigning] = useState(false);
    const [bulkResult, setBulkResult] = useState<string | null>(null);

    // ── Filtros por columna (client-side)
    const [colFilters, setColFilters] = useState({ cliente: '', creacion: '', asunto: '', barrio: '', responsable: '', estado: '', escaladoA: '' });
    const setCol = (k: keyof typeof colFilters, v: string) => setColFilters(prev => ({ ...prev, [k]: v }));

    // ── Detalle de ticket
    const [detailProcess, setDetailProcess] = useState<any | null>(null);
    const [detailWisphubHistory, setDetailWisphubHistory] = useState<any[]>([]);
    const [detailWisphubLoading, setDetailWisphubLoading] = useState(false);

    // ── Transferencia a Campo
    const [transferTarget, setTransferTarget] = useState<any | null>(null);
    const [transferNote, setTransferNote] = useState('');
    const [transferTech, setTransferTech] = useState('');
    const [transferring, setTransferring] = useState(false);
    const [remoteTestsDone, setRemoteTestsDone] = useState<string[]>([]);

    // ── SLA alert ref (evita duplicar alertas)
    const slaAlertedRef = useRef<Set<string>>(new Set());

    // ── Flag de carga secuencial: el filtro NO corre hasta que usuarios estén listos
    const [platformUsersReady, setPlatformUsersReady] = useState(false);

    // ── Cleanup legacy cache al montar (ver memoria técnica §11)
    useEffect(() => {
        try {
            Object.keys(localStorage).forEach(k => {
                if (k.startsWith('supervision_cache_')) localStorage.removeItem(k);
            });
        } catch (_) { /* ignorar */ }
    }, []);

    // ── Supabase Realtime: actualizaciones instantáneas sin polling
    useEffect(() => {
        const channel = supabase
            .channel('supervision-realtime')
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'workflow_processes',
            }, (payload) => {
                setProcesses(prev => [payload.new as any, ...prev]);
                setTotalCount(prev => prev + 1);
            })
            .on('postgres_changes', {
                event: 'UPDATE',
                schema: 'public',
                table: 'workflow_processes',
            }, (payload) => {
                setProcesses(prev =>
                    prev.map(p => p.id === (payload.new as any).id
                        ? { ...p, ...payload.new, metadata: { ...(p.metadata || {}), ...((payload.new as any).metadata || {}) } }
                        : p)
                );
            })
            .subscribe();

        return () => { supabase.removeChannel(channel); };
    }, []);

    // ── Alerta sonora cuando un ticket llega al 100% de SLA
    useEffect(() => {
        if (processes.length === 0 || Object.keys(slaMap).length === 0) return;

        const criticalNew = processes.filter(p => {
            const type = p.title?.split(' - ')[0] || p.metadata?.asunto || '';
            return getSlaInfo(p.created_at, type, slaMap).status === 'critical'
                && !slaAlertedRef.current.has(p.id);
        });

        if (criticalNew.length > 0) {
            criticalNew.forEach(p => slaAlertedRef.current.add(p.id));
            try {
                const ctx = new AudioContext();
                [880, 1100, 880].forEach((freq, i) => {
                    const osc = ctx.createOscillator();
                    const gain = ctx.createGain();
                    osc.connect(gain);
                    gain.connect(ctx.destination);
                    osc.frequency.value = freq;
                    const t = ctx.currentTime + i * 0.25;
                    gain.gain.setValueAtTime(0.25, t);
                    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
                    osc.start(t);
                    osc.stop(t + 0.2);
                });
            } catch (_) { /* AudioContext bloqueado por política del navegador */ }
        }
    }, [processes, slaMap]);

    // ── Carga (y recarga) de usuarios de plataforma
    const reloadPlatformUsers = useCallback(async () => {
        const users = await WorkflowService.getPlatformUsers();
        if (users) {
            setPlatformUsers(users);
            setPlatformUsersReady(true);
            console.log(`[Supervision] ✅ platformUsers listos: ${users.length} usuarios`);
            console.log('[Supervision] strategic_locations:', users.map(u => `${u.full_name}=${u.strategic_location ?? 'null'}`));
        }
    }, []);

    // ── Cargar SLA config y usuarios una sola vez al montar
    useEffect(() => {
        reloadPlatformUsers();

        (async () => {
            const org = await orgService.getSettings().catch(() => null);
            if (org?.org_id) {
                const { data } = await supabase
                    .from('sla_config')
                    .select('ticket_type, max_hours, threshold_pct')
                    .eq('org_id', org.org_id);
                if (data) {
                    const map: Record<string, SlaConfig> = {};
                    data.forEach((r: any) => {
                        map[r.ticket_type.toUpperCase()] = {
                            max_hours: r.max_hours,
                            threshold_pct: r.threshold_pct,
                        };
                    });
                    setSlaMap(map);
                }
            }
        })();
    }, [reloadPlatformUsers]);

    // ── Escuchar guardados desde Configuration para refrescar usuarios sin recargar
    useEffect(() => {
        const handleUsersUpdated = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            console.log(`[Supervision] 🔄 Recibido supervision:users-updated para ${detail?.userId} → strategic_location="${detail?.strategic_location}". Recargando usuarios...`);
            reloadPlatformUsers();
        };
        window.addEventListener('supervision:users-updated', handleUsersUpdated);
        return () => window.removeEventListener('supervision:users-updated', handleUsersUpdated);
    }, [reloadPlatformUsers]);

    const loadPage = useCallback(async () => {
        setLoading(true);
        setProcesses([]); // Limpiar antes de cargar para evitar diff masivo de DOM
        try {
            let query = supabase
                .from('workflow_processes')
                .select(`
                    id, reference_id, created_at, title, process_type, status, metadata, escalation_level,
                    workflow_activities(name, status, workflow_workitems(id, participant_id, status))
                `, { count: 'exact' })
                .eq('process_type', 'Ticket AXCES')
                .eq('status', activeTab === 'finalizados' ? 'CO' : 'PE')
                .order('created_at', { ascending: false })
                .range(page * pageSize, (page + 1) * pageSize - 1);

            // Para tickets activos (PE) no aplicamos filtro de fecha: pueden ser históricos.
            // Solo los finalizados se filtran por rango para no cargar años de registros cerrados.
            if (activeTab === 'finalizados') {
                query = query
                    .gte('created_at', dateRange.start)
                    .lte('created_at', dateRange.end + 'T23:59:59');
            }

            if (filterEscalated === 'yes') query = query.gte('escalation_level', 2);
            if (filterEscalated === 'no') query = query.lt('escalation_level', 2);
            if (filterBarrio) query = (query as any).ilike('metadata->>barrio', `%${filterBarrio}%`);
            if (searchTerm) query = (query as any).or(
                `reference_id.ilike.%${searchTerm}%,title.ilike.%${searchTerm}%,metadata->>nombre_cliente.ilike.%${searchTerm}%`
            );

            const { data, error, count } = await query;
            if (!error && data) {
                setProcesses(data as any[]);
                setTotalCount(count || 0);
            }
        } finally {
            setLoading(false);
        }
    }, [dateRange, page, pageSize, filterEscalated, filterBarrio, searchTerm, activeTab]);

    // ── Escuchar escalamientos desde MyTasks para refrescar procesos/conteos
    useEffect(() => {
        const handleProcessesUpdated = (e: Event) => {
            const detail = (e as CustomEvent).detail;
            console.log(`[Supervision] 🔄 Recibido supervision:processes-updated — ticket #${detail?.ticketId} escalado. Recargando procesos...`);
            loadPage();
        };
        window.addEventListener('supervision:processes-updated', handleProcessesUpdated);
        return () => window.removeEventListener('supervision:processes-updated', handleProcessesUpdated);
    }, [loadPage]);

    useEffect(() => {
        setPage(0);
    }, [dateRange, filterEscalated, filterBarrio, searchTerm, pageSize, activeTab, filterLocation]);

    useEffect(() => {
        loadPage();
    }, [loadPage]);

    // Normaliza texto: minúsculas + sin acentos + sin espacios extra
    // "LUCÍA ACUÑA" → "lucia acuna" para comparación flexible
    const normalizeText = (s: string) =>
        String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

    // ── Mapa de búsqueda rápida O(1): todas las claves posibles → usuario
    const userByKey = useMemo(() => {
        const map = new Map<string, any>();
        for (const u of platformUsers) {
            // Claves exactas
            if (u.id)         map.set(String(u.id).toLowerCase().trim(), u);
            if (u.email)      map.set(String(u.email).toLowerCase().trim(), u);
            // wisphub_id = "Usuario WispHub (Mapping)" — clave principal de cruce
            if (u.wisphub_id) map.set(String(u.wisphub_id).toLowerCase().trim(), u);
            if (u.wisphub_id) map.set(normalizeText(u.wisphub_id), u);
            // Nombre completo normalizado (sin acentos) para cruce con nombre_tecnico de WispHub
            if (u.full_name)     map.set(normalizeText(u.full_name), u);
            if (u.display_name)  map.set(normalizeText(u.display_name), u);
        }
        return map;
    }, [platformUsers]);

    // ── Enriquecimiento + filtrado por pestaña + filtro de técnico
    const filtered = useMemo(() => {
        // Debug: exponer en window para diagnóstico desde consola
        (window as any).__debugProcesses     = processes;
        (window as any).__debugPlatformUsers = platformUsers;
        (window as any).__debugUserByKey     = userByKey;

        // Carga secuencial: no filtrar hasta que platformUsers esté 100% listo
        if (!platformUsersReady) {
            console.log('[Supervision] ⏳ Esperando carga de usuarios...');
            return [];
        }

        console.log(`[Supervision] useMemo → processes: ${processes.length}, usuarios: ${platformUsers.length}, claves mapa: ${userByKey.size}`);
        if (processes.length > 0) {
            console.log('[Supervision] metadata[0]:', JSON.stringify(processes[0]?.metadata ?? {}));
        }

        let _dbgN = 0; // contador para limitar debug extremo a los primeros 5 tickets

        const enriched = processes.map(p => {
            _dbgN++;
            const isDeep = _dbgN <= 5; // LOG EXTREMO solo en primeros 5
            const ref = p.reference_id || p.id.slice(0, 8);

            let assignedUser: any = null;
            let matchSource = '';

            // Extracción con conversión explícita a String para evitar fallos number vs string
            const nombreTecnico = String(p.metadata?.nombre_tecnico ?? '').trim();
            const emailTecnico  = String(p.metadata?.email_tecnico  ?? '').trim();
            // id_tecnico puede llegar como number 123 o string "123" — String() normaliza ambos
            const rawId = p.metadata?.id_tecnico ?? p.metadata?.tecnico?.id ?? p.metadata?.tecnico_asignado?.id;
            const idTecnico = rawId != null ? String(rawId).trim() : null;
            const normNombre = normalizeText(nombreTecnico);

            if (isDeep) {
                console.group(`%c[Supervision][DEEP #${_dbgN}] Ticket #${ref}`, 'color:#7c3aed;font-weight:bold');
                console.log('📋 Nombre en Ticket (raw):', JSON.stringify(p.metadata?.nombre_tecnico), '→ String limpio:', JSON.stringify(nombreTecnico));
                console.log('🔢 ID Técnico en Ticket (raw):', JSON.stringify(rawId), '→ typeof:', typeof rawId, '→ String limpio:', JSON.stringify(idTecnico));
                console.log('📧 Email Técnico en Ticket:', JSON.stringify(emailTecnico) || '(vacío)');
                console.log('🔡 normNombre (para match):', JSON.stringify(normNombre) || '(VACÍO — saltará estrategias 1-3)');
                console.log('👥 platformUsers cargados:', platformUsers.length);
                console.log('🗝️ Claves userByKey (muestra 15):', [...userByKey.keys()].slice(0, 15));
                console.log('🗂️ metadata completa:', JSON.stringify(p.metadata ?? {}));
            }

            // ── ESTRATEGIA PRIMARIA: nombre_tecnico es la llave principal ──────
            // El id_tecnico puede ser null — el nombre manda sobre el ID.

            // 1. Nombre exacto normalizado → map (full_name, display_name, wisphub_id)
            if (!assignedUser && normNombre) {
                const candidate = userByKey.get(normNombre) ?? null;
                if (isDeep) console.log(`  [S1] nombre_exacto "${normNombre}" →`, candidate ? `✅ ${candidate.full_name}` : '❌ no encontrado');
                if (candidate) { assignedUser = candidate; matchSource = `nombre_exacto="${nombreTecnico}"`; }
            }

            // 2. Nombre parcial: el nombre del ticket contiene el full_name del perfil
            if (!assignedUser && normNombre) {
                const candidate = platformUsers.find(u => {
                    const uNorm = normalizeText(u.full_name || u.display_name || '');
                    return uNorm && normNombre.includes(uNorm);
                }) ?? null;
                if (isDeep) console.log(`  [S2] nombre_contiene →`, candidate ? `✅ ${candidate.full_name}` : '❌ no encontrado');
                if (candidate) { assignedUser = candidate; matchSource = `nombre_contiene="${nombreTecnico}"`; }
            }

            // 3. Full_name del perfil contiene el nombre del ticket (orden inverso)
            if (!assignedUser && normNombre) {
                const candidate = platformUsers.find(u => {
                    const uNorm = normalizeText(u.full_name || u.display_name || '');
                    return uNorm && uNorm.includes(normNombre);
                }) ?? null;
                if (isDeep) console.log(`  [S3] nombre_invertido →`, candidate ? `✅ ${candidate.full_name}` : '❌ no encontrado');
                if (candidate) { assignedUser = candidate; matchSource = `nombre_invertido="${nombreTecnico}"`; }
            }

            // ── ESTRATEGIAS SECUNDARIAS: email, ID, workitems ─────────────────

            // 4. email_tecnico directo
            if (!assignedUser && emailTecnico) {
                const candidate = userByKey.get(emailTecnico.toLowerCase()) ?? null;
                if (isDeep) console.log(`  [S4] email_tecnico "${emailTecnico}" →`, candidate ? `✅ ${candidate.full_name}` : '❌ no encontrado');
                if (candidate) { assignedUser = candidate; matchSource = `email_tecnico="${emailTecnico}"`; }
            }

            // 5. wisphub_id vs email_tecnico
            if (!assignedUser && emailTecnico) {
                const candidate = platformUsers.find(u =>
                    u.wisphub_id && String(u.wisphub_id).trim().toLowerCase() === emailTecnico.toLowerCase()
                ) ?? null;
                if (isDeep) console.log(`  [S5] wisphub_id≈email →`, candidate ? `✅ ${candidate.full_name}` : '❌ no encontrado');
                if (candidate) { assignedUser = candidate; matchSource = `wisphub_id≈email="${emailTecnico}"`; }
            }

            // 6. id_tecnico numérico (String-safe: "123" === "123" aunque venga como number)
            if (!assignedUser && idTecnico) {
                const candidate = userByKey.get(idTecnico.toLowerCase()) ?? null;
                if (isDeep) console.log(`  [S6] id_tecnico "${idTecnico}" en mapa →`, candidate ? `✅ ${candidate.full_name}` : '❌ no encontrado');
                // Búsqueda adicional por wisphub_id directo (recorre array si el mapa no lo tiene)
                const candidateWH = !candidate
                    ? platformUsers.find(u => String(u.wisphub_id ?? '').trim() === idTecnico) ?? null
                    : null;
                if (isDeep && candidateWH) console.log(`  [S6b] wisphub_id directo "${idTecnico}" →`, `✅ ${candidateWH.full_name}`);
                const final = candidate ?? candidateWH;
                if (final) { assignedUser = final; matchSource = `id_tecnico="${idTecnico}"`; }
            }

            // 7. participant_id de workitems (UUID / email / wisphub_id)
            if (!assignedUser) {
                const allWorkItems = (p.workflow_activities || []).flatMap((a: any) => a.workflow_workitems || []);
                for (const wi of allWorkItems) {
                    if (!wi.participant_id) continue;
                    const candidate = userByKey.get(String(wi.participant_id).toLowerCase().trim()) ?? null;
                    if (candidate) { assignedUser = candidate; matchSource = `participant_id="${wi.participant_id}"`; break; }
                }
                if (isDeep) console.log(`  [S7] workitems(${allWorkItems.length}) →`, assignedUser ? `✅ ${assignedUser.full_name} via ${matchSource}` : '❌ sin match');
            }

            // Inyección de ubicación (String explícito, sin utilidad intermedia)
            const loc = assignedUser?.strategic_location
                ? String(assignedUser.strategic_location).toLowerCase().trim()
                : null;

            const rawWisphubName = nombreTecnico || emailTecnico;

            // ── LOG EXTREMO: resumen de decisión ──────────────────────────────
            if (isDeep) {
                console.log('─────────────────────────────────────────');
                console.log('👤 Usuario Encontrado:', assignedUser
                    ? `${assignedUser.full_name || assignedUser.display_name} (via ${matchSource})`
                    : 'NADIE');
                console.log('📍 Ubicación del Usuario:', assignedUser
                    ? (assignedUser.strategic_location ?? '⚠️ null — campo strategic_location NO configurado en perfil')
                    : 'N/A — sin match');
                const tabResult = loc === 'campo'
                    ? '→ CAMPO ✅'
                    : loc === 'oficina'
                        ? '→ OFICINA (strategic_location=oficina)'
                        : assignedUser
                            ? '→ OFICINA ⚠️ (usuario encontrado pero strategic_location es null/vacío)'
                            : '→ OFICINA (sin match de usuario)';
                console.log(`🎯 Resultado del Filtro: ${tabResult}`);
                if (loc !== 'campo' && assignedUser) {
                    console.warn(`  ⚠️ ACCIÓN: ir a Configuración → perfil de "${assignedUser.full_name}" → cambiar Ubicación Estratégica a "Campo"`);
                }
                console.groupEnd();
            }

            return {
                ...p,
                __assignedUser:      assignedUser,
                __strategicLocation: loc,
                __unmatched:         !assignedUser,
                __techDisplayName:   rawWisphubName || assignedUser?.display_name || '',
            };
        });

        // Filtro por sub-pestaña de estado
        const isStartedFn = (p: any) =>
            !!p.metadata?.started_at ||
            p.metadata?.id_estado === 2 ||
            p.metadata?.estado === 'En Progreso';

        const byTab = enriched.filter(p => {
            if (activeTab === 'todos') return true;
            const isStarted    = isStartedFn(p);
            const isFinished   = p.status === 'Completed' || p.status === 'Cerrado'
                || p.metadata?.id_estado === 3 || p.metadata?.id_estado === 4
                || p.metadata?.estado === 'Resuelto' || p.metadata?.estado === 'Cerrado';
            const isValidation = !!p.metadata?.pending_validation && !isFinished;
            if (activeTab === 'pendientes')    return !isFinished && !isStarted && !isValidation;
            if (activeTab === 'en_progreso')   return !isFinished && isStarted && !isValidation;
            if (activeTab === 'en_validacion') return isValidation;
            if (activeTab === 'finalizados')   return isFinished;
            return true;
        });

        // Filtro por ubicación (campo / oficina)
        const byLocation = filterLocation === 'all'
            ? byTab
            : byTab.filter(p =>
                filterLocation === 'campo'
                    ? p.__strategicLocation === 'campo'
                    : p.__strategicLocation !== 'campo'  // oficina = todo lo que no es campo
            );

        // Filtro por técnico en barra de búsqueda (5 campos)
        let byTech = byLocation;
        if (filterTech.trim()) {
            const q = normalizeText(filterTech);
            byTech = byLocation.filter(p =>
                normalizeText(p.__techDisplayName).includes(q) ||
                normalizeText(p.metadata?.email_tecnico  || '').includes(q) ||
                normalizeText(p.metadata?.nombre_tecnico || '').includes(q) ||
                normalizeText(p.__assignedUser?.email    || '').includes(q) ||
                normalizeText(String(p.__assignedUser?.wisphub_id || '')).includes(q)
            );
        }

        // Filtros por columna individuales
        const cfs = colFilters;
        if (!Object.values(cfs).some(v => v.trim())) return byTech;
        return byTech.filter(p => {
            if (cfs.cliente.trim()) {
                const q = normalizeText(cfs.cliente);
                const match =
                    normalizeText(p.metadata?.nombre_cliente || '').includes(q) ||
                    normalizeText(String(p.reference_id || '')).includes(q) ||
                    normalizeText(p.title || '').includes(q);
                if (!match) return false;
            }
            if (cfs.creacion.trim()) {
                const d = new Date(p.created_at);
                const formatted = d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
                const iso = p.created_at.slice(0, 10);
                if (!formatted.includes(cfs.creacion) && !iso.includes(cfs.creacion)) return false;
            }
            if (cfs.asunto.trim()) {
                const tipo = p.title || p.metadata?.asunto || p.process_type || '';
                if (!normalizeText(tipo).includes(normalizeText(cfs.asunto))) return false;
            }
            if (cfs.barrio.trim()) {
                const zona = `${p.metadata?.barrio || ''} ${p.metadata?.zona || ''}`;
                if (!normalizeText(zona).includes(normalizeText(cfs.barrio))) return false;
            }
            if (cfs.responsable.trim()) {
                if (!normalizeText(p.__techDisplayName || '').includes(normalizeText(cfs.responsable))) return false;
            }
            if (cfs.estado.trim()) {
                const isFinished = p.status === 'Completed' || p.status === 'Cerrado'
                    || p.metadata?.id_estado === 3 || p.metadata?.id_estado === 4
                    || p.metadata?.estado === 'Resuelto' || p.metadata?.estado === 'Cerrado';
                const isStarted = !!p.metadata?.started_at || p.metadata?.id_estado === 2 || p.metadata?.estado === 'En Progreso';
                const label = isFinished ? 'completado' : isStarted ? 'en progreso' : 'abierto';
                if (!label.includes(normalizeText(cfs.estado))) return false;
            }
            if (cfs.escaladoA.trim()) {
                const escalLabel = p.metadata?.escalated_to || ((p.escalation_level ?? 0) >= 2 ? `Nivel ${p.escalation_level}` : '');
                if (!normalizeText(escalLabel).includes(normalizeText(cfs.escaladoA))) return false;
            }
            return true;
        });
    }, [processes, platformUsers, userByKey, platformUsersReady, activeTab, filterLocation, filterTech, colFilters]);

    // ── Conteos por pestaña de estado
    const tabCounts = useMemo(() => {
        const counts = { todos: processes.length, pendientes: 0, en_progreso: 0, en_validacion: 0, finalizados: 0 };
        for (const p of processes) {
            const isStarted    = !!p.metadata?.started_at || p.metadata?.id_estado === 2 || p.metadata?.estado === 'En Progreso';
            const isFinished   = p.status === 'Completed' || p.status === 'Cerrado'
                || p.metadata?.id_estado === 3 || p.metadata?.id_estado === 4
                || p.metadata?.estado === 'Resuelto' || p.metadata?.estado === 'Cerrado';
            const isValidation = !!p.metadata?.pending_validation && !isFinished;
            if (isFinished)        counts.finalizados++;
            else if (isValidation) counts.en_validacion++;
            else if (isStarted)    counts.en_progreso++;
            else                   counts.pendientes++;
        }
        return counts;
    }, [processes]);

    // ── Selección bulk
    const allSelected = filtered.length > 0 && filtered.every(p => selectedIds.has(p.id));
    const toggleAll = () => {
        if (allSelected) {
            setSelectedIds(prev => { const s = new Set(prev); filtered.forEach(p => s.delete(p.id)); return s; });
        } else {
            setSelectedIds(prev => { const s = new Set(prev); filtered.forEach(p => s.add(p.id)); return s; });
        }
    };
    const toggleOne = (id: string) => {
        setSelectedIds(prev => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });
    };

    // ── Reasignación masiva con reporte por lote
    const handleBulkReassign = async () => {
        if (!bulkTech || selectedIds.size === 0) return;
        setBulkReassigning(true);
        setBulkResult(null);
        const ids = Array.from(selectedIds);

        const updates = ids.map(id =>
            supabase
                .from('workflow_processes')
                .update({ escalation_level: 1, updated_at: new Date().toISOString() })
                .eq('id', id)
        );
        const settled = await Promise.allSettled(updates);
        const ok = settled.filter(r => r.status === 'fulfilled').length;
        const fail = settled.length - ok;
        setBulkResult(
            `✅ ${ok} ticket${ok !== 1 ? 's' : ''} reasignado${ok !== 1 ? 's' : ''} a ${bulkTech}` +
            (fail > 0 ? ` · ❌ ${fail} fallaron` : '')
        );
        setSelectedIds(new Set());
        setBulkTech('');
        setBulkReassigning(false);
        loadPage();
    };

    // ── Derivar ticket a Campo
    const handleTransfer = async () => {
        if (!transferTarget || transferNote.trim().length < 50 || !transferTech) return;
        setTransferring(true);
        try {
            await supabase
                .from('workflow_processes')
                .update({
                    metadata: {
                        ...transferTarget.metadata,
                        mode: 'operativo',
                        transfer_note: transferNote.trim(),
                        transferred_from: 'oficina',
                        transferred_at: new Date().toISOString(),
                        remote_tests_done: remoteTestsDone,
                        field_technician: transferTech,
                    },
                    updated_at: new Date().toISOString(),
                })
                .eq('id', transferTarget.id);

            setTransferTarget(null);
            setTransferNote('');
            setTransferTech('');
            setRemoteTestsDone([]);
            loadPage();
        } finally {
            setTransferring(false);
        }
    };

    const totalPages = Math.ceil(totalCount / pageSize);

    // ── Combobox: usuarios que coinciden con lo escrito
    const bulkDropdownUsers = bulkTech.length > 0
        ? platformUsers
            .filter(u =>
                (u.display_name?.toLowerCase().includes(bulkTech.toLowerCase()) ||
                 u.email?.toLowerCase().includes(bulkTech.toLowerCase())) &&
                u.email !== bulkTech
            )
            .slice(0, 8)
        : [];

    // ── Técnicos de campo para el modal de transferencia
    const fieldTechnicians = platformUsers.filter(u =>
        u.strategic_location === 'campo'
    );

    return (
        <div className="space-y-6">
            {/* ── Pestañas de estado + toggle campo/oficina ── */}
            <div className="flex items-center gap-1 border-b border-zinc-200">
                {([
                    { key: 'todos',          label: 'Todos',        icon: <Filter size={12} /> },
                    { key: 'pendientes',     label: 'Pendientes',   icon: <Zap size={12} /> },
                    { key: 'en_progreso',    label: 'En Progreso',  icon: <RefreshCcw size={12} /> },
                    { key: 'en_validacion',  label: 'En Validación', icon: <Activity size={12} /> },
                    { key: 'finalizados',    label: 'Finalizados',  icon: <CheckSquare size={12} /> },
                ] as const).map(tab => (
                    <button
                        key={tab.key}
                        onClick={() => { setActiveTab(tab.key); setSelectedIds(new Set()); }}
                        className={clsx(
                            'flex items-center gap-2 px-5 py-2.5 text-xs font-black uppercase tracking-widest border-b-2 -mb-px transition-all',
                            activeTab === tab.key
                                ? 'border-zinc-900 text-zinc-900'
                                : 'border-transparent text-zinc-400 hover:text-zinc-600'
                        )}
                    >
                        {tab.icon} {tab.label}
                        {tabCounts[tab.key] > 0 && (
                            <span className="ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-black bg-zinc-900 text-white leading-none">
                                {tabCounts[tab.key]}
                            </span>
                        )}
                    </button>
                ))}

                {/* Toggle Campo / Oficina */}
                <div className="ml-auto flex items-center gap-1 mb-1 bg-zinc-100 rounded-xl p-1">
                    {([
                        { key: 'all',    label: 'Todos' },
                        { key: 'campo',  label: 'Campo' },
                        { key: 'oficina', label: 'Oficina' },
                    ] as const).map(loc => (
                        <button
                            key={loc.key}
                            onClick={() => { setFilterLocation(loc.key); setSelectedIds(new Set()); }}
                            className={clsx(
                                'px-3 py-1 rounded-lg text-[10px] font-black uppercase tracking-wide transition-all',
                                filterLocation === loc.key
                                    ? 'bg-white text-zinc-900 shadow-sm border border-zinc-200'
                                    : 'text-zinc-400 hover:text-zinc-600'
                            )}
                        >
                            {loc.label}
                        </button>
                    ))}
                </div>
            </div>

            <OperationsHeader
                title="Supervisión"
                description="Consola de administración y seguimiento de procesos operativos."
                onSyncComplete={loadPage}
            />

            {/* ── Panel de filtros ── */}
            <div className="bg-white border border-zinc-200 rounded-2xl p-4 shadow-sm">
                <div className="flex flex-wrap gap-3 items-end">
                    {/* Rango de fechas */}
                    <div className="flex items-center gap-2 text-xs text-zinc-500 font-medium bg-zinc-50 px-3 py-2 rounded-xl border border-zinc-100">
                        <Calendar size={12} className="text-zinc-400" />
                        <input
                            type="date"
                            value={dateRange.start}
                            onChange={e => setDateRange(p => ({ ...p, start: e.target.value }))}
                            className="bg-transparent border-none p-0 text-xs focus:ring-0 text-zinc-700 font-bold cursor-pointer w-28"
                        />
                        <span className="text-zinc-300">→</span>
                        <input
                            type="date"
                            value={dateRange.end}
                            onChange={e => setDateRange(p => ({ ...p, end: e.target.value }))}
                            className="bg-transparent border-none p-0 text-xs focus:ring-0 text-zinc-700 font-bold cursor-pointer w-28"
                        />
                        {loading && <RefreshCcw size={12} className="animate-spin text-blue-500 ml-1" />}
                    </div>

                    {/* Búsqueda */}
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={13} />
                        <input
                            type="text"
                            placeholder="ID, cliente..."
                            value={searchTerm}
                            onChange={e => setSearchTerm(e.target.value)}
                            className="bg-white border border-zinc-200 rounded-xl py-2 pl-8 pr-3 text-xs font-medium outline-none focus:border-zinc-400 w-44 placeholder:text-zinc-300"
                        />
                    </div>

                    {/* Filtro técnico */}
                    <div className="relative">
                        <Users className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={13} />
                        <input
                            type="text"
                            placeholder="Técnico..."
                            value={filterTech}
                            onChange={e => setFilterTech(e.target.value)}
                            className="bg-white border border-zinc-200 rounded-xl py-2 pl-8 pr-3 text-xs font-medium outline-none focus:border-zinc-400 w-40 placeholder:text-zinc-300"
                        />
                    </div>

                    {/* Filtro barrio */}
                    <div className="relative">
                        <Filter className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" size={13} />
                        <input
                            type="text"
                            placeholder="Barrio / Zona..."
                            value={filterBarrio}
                            onChange={e => setFilterBarrio(e.target.value)}
                            className="bg-white border border-zinc-200 rounded-xl py-2 pl-8 pr-3 text-xs font-medium outline-none focus:border-zinc-400 w-40 placeholder:text-zinc-300"
                        />
                    </div>

                    {/* Filtro escalamiento */}
                    <select
                        value={filterEscalated}
                        onChange={e => setFilterEscalated(e.target.value as any)}
                        className="bg-white border border-zinc-200 rounded-xl py-2 px-3 text-xs font-bold outline-none focus:border-zinc-400 cursor-pointer text-zinc-700"
                    >
                        <option value="all">Todos (interno + externo)</option>
                        <option value="yes">Solo Escalados ≥N2</option>
                        <option value="no">Solo Internos N1</option>
                    </select>

                    {/* Selector de registros por página */}
                    <select
                        value={pageSize}
                        onChange={e => { setPageSize(Number(e.target.value) as 25 | 50 | 100 | 9999); setPage(0); }}
                        className="bg-white border border-zinc-200 rounded-xl py-2 px-3 text-xs font-bold outline-none focus:border-zinc-400 cursor-pointer text-zinc-700"
                    >
                        <option value={25}>25 / pág</option>
                        <option value={50}>50 / pág</option>
                        <option value={100}>100 / pág</option>
                        <option value={9999}>Todos</option>
                    </select>

                    <span className="ml-auto text-[11px] font-bold text-zinc-400">
                        {totalCount.toLocaleString()} registros
                    </span>
                </div>
            </div>

            {/* ── Panel de reasignación masiva ── */}
            {selectedIds.size > 0 && activeTab !== 'finalizados' && (
                <div className="bg-indigo-50 border border-indigo-200 rounded-2xl p-4 flex flex-wrap items-center gap-3">
                    <span className="text-xs font-black text-indigo-700 uppercase">
                        {selectedIds.size} ticket{selectedIds.size !== 1 ? 's' : ''} seleccionado{selectedIds.size !== 1 ? 's' : ''}
                    </span>

                    {/* Combobox autocomplete */}
                    <div className="relative flex-1 min-w-[220px]">
                        <input
                            type="text"
                            placeholder="Buscar técnico por nombre o email..."
                            value={bulkTech}
                            onChange={e => { setBulkTech(e.target.value); setBulkResult(null); }}
                            className="w-full border border-indigo-300 rounded-xl px-3 py-2 text-xs font-medium outline-none focus:ring-2 focus:ring-indigo-300 bg-white"
                        />
                        {bulkDropdownUsers.length > 0 && (
                            <ul className="absolute z-50 top-full left-0 right-0 mt-1 bg-white border border-zinc-200 rounded-xl shadow-xl max-h-48 overflow-y-auto">
                                {bulkDropdownUsers.map(u => (
                                    <li
                                        key={u.id || u.email}
                                        onMouseDown={() => setBulkTech(u.email || u.display_name)}
                                        className="px-3 py-2 text-xs hover:bg-indigo-50 cursor-pointer flex items-center justify-between gap-2"
                                    >
                                        <span className="font-bold text-zinc-800">{u.display_name}</span>
                                        <span className="text-zinc-400 font-mono truncate">{u.email}</span>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <button
                        onClick={handleBulkReassign}
                        disabled={!bulkTech || bulkReassigning}
                        className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-xl font-bold text-xs uppercase transition-all active:scale-95 hover:bg-indigo-700 disabled:opacity-50"
                    >
                        {bulkReassigning ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Users className="w-3.5 h-3.5" />}
                        Reasignar
                    </button>
                    <button onClick={() => setSelectedIds(new Set())} className="text-zinc-400 hover:text-zinc-600 transition-colors">
                        <X size={16} />
                    </button>
                    {bulkResult && (
                        <span className="text-xs font-bold text-emerald-600 flex items-center gap-1">
                            <AlertCircle size={12} /> {bulkResult}
                        </span>
                    )}
                </div>
            )}

            {/* ── Tabla principal ── */}
            <div className="bg-white border border-zinc-200 rounded-3xl overflow-hidden shadow-sm">
                <div className="overflow-x-auto">
                    <table className="w-full" translate="no">
                        <thead className="bg-zinc-50 border-b border-zinc-200">
                            <tr>
                                {activeTab !== 'finalizados' && (
                                    <th className="px-3 pt-3 pb-1 w-10">
                                        <button onClick={toggleAll} className="text-zinc-400 hover:text-indigo-600 transition-colors">
                                            {allSelected ? <CheckSquare size={15} className="text-indigo-600" /> : <Square size={15} />}
                                        </button>
                                    </th>
                                )}
                                <th className="px-4 pt-3 pb-1 text-left text-[10px] uppercase font-bold tracking-widest text-zinc-400">ID / Cliente</th>
                                <th className="px-4 pt-3 pb-1 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">Creación</th>
                                <th className="px-4 pt-3 pb-1 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">Asunto</th>
                                <th className="px-4 pt-3 pb-1 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">Barrio</th>
                                <th className="px-4 pt-3 pb-1 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">Nivel</th>
                                <th className="px-4 pt-3 pb-1 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">Responsable</th>
                                <th className="px-4 pt-3 pb-1 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">Estado</th>
                                <th className="px-4 pt-3 pb-1 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">Escalado A</th>
                                <th className="px-4 pt-3 pb-1 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">SLA</th>
                                <th className="px-4 pt-3 pb-1 text-center text-[10px] uppercase font-bold tracking-widest text-zinc-400">Historial</th>
                            </tr>
                            <tr>
                                {activeTab !== 'finalizados' && <td className="px-2 pb-2" />}
                                <td className="px-2 pb-2 min-w-[120px]"><ColSearch value={colFilters.cliente} onChange={v => setCol('cliente', v)} placeholder="ID / cliente..." /></td>
                                <td className="px-2 pb-2 min-w-[90px]"><ColSearch value={colFilters.creacion} onChange={v => setCol('creacion', v)} placeholder="DD/MM/AAAA..." /></td>
                                <td className="px-2 pb-2 min-w-[110px]"><ColSearch value={colFilters.asunto} onChange={v => setCol('asunto', v)} placeholder="Asunto..." /></td>
                                <td className="px-2 pb-2 min-w-[90px]"><ColSearch value={colFilters.barrio} onChange={v => setCol('barrio', v)} placeholder="Barrio..." /></td>
                                <td className="px-2 pb-2" />
                                <td className="px-2 pb-2 min-w-[110px]"><ColSearch value={colFilters.responsable} onChange={v => setCol('responsable', v)} placeholder="Técnico..." /></td>
                                <td className="px-2 pb-2 min-w-[90px]"><ColSearch value={colFilters.estado} onChange={v => setCol('estado', v)} placeholder="Estado..." /></td>
                                <td className="px-2 pb-2 min-w-[90px]"><ColSearch value={colFilters.escaladoA} onChange={v => setCol('escaladoA', v)} placeholder="Escalado a..." /></td>
                                <td className="px-2 pb-2" />
                                <td className="px-2 pb-2" />
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-100">
                            {!platformUsersReady ? (
                                <tr>
                                    <td colSpan={activeTab === 'finalizados' ? 10 : 11} className="p-12 text-center">
                                        <div className="flex flex-col items-center gap-2">
                                            <Loader2 size={18} className="animate-spin text-zinc-400" />
                                            <span className="text-xs text-zinc-400 font-medium">Cargando mapa de técnicos...</span>
                                        </div>
                                    </td>
                                </tr>
                            ) : loading && processes.length === 0 ? (
                                <tr>
                                    <td colSpan={activeTab === 'finalizados' ? 10 : 11} className="p-12 text-center text-zinc-400 text-xs font-medium animate-pulse">
                                        Cargando datos operativos...
                                    </td>
                                </tr>
                            ) : filtered.length === 0 ? (
                                <tr>
                                    <td colSpan={activeTab === 'finalizados' ? 10 : 11} className="p-12 text-center">
                                        <span className="text-xs text-zinc-400 font-medium">No se encontraron registros.</span>
                                    </td>
                                </tr>
                            ) : (
                                filtered.map(p => {
                                    // Mostrar siempre el nombre original de WispHub
                                    const responsibleName =
                                        p.metadata?.nombre_tecnico ||
                                        p.metadata?.email_tecnico ||
                                        p.metadata?.tecnico?.nombre ||
                                        'POR ASIGNAR';

                                    // SLA dinámico — getSlaInfo hace el split internamente
                                    const ticketType = p.title || p.metadata?.asunto || p.process_type || '';
                                    const sla = getSlaInfo(p.created_at, ticketType, slaMap);
                                    const isSelected = selectedIds.has(p.id);

                                    return (
                                        <tr
                                            key={p.id}
                                            className={clsx(
                                                'transition-colors group cursor-pointer',
                                                sla.status === 'critical' && 'animate-pulse-subtle bg-red-50/40',
                                                sla.status === 'warning' && 'bg-amber-50/30',
                                                isSelected && 'bg-indigo-50',
                                                !isSelected && sla.status === 'ok' && 'hover:bg-zinc-50'
                                            )}
                                            onClick={() => toggleOne(p.id)}
                                        >
                                            {/* Checkbox (oculto en Finalizados) */}
                                            {activeTab !== 'finalizados' && (
                                                <td className="p-3 text-center">
                                                    {isSelected
                                                        ? <CheckSquare size={15} className="text-indigo-600 mx-auto" />
                                                        : <Square size={15} className="text-zinc-300 mx-auto group-hover:text-zinc-500" />
                                                    }
                                                </td>
                                            )}

                                            {/* ID / Cliente */}
                                            <td className="p-4">
                                                <div className="flex flex-col">
                                                    <span className="text-xs font-bold uppercase text-zinc-900 leading-tight">
                                                        <Highlight text={p.metadata?.nombre_cliente || (p.title.includes(' - ') ? p.title.split(' - ')[1] : p.title)} query={colFilters.cliente} />
                                                    </span>
                                                    <span className="text-[10px] font-bold text-zinc-500 font-mono bg-zinc-100 px-1.5 py-0.5 rounded border border-zinc-200 w-fit mt-1">
                                                        #<Highlight text={String(p.reference_id || p.id.split('-')[0])} query={colFilters.cliente} />
                                                    </span>
                                                </div>
                                            </td>

                                            {/* Creación */}
                                            <td className="p-4 text-center">
                                                <div className="flex flex-col items-center">
                                                    <span className="text-[10px] font-bold text-zinc-500 font-mono">
                                                        {new Date(p.created_at).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })}
                                                    </span>
                                                    <span className="text-[8px] text-zinc-400 font-mono">
                                                        {new Date(p.created_at).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}
                                                    </span>
                                                </div>
                                            </td>

                                            {/* Asunto */}
                                            <td className="p-4 text-center">
                                                <div className="max-w-[140px] mx-auto text-[9px] font-bold uppercase text-zinc-600 bg-zinc-50 px-2 py-1.5 rounded-lg border border-zinc-200 truncate" title={ticketType}>
                                                    <Highlight text={ticketType || p.process_type} query={colFilters.asunto} />
                                                </div>
                                            </td>

                                            {/* Barrio */}
                                            <td className="p-4 text-center">
                                                <span className="text-[10px] font-medium text-zinc-500 truncate max-w-[100px] block">
                                                    <Highlight text={p.metadata?.barrio || p.metadata?.zona || '—'} query={colFilters.barrio} />
                                                </span>
                                            </td>

                                            {/* Nivel */}
                                            <td className="p-4 text-center">
                                                <span className={clsx(
                                                    'text-[9px] font-bold px-2 py-1 rounded-md uppercase border tracking-wide',
                                                    (p.escalation_level || 0) === 0 && 'bg-blue-50 text-blue-700 border-blue-100',
                                                    (p.escalation_level || 0) === 1 && 'bg-cyan-50 text-cyan-700 border-cyan-100',
                                                    (p.escalation_level || 0) === 2 && 'bg-orange-50 text-orange-700 border-orange-100',
                                                    (p.escalation_level || 0) >= 3 && 'bg-red-50 text-red-700 border-red-100',
                                                )}>
                                                    N{p.escalation_level || 0}
                                                </span>
                                            </td>

                                            {/* Responsable */}
                                            <td className="p-4 text-center">
                                                <span className={clsx(
                                                    'text-[10px] font-bold uppercase truncate max-w-[130px] px-2 py-1 rounded border block mx-auto',
                                                    (p as any).__unmatched
                                                        ? 'text-amber-700 bg-amber-50 border-amber-200'
                                                        : 'text-zinc-600 bg-zinc-50 border-zinc-200'
                                                )}>
                                                    <Highlight text={responsibleName} query={colFilters.responsable} />
                                                </span>
                                            </td>

                                            {/* Estado */}
                                            <td className="p-4 text-center">
                                                {(() => {
                                                    const isFinished  = p.status === 'Completed' || p.status === 'Cerrado'
                                                        || p.metadata?.id_estado === 3 || p.metadata?.id_estado === 4
                                                        || p.metadata?.estado === 'Resuelto' || p.metadata?.estado === 'Cerrado';
                                                    const isStarted   = !!p.metadata?.started_at || p.metadata?.id_estado === 2 || p.metadata?.estado === 'En Progreso';
                                                    const isEscalated = (p.escalation_level || 0) >= 2;
                                                    const label = isFinished ? (isEscalated ? 'Escalado' : 'Completado')
                                                                : isStarted  ? 'En Progreso'
                                                                : 'Abierto';
                                                    return (
                                                        <span className={clsx(
                                                            'px-2 py-1 rounded-full text-[9px] font-bold uppercase inline-flex items-center gap-1 border',
                                                            isFinished  ? 'bg-emerald-50 text-emerald-700 border-emerald-100' :
                                                            isStarted   ? 'bg-blue-50 text-blue-700 border-blue-100' :
                                                                          'bg-zinc-50 text-zinc-500 border-zinc-100'
                                                        )}>
                                                            <div className={clsx('w-1.5 h-1.5 rounded-full',
                                                                isFinished ? 'bg-emerald-500' : isStarted ? 'bg-blue-500' : 'bg-zinc-400'
                                                            )} />
                                                            {label}
                                                        </span>
                                                    );
                                                })()}
                                            </td>

                                            {/* Escalado A */}
                                            <td className="p-4 text-center">
                                                {(() => {
                                                    const label = p.metadata?.escalated_to
                                                        || ((p.escalation_level ?? 0) >= 2 ? `Nivel ${p.escalation_level}` : null);
                                                    return label ? (
                                                        <span className="text-[9px] font-bold text-orange-700 bg-orange-50 border border-orange-200 px-2 py-1 rounded-lg truncate max-w-[110px] block mx-auto">
                                                            <Highlight text={label} query={colFilters.escaladoA} />
                                                        </span>
                                                    ) : (
                                                        <span className="text-zinc-300 text-[10px]">—</span>
                                                    );
                                                })()}
                                            </td>

                                            {/* SLA semáforo dinámico */}
                                            <td className="p-4 text-center">
                                                <div className="flex flex-col items-center gap-1">
                                                    <div className="w-16 h-1.5 bg-zinc-100 rounded-full overflow-hidden">
                                                        <div
                                                            className={clsx(
                                                                'h-full rounded-full transition-all',
                                                                sla.status === 'critical' && 'bg-red-500 animate-pulse',
                                                                sla.status === 'warning' && 'bg-amber-400',
                                                                sla.status === 'ok' && 'bg-emerald-400'
                                                            )}
                                                            style={{ width: `${Math.min(sla.pct, 100)}%` }}
                                                        />
                                                    </div>
                                                    <span className={clsx(
                                                        'text-[9px] font-black font-mono',
                                                        sla.status === 'critical' && 'text-red-600',
                                                        sla.status === 'warning' && 'text-amber-600',
                                                        sla.status === 'ok' && 'text-zinc-400'
                                                    )}>
                                                        {sla.hoursOpen}h / {sla.maxHours}h
                                                    </span>
                                                    {sla.status === 'critical' && (
                                                        <span className="text-[8px] font-black text-red-600 uppercase tracking-wider animate-pulse">VENCIDO</span>
                                                    )}
                                                    {sla.status === 'warning' && (
                                                        <span className="text-[8px] font-black text-amber-500 uppercase tracking-wider">ALERTA</span>
                                                    )}
                                                </div>
                                            </td>

                                            {/* Historial + Acciones */}
                                            <td className="p-4 text-center" onClick={e => e.stopPropagation()}>
                                                <div className="flex flex-col gap-1 items-center">
                                                    <button
                                                        onClick={() => { setDetailProcess(p); setDetailWisphubHistory([]); }}
                                                        className="flex items-center gap-1 text-[9px] font-black uppercase px-2.5 py-1.5 bg-blue-50 text-blue-700 border border-blue-200 rounded-lg hover:bg-blue-100 transition-all w-full justify-center"
                                                    >
                                                        <Eye size={10} /> Detalle
                                                    </button>
                                                    <button
                                                        onClick={async () => {
                                                            setHistoryProcess(p);
                                                            setHistoryLogs([]);
                                                            setHistoryLoading(true);
                                                            const logs = await WorkflowService.getFullLogs(p.id);
                                                            setHistoryLogs(logs);
                                                            setHistoryLoading(false);
                                                        }}
                                                        className="flex items-center gap-1 text-[9px] font-black uppercase px-2.5 py-1.5 bg-zinc-50 text-zinc-600 border border-zinc-200 rounded-lg hover:bg-zinc-100 transition-all w-full justify-center"
                                                    >
                                                        <History size={10} /> Ver
                                                    </button>
                                                    {(() => {
                                                        const isFinished = p.status === 'Completed' || p.status === 'Cerrado'
                                                            || p.metadata?.id_estado === 3 || p.metadata?.id_estado === 4
                                                            || p.metadata?.estado === 'Resuelto' || p.metadata?.estado === 'Cerrado';
                                                        if (isFinished) return null;
                                                        return (
                                                            <div className="flex flex-col gap-1 w-full">
                                                                {p.metadata?.pending_validation && (
                                                                    <button
                                                                        onClick={() => { setValidateTarget(p); setValidateNote(''); }}
                                                                        className="flex items-center gap-1 text-[9px] font-black uppercase px-2.5 py-1.5 bg-violet-50 text-violet-700 border border-violet-200 rounded-lg hover:bg-violet-100 transition-all w-full justify-center"
                                                                    >
                                                                        <Activity size={10} /> Validar
                                                                    </button>
                                                                )}
                                                                <button
                                                                    onClick={() => { setCloseTarget(p); setCloseNote(''); setCloseStatusId(4); }}
                                                                    className="flex items-center gap-1 text-[9px] font-black uppercase px-2.5 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-all w-full justify-center"
                                                                >
                                                                    <CheckCircle2 size={10} /> Cerrar
                                                                </button>
                                                            </div>
                                                        );
                                                    })()}
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })
                            )}
                        </tbody>
                    </table>
                </div>

                {/* ── Paginación ── */}
                {pageSize === 9999 ? (
                    <div className="border-t border-zinc-100 px-6 py-3 flex items-center justify-between">
                        <span className="text-xs text-zinc-400 font-medium">
                            Mostrando todos · {totalCount.toLocaleString()} registros
                        </span>
                    </div>
                ) : totalPages > 1 && (
                    <div className="border-t border-zinc-100 px-6 py-3 flex items-center justify-between">
                        <span className="text-xs text-zinc-400 font-medium">
                            Página {page + 1} de {totalPages} · {totalCount.toLocaleString()} registros
                        </span>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => setPage(p => Math.max(0, p - 1))}
                                disabled={page === 0 || loading}
                                className="p-1.5 rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 disabled:opacity-40 transition-all"
                            >
                                <ChevronLeft size={14} />
                            </button>
                            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                                const pg = page < 4 ? i : page - 3 + i;
                                if (pg >= totalPages) return null;
                                return (
                                    <button
                                        key={pg}
                                        onClick={() => setPage(pg)}
                                        className={clsx(
                                            'w-7 h-7 rounded-lg text-xs font-bold transition-all',
                                            pg === page ? 'bg-zinc-900 text-white' : 'border border-zinc-200 text-zinc-500 hover:bg-zinc-50'
                                        )}
                                    >
                                        {pg + 1}
                                    </button>
                                );
                            })}
                            <button
                                onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                                disabled={page >= totalPages - 1 || loading}
                                className="p-1.5 rounded-lg border border-zinc-200 text-zinc-500 hover:bg-zinc-50 disabled:opacity-40 transition-all"
                            >
                                <ChevronRight size={14} />
                            </button>
                        </div>
                    </div>
                )}
            </div>

            {/* ── Modal: Validar Ticket (Supervisor) ── */}
            {validateTarget && (
                <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">

                        {/* Header */}
                        <div className="bg-zinc-50 border-b border-zinc-200 px-6 py-4 flex items-center justify-between shrink-0">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-xl bg-violet-100 flex items-center justify-center">
                                    <Activity size={16} className="text-violet-600" />
                                </div>
                                <div>
                                    <h2 className="text-sm font-black uppercase tracking-wide text-zinc-900">Validar Ticket</h2>
                                    <p className="text-[10px] text-zinc-500 font-mono">
                                        #{validateTarget.reference_id || validateTarget.id.split('-')[0]}
                                        {' · '}{validateTarget.metadata?.nombre_cliente || validateTarget.title}
                                    </p>
                                </div>
                            </div>
                            <button onClick={() => { setValidateTarget(null); setShowRejectForm(false); setRejectNote(''); setValidateNote(''); setValidateHistory([]); }} className="text-zinc-400 hover:text-zinc-700 transition-colors">
                                <X size={18} />
                            </button>
                        </div>

                        {/* Historial de respuestas WispHub */}
                        <div className="px-6 pt-4 shrink-0">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-[10px] font-black text-zinc-500 uppercase tracking-widest">Historial del ticket</span>
                                {!validateHistoryLoading && validateHistory.length === 0 && (
                                    <button
                                        onClick={async () => {
                                            const ticketId = validateTarget.reference_id;
                                            if (!ticketId) return;
                                            setValidateHistoryLoading(true);
                                            try {
                                                const raw = await WisphubService.getTicketRaw(String(ticketId)).catch(() => null);
                                                setValidateHistory(raw?.respuestas || []);
                                            } finally {
                                                setValidateHistoryLoading(false);
                                            }
                                        }}
                                        className="text-[10px] font-bold text-violet-600 hover:text-violet-800 underline"
                                    >
                                        Cargar historial
                                    </button>
                                )}
                            </div>
                            {validateHistoryLoading && (
                                <div className="flex items-center gap-2 py-3 text-[11px] text-zinc-400">
                                    <Loader2 size={12} className="animate-spin" /> Cargando respuestas...
                                </div>
                            )}
                            {!validateHistoryLoading && validateHistory.length > 0 && (
                                <div className="overflow-y-auto max-h-52 space-y-2 pr-1 mb-1">
                                    {validateHistory.map((r: any, i: number) => (
                                        <div key={i} className="bg-zinc-50 border border-zinc-100 rounded-xl px-3 py-2 text-[11px]">
                                            <div className="flex items-center justify-between gap-2 mb-1">
                                                <span className="font-bold text-zinc-700 truncate">{r.usuario || r.user || 'Sistema'}</span>
                                                <span className="text-zinc-400 font-mono shrink-0 text-[10px]">
                                                    {r.created ? new Date(r.created).toLocaleString('es-CO', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : ''}
                                                </span>
                                            </div>
                                            <p className="text-zinc-600 whitespace-pre-wrap break-words">{r.respuesta || r.comentario || ''}</p>
                                            {r.archivo && (
                                                <a href={r.archivo} target="_blank" rel="noreferrer" className="mt-1.5 block">
                                                    <img src={r.archivo} alt="foto" className="rounded-lg max-h-40 object-cover border border-zinc-200 cursor-pointer hover:opacity-90" />
                                                </a>
                                            )}
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Cuerpo scrollable */}
                        <div className="px-6 py-4 overflow-y-auto flex-1">
                            {!showRejectForm ? (
                                <div className="space-y-3">
                                    <label className="text-[11px] font-black text-zinc-700 uppercase tracking-widest block">
                                        Respuesta de validación
                                    </label>
                                    <textarea
                                        value={validateNote}
                                        onChange={e => setValidateNote(e.target.value)}
                                        placeholder="Describe la validación realizada..."
                                        rows={3}
                                        className="w-full bg-zinc-50 border border-zinc-200 rounded-2xl p-4 text-xs font-medium outline-none focus:bg-white focus:border-violet-400 focus:ring-4 focus:ring-violet-100 transition-all resize-none placeholder:text-zinc-300"
                                        autoFocus
                                    />
                                    <span className={clsx('text-[10px] font-bold font-mono', validateNote.trim().length < 5 ? 'text-red-400' : 'text-emerald-500')}>
                                        {validateNote.trim().length} / 5 mín.
                                    </span>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <div className="bg-red-50 border border-red-200 rounded-2xl px-4 py-3 text-[11px] text-red-700 font-bold">
                                        El técnico será notificado del rechazo y deberá volver a enviar a validación.
                                    </div>
                                    <label className="text-[11px] font-black text-zinc-700 uppercase tracking-widest block">
                                        Motivo del rechazo
                                    </label>
                                    <textarea
                                        value={rejectNote}
                                        onChange={e => setRejectNote(e.target.value)}
                                        placeholder="Explica por qué se rechaza la validación..."
                                        rows={3}
                                        className="w-full bg-zinc-50 border border-zinc-200 rounded-2xl p-4 text-xs font-medium outline-none focus:bg-white focus:border-red-400 focus:ring-4 focus:ring-red-100 transition-all resize-none placeholder:text-zinc-300"
                                        autoFocus
                                    />
                                    <span className={clsx('text-[10px] font-bold font-mono', rejectNote.trim().length < 5 ? 'text-red-400' : 'text-emerald-500')}>
                                        {rejectNote.trim().length} / 5 mín.
                                    </span>
                                </div>
                            )}
                        </div>

                        {/* Footer */}
                        <div className="border-t border-zinc-100 px-6 py-4 flex items-center justify-between gap-3 shrink-0">
                            {!showRejectForm ? (
                                <>
                                    <button
                                        onClick={() => setShowRejectForm(true)}
                                        className="flex items-center gap-1.5 px-4 py-2 bg-red-50 text-red-600 border border-red-200 rounded-xl font-bold text-xs uppercase hover:bg-red-100 transition-all"
                                    >
                                        <X size={12} /> No Validar
                                    </button>
                                    <div className="flex items-center gap-2">
                                        <button onClick={() => { setValidateTarget(null); setValidateNote(''); setValidateHistory([]); }} className="px-4 py-2 text-xs font-bold text-zinc-500 hover:text-zinc-700 transition-colors">
                                            Cancelar
                                        </button>
                                        <button
                                            disabled={validating || validateNote.trim().length < 5}
                                            onClick={async () => {
                                                setValidating(true);
                                                try {
                                                    const ticketId = validateTarget.reference_id;
                                                    const ok = await WorkflowService.supervisorValidateProcess(
                                                        validateTarget.id,
                                                        String(ticketId),
                                                        validateNote.trim()
                                                    );
                                                    if (ok) {
                                                        setProcesses(prev => prev.map(p =>
                                                            p.id === validateTarget.id
                                                                ? { ...p, status: 'Completed', metadata: { ...p.metadata, pending_validation: false, supervisor_validated: true, closed_at: new Date().toISOString() } }
                                                                : p
                                                        ));
                                                        setValidateTarget(null);
                                                        setValidateNote('');
                                                        setValidateHistory([]);
                                                    }
                                                } finally {
                                                    setValidating(false);
                                                }
                                            }}
                                            className="flex items-center gap-2 px-5 py-2.5 bg-violet-600 text-white rounded-xl font-bold text-xs uppercase tracking-wide hover:bg-violet-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-95"
                                        >
                                            {validating ? <Loader2 size={13} className="animate-spin" /> : <Activity size={13} />}
                                            Confirmar Validación
                                        </button>
                                    </div>
                                </>
                            ) : (
                                <>
                                    <button onClick={() => setShowRejectForm(false)} className="px-4 py-2 text-xs font-bold text-zinc-500 hover:text-zinc-700 transition-colors">
                                        Volver
                                    </button>
                                    <button
                                        disabled={rejecting || rejectNote.trim().length < 5}
                                        onClick={async () => {
                                            setRejecting(true);
                                            try {
                                                const ticketId = validateTarget.reference_id;
                                                const ok = await WorkflowService.rejectValidation(
                                                    validateTarget.id,
                                                    String(ticketId),
                                                    rejectNote.trim()
                                                );
                                                if (ok) {
                                                    setProcesses(prev => prev.map(p =>
                                                        p.id === validateTarget.id
                                                            ? { ...p, metadata: { ...p.metadata, pending_validation: false, validation_rejected: true, validation_rejected_note: rejectNote.trim() } }
                                                            : p
                                                    ));
                                                    // Notifica a MyTasks (mismo-tab y cross-browser via Realtime)
                                                    window.dispatchEvent(new CustomEvent('mytasks:reload'));
                                                    setValidateTarget(null);
                                                    setRejectNote('');
                                                    setShowRejectForm(false);
                                                    setValidateHistory([]);
                                                }
                                            } finally {
                                                setRejecting(false);
                                            }
                                        }}
                                        className="flex items-center gap-2 px-5 py-2.5 bg-red-600 text-white rounded-xl font-bold text-xs uppercase tracking-wide hover:bg-red-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-95"
                                    >
                                        {rejecting ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                                        Rechazar Validación
                                    </button>
                                </>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ── Modal: Cerrar Ticket (Supervisor) ── */}
            {closeTarget && (
                <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl w-full max-w-md shadow-2xl overflow-hidden">
                        <div className="bg-emerald-50 border-b border-emerald-100 px-6 py-4 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-xl bg-emerald-100 flex items-center justify-center">
                                    <CheckCircle2 size={16} className="text-emerald-600" />
                                </div>
                                <div>
                                    <h2 className="text-sm font-black uppercase tracking-wide text-zinc-900">Cerrar Ticket</h2>
                                    <p className="text-[10px] text-zinc-500 font-mono">
                                        #{closeTarget.reference_id || closeTarget.id.split('-')[0]}
                                        {' · '}
                                        {closeTarget.metadata?.nombre_cliente || closeTarget.title}
                                    </p>
                                </div>
                            </div>
                            <button onClick={() => setCloseTarget(null)} className="text-zinc-400 hover:text-zinc-700 transition-colors">
                                <X size={18} />
                            </button>
                        </div>

                        <div className="p-6 space-y-4">
                            {/* Estado final */}
                            <div>
                                <label className="block text-[10px] font-black uppercase tracking-widest text-zinc-500 mb-2">
                                    Estado Final
                                </label>
                                <div className="flex bg-zinc-100 p-1 rounded-xl gap-1">
                                    <button
                                        onClick={() => setCloseStatusId(3)}
                                        className={clsx(
                                            'flex-1 py-2 rounded-lg text-[9px] font-black uppercase tracking-wide transition-all',
                                            closeStatusId === 3
                                                ? 'bg-blue-600 text-white shadow-md'
                                                : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200/50'
                                        )}
                                    >
                                        Resuelto
                                    </button>
                                    <button
                                        onClick={() => setCloseStatusId(4)}
                                        className={clsx(
                                            'flex-1 py-2 rounded-lg text-[9px] font-black uppercase tracking-wide transition-all',
                                            closeStatusId === 4
                                                ? 'bg-emerald-600 text-white shadow-md'
                                                : 'text-zinc-500 hover:text-zinc-700 hover:bg-zinc-200/50'
                                        )}
                                    >
                                        Cerrado
                                    </button>
                                </div>
                            </div>

                            {/* Resolución */}
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-[10px] font-black uppercase tracking-widest text-zinc-500">
                                        Resolución / Nota de Cierre *
                                    </label>
                                    <span className={clsx(
                                        'text-[10px] font-bold font-mono',
                                        closeNote.trim().length < 10 ? 'text-red-400' : 'text-emerald-500'
                                    )}>
                                        {closeNote.trim().length} / 10 mín.
                                    </span>
                                </div>
                                <textarea
                                    value={closeNote}
                                    onChange={e => setCloseNote(e.target.value)}
                                    rows={4}
                                    autoFocus
                                    placeholder="Descripción de la resolución aplicada al ticket..."
                                    className="w-full border border-zinc-200 rounded-xl px-3 py-2.5 text-xs font-medium outline-none focus:border-zinc-400 resize-none placeholder:text-zinc-300"
                                />
                            </div>
                        </div>

                        <div className="border-t border-zinc-100 px-6 py-4 flex items-center justify-between gap-3">
                            <button
                                onClick={() => setCloseTarget(null)}
                                className="px-4 py-2 text-xs font-bold text-zinc-500 hover:text-zinc-700 transition-colors"
                            >
                                Cancelar
                            </button>
                            <button
                                disabled={closing || closeNote.trim().length < 10}
                                onClick={async () => {
                                    setClosing(true);
                                    try {
                                        const ok = await WorkflowService.supervisorCloseProcess(
                                            closeTarget.id,
                                            closeNote.trim(),
                                            closeStatusId
                                        );
                                        if (ok) {
                                            setProcesses(prev => prev.map(p =>
                                                p.id === closeTarget.id
                                                    ? { ...p, status: 'Completed', metadata: { ...p.metadata, id_estado: closeStatusId } }
                                                    : p
                                            ));
                                            setCloseTarget(null);
                                            setCloseNote('');
                                        }
                                    } finally {
                                        setClosing(false);
                                    }
                                }}
                                className="flex items-center gap-2 px-5 py-2.5 bg-emerald-600 text-white rounded-xl font-bold text-xs uppercase tracking-wide hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-95"
                            >
                                {closing
                                    ? <Loader2 size={13} className="animate-spin" />
                                    : <CheckCircle2 size={13} />
                                }
                                Confirmar Cierre
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* ── Modal: Detalle del Ticket ── */}
            {detailProcess && (() => {
                const dp = detailProcess;
                const ticketType = dp.title || dp.metadata?.asunto || dp.process_type || '';
                const sla = getSlaInfo(dp.created_at, ticketType, slaMap);
                const isEscalated = (dp.escalation_level || 0) >= 2;

                const Field = ({ label, value }: { label: string; value?: string | null }) =>
                    value ? (
                        <div className="flex flex-col gap-0.5">
                            <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest">{label}</span>
                            <span className="text-xs font-bold text-zinc-800 break-words">{value}</span>
                        </div>
                    ) : null;

                return (
                    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
                        <div className="bg-white rounded-3xl w-full max-w-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">

                            {/* Header */}
                            <div className="bg-blue-50 border-b border-blue-100 px-6 py-4 flex items-center justify-between shrink-0">
                                <div className="flex items-center gap-3">
                                    <div className="w-8 h-8 rounded-xl bg-blue-100 flex items-center justify-center">
                                        <Eye size={16} className="text-blue-600" />
                                    </div>
                                    <div>
                                        <h2 className="text-sm font-black uppercase tracking-wide text-zinc-900">Detalle del Ticket</h2>
                                        <p className="text-[10px] text-zinc-500 font-mono">
                                            #{dp.reference_id || dp.id.split('-')[0]}
                                            {' · '}{dp.metadata?.nombre_cliente || dp.title}
                                        </p>
                                    </div>
                                </div>
                                <button onClick={() => setDetailProcess(null)} className="text-zinc-400 hover:text-zinc-700 transition-colors">
                                    <X size={18} />
                                </button>
                            </div>

                            {/* Body */}
                            <div className="overflow-y-auto flex-1 p-6 space-y-5">

                                {/* Ficha principal */}
                                <div className="grid grid-cols-2 gap-x-6 gap-y-4 bg-zinc-50 border border-zinc-100 rounded-2xl p-4">
                                    <Field label="Cliente" value={dp.metadata?.nombre_cliente} />
                                    <Field label="Barrio / Zona" value={[dp.metadata?.barrio, dp.metadata?.zona].filter(Boolean).join(' · ')} />
                                    <Field label="Dirección" value={dp.metadata?.direccion || dp.metadata?.address} />
                                    <Field label="Teléfono" value={dp.metadata?.telefono || dp.metadata?.celular || dp.metadata?.phone} />
                                    <Field label="Asunto" value={ticketType} />
                                    <Field label="Técnico Asignado" value={dp.metadata?.nombre_tecnico || dp.metadata?.email_tecnico} />
                                    <Field label="Estado WispHub" value={dp.metadata?.estado || dp.metadata?.nombre_estado} />
                                    <Field label="Creación" value={new Date(dp.created_at).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' })} />
                                    {dp.metadata?.descripcion && (
                                        <div className="col-span-2 flex flex-col gap-0.5">
                                            <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest">Descripción</span>
                                            <p className="text-xs font-medium text-zinc-700 leading-relaxed whitespace-pre-wrap">{dp.metadata.descripcion}</p>
                                        </div>
                                    )}
                                </div>

                                {/* SLA */}
                                <div className="bg-zinc-50 border border-zinc-100 rounded-2xl p-4 space-y-2">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest">SLA</span>
                                        <span className={clsx(
                                            'text-[10px] font-black font-mono',
                                            sla.status === 'critical' && 'text-red-600',
                                            sla.status === 'warning' && 'text-amber-600',
                                            sla.status === 'ok' && 'text-zinc-500',
                                        )}>
                                            {sla.hoursOpen}h / {sla.maxHours}h · {sla.pct}%
                                        </span>
                                    </div>
                                    <div className="w-full h-2.5 bg-zinc-200 rounded-full overflow-hidden">
                                        <div
                                            className={clsx(
                                                'h-full rounded-full transition-all',
                                                sla.status === 'critical' && 'bg-red-500 animate-pulse',
                                                sla.status === 'warning' && 'bg-amber-400',
                                                sla.status === 'ok' && 'bg-emerald-400',
                                            )}
                                            style={{ width: `${Math.min(sla.pct, 100)}%` }}
                                        />
                                    </div>
                                    {sla.status === 'critical' && (
                                        <p className="text-[10px] font-black text-red-600 uppercase tracking-widest animate-pulse">SLA VENCIDO</p>
                                    )}
                                    {sla.status === 'warning' && (
                                        <p className="text-[10px] font-black text-amber-500 uppercase tracking-widest">Cerca del límite</p>
                                    )}
                                </div>

                                {/* Escalamiento */}
                                {isEscalated && (
                                    <div className="bg-orange-50 border border-orange-200 rounded-2xl p-4 space-y-1">
                                        <span className="text-[9px] font-black text-orange-400 uppercase tracking-widest">Escalamiento</span>
                                        <div className="grid grid-cols-3 gap-4 mt-2">
                                            <Field label="Nivel" value={`N${dp.escalation_level}`} />
                                            <Field label="Escalado A" value={dp.metadata?.escalated_to} />
                                            <Field label="Fecha Escalado" value={dp.metadata?.escalated_at ? new Date(dp.metadata.escalated_at).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : undefined} />
                                        </div>
                                    </div>
                                )}

                                {/* Respuestas WispHub */}
                                <div className="space-y-2">
                                    <div className="flex items-center justify-between">
                                        <span className="text-[9px] font-black text-zinc-400 uppercase tracking-widest">Respuestas WispHub</span>
                                        {!detailWisphubLoading && detailWisphubHistory.length === 0 && (
                                            <button
                                                onClick={async () => {
                                                    const ticketId = dp.reference_id;
                                                    if (!ticketId) return;
                                                    setDetailWisphubLoading(true);
                                                    try {
                                                        const raw = await WisphubService.getTicketRaw(String(ticketId)).catch(() => null);
                                                        setDetailWisphubHistory(raw?.respuestas || []);
                                                    } finally {
                                                        setDetailWisphubLoading(false);
                                                    }
                                                }}
                                                className="text-[10px] font-bold text-blue-600 hover:text-blue-800 underline"
                                            >
                                                Cargar historial
                                            </button>
                                        )}
                                    </div>
                                    {detailWisphubLoading && (
                                        <div className="flex items-center gap-2 py-3 text-[11px] text-zinc-400">
                                            <Loader2 size={12} className="animate-spin" /> Cargando respuestas...
                                        </div>
                                    )}
                                    {!detailWisphubLoading && detailWisphubHistory.length > 0 && (
                                        <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
                                            {detailWisphubHistory.map((r: any, i: number) => (
                                                <div key={i} className="bg-zinc-50 border border-zinc-100 rounded-xl px-3 py-2 text-[11px]">
                                                    <div className="flex items-center justify-between gap-2 mb-1">
                                                        <span className="font-bold text-zinc-700 truncate">{r.usuario || r.user || 'Sistema'}</span>
                                                        <span className="text-zinc-400 font-mono shrink-0 text-[10px]">
                                                            {r.created ? new Date(r.created).toLocaleString('es-CO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : ''}
                                                        </span>
                                                    </div>
                                                    <p className="text-zinc-600 whitespace-pre-wrap break-words">{r.respuesta || r.comentario || ''}</p>
                                                    {r.archivo && (
                                                        <a href={r.archivo} target="_blank" rel="noreferrer" className="mt-1.5 block">
                                                            <img src={r.archivo} alt="foto" className="rounded-lg max-h-40 object-cover border border-zinc-200 cursor-pointer hover:opacity-90" />
                                                        </a>
                                                    )}
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                    {!detailWisphubLoading && detailWisphubHistory.length === 0 && (
                                        <p className="text-[11px] text-zinc-300 font-medium">Sin respuestas cargadas.</p>
                                    )}
                                </div>
                            </div>

                            {/* Footer */}
                            <div className="border-t border-zinc-100 px-6 py-4 shrink-0 flex items-center justify-between gap-3">
                                {dp.metadata?.id_servicio && (
                                    <button
                                        onClick={() => window.open(`/clientes/hoja-de-vida/${dp.metadata.id_servicio}`, '_blank')}
                                        className="flex items-center gap-1.5 px-4 py-2 bg-blue-50 text-blue-700 border border-blue-200 rounded-xl font-bold text-xs uppercase hover:bg-blue-100 transition-all"
                                    >
                                        <Eye size={12} /> Hoja de Vida
                                    </button>
                                )}
                                <button
                                    onClick={() => setDetailProcess(null)}
                                    className="ml-auto px-5 py-2 bg-zinc-100 text-zinc-600 rounded-xl font-bold text-xs uppercase hover:bg-zinc-200 transition-all"
                                >
                                    Cerrar
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })()}

            {/* ── Modal: Historial de Actividad ── */}
            {historyProcess && (
                <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden">
                        <div className="bg-zinc-50 border-b border-zinc-200 px-6 py-4 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-xl bg-zinc-100 flex items-center justify-center">
                                    <History size={16} className="text-zinc-600" />
                                </div>
                                <div>
                                    <h2 className="text-sm font-black uppercase tracking-wide text-zinc-900">Historial de Actividad</h2>
                                    <p className="text-[10px] text-zinc-500 font-mono">
                                        #{historyProcess.reference_id || historyProcess.id.split('-')[0]}
                                        {' · '}
                                        {historyProcess.metadata?.nombre_cliente || historyProcess.title}
                                    </p>
                                </div>
                            </div>
                            <button onClick={() => setHistoryProcess(null)} className="text-zinc-400 hover:text-zinc-700 transition-colors">
                                <X size={18} />
                            </button>
                        </div>
                        <div className="p-6 max-h-[60vh] overflow-y-auto">
                            {historyLoading ? (
                                <div className="flex items-center justify-center py-8 gap-2 text-zinc-400">
                                    <Loader2 size={16} className="animate-spin" />
                                    <span className="text-xs">Cargando historial...</span>
                                </div>
                            ) : historyLogs.length === 0 ? (
                                <p className="text-xs text-zinc-400 text-center py-8">Sin registros de actividad aún.</p>
                            ) : (
                                <ol className="relative border-l border-zinc-200 space-y-4 ml-2">
                                    {historyLogs.map(log => (
                                        <li key={log.id} className="ml-4">
                                            <div className="absolute -left-1.5 w-3 h-3 rounded-full border-2 border-white bg-zinc-400" />
                                            <div className="flex items-start gap-2">
                                                <Clock size={11} className="text-zinc-400 mt-0.5 shrink-0" />
                                                <div>
                                                    <p className="text-xs font-semibold text-zinc-800">{log.description}</p>
                                                    <p className="text-[10px] text-zinc-400 font-mono mt-0.5">
                                                        {new Date(log.created_at).toLocaleString('es-CO', {
                                                            dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Bogota'
                                                        })}
                                                    </p>
                                                </div>
                                            </div>
                                        </li>
                                    ))}
                                </ol>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ── Modal: Derivar a Campo ── */}
            {transferTarget && (
                <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
                    <div className="bg-white rounded-3xl w-full max-w-lg shadow-2xl overflow-hidden">
                        {/* Header */}
                        <div className="bg-orange-50 border-b border-orange-100 px-6 py-4 flex items-center justify-between">
                            <div className="flex items-center gap-3">
                                <div className="w-8 h-8 rounded-xl bg-orange-100 flex items-center justify-center">
                                    <ArrowRight size={16} className="text-orange-600" />
                                </div>
                                <div>
                                    <h2 className="text-sm font-black uppercase tracking-wide text-zinc-900">Derivar a Campo</h2>
                                    <p className="text-[10px] text-zinc-500 font-mono">
                                        #{transferTarget.reference_id || transferTarget.id.split('-')[0]}
                                        {' · '}
                                        {transferTarget.metadata?.nombre_cliente || transferTarget.title}
                                    </p>
                                </div>
                            </div>
                            <button onClick={() => setTransferTarget(null)} className="text-zinc-400 hover:text-zinc-700 transition-colors">
                                <X size={18} />
                            </button>
                        </div>

                        <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto">
                            {/* Checklist de pruebas remotas */}
                            <div>
                                <div className="flex items-center gap-2 mb-3">
                                    <ClipboardList size={13} className="text-zinc-500" />
                                    <span className="text-[10px] font-black uppercase tracking-widest text-zinc-500">
                                        Pruebas Remotas Realizadas
                                    </span>
                                </div>
                                <div className="grid grid-cols-1 gap-2">
                                    {REMOTE_TESTS.map(test => {
                                        const checked = remoteTestsDone.includes(test);
                                        return (
                                            <label
                                                key={test}
                                                className={clsx(
                                                    'flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition-all',
                                                    checked
                                                        ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
                                                        : 'bg-zinc-50 border-zinc-200 text-zinc-600 hover:border-zinc-300'
                                                )}
                                            >
                                                <input
                                                    type="checkbox"
                                                    checked={checked}
                                                    onChange={() => setRemoteTestsDone(prev =>
                                                        checked ? prev.filter(t => t !== test) : [...prev, test]
                                                    )}
                                                    className="accent-emerald-500"
                                                />
                                                <span className="text-xs font-medium">{test}</span>
                                            </label>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Técnico de campo */}
                            <div>
                                <label className="block text-[10px] font-black uppercase tracking-widest text-zinc-500 mb-2">
                                    Técnico de Campo *
                                </label>
                                <select
                                    value={transferTech}
                                    onChange={e => setTransferTech(e.target.value)}
                                    className="w-full border border-zinc-200 rounded-xl px-3 py-2.5 text-xs font-medium outline-none focus:border-zinc-400 bg-white"
                                >
                                    <option value="">Seleccionar técnico...</option>
                                    {fieldTechnicians.map(u => (
                                        <option key={u.id || u.email} value={u.email || u.id}>
                                            {u.display_name} {u.email ? `— ${u.email}` : ''}
                                        </option>
                                    ))}
                                </select>
                            </div>

                            {/* Nota de transferencia (mínimo 50 chars) */}
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-[10px] font-black uppercase tracking-widest text-zinc-500">
                                        Nota de Transferencia *
                                    </label>
                                    <span className={clsx(
                                        'text-[10px] font-bold font-mono',
                                        transferNote.trim().length < 50 ? 'text-red-400' : 'text-emerald-500'
                                    )}>
                                        {transferNote.trim().length} / 50 mín.
                                    </span>
                                </div>
                                <textarea
                                    value={transferNote}
                                    onChange={e => setTransferNote(e.target.value)}
                                    rows={4}
                                    placeholder="Describe las pruebas remotas realizadas, el diagnóstico y el motivo de la derivación a campo..."
                                    className="w-full border border-zinc-200 rounded-xl px-3 py-2.5 text-xs font-medium outline-none focus:border-zinc-400 resize-none placeholder:text-zinc-300"
                                />
                                {transferNote.trim().length > 0 && transferNote.trim().length < 50 && (
                                    <p className="text-[10px] text-red-500 font-medium mt-1">
                                        Mínimo 50 caracteres requeridos para garantizar trazabilidad.
                                    </p>
                                )}
                            </div>
                        </div>

                        {/* Footer */}
                        <div className="border-t border-zinc-100 px-6 py-4 flex items-center justify-between gap-3">
                            <button
                                onClick={() => setTransferTarget(null)}
                                className="px-4 py-2 text-xs font-bold text-zinc-500 hover:text-zinc-700 transition-colors"
                            >
                                Cancelar
                            </button>
                            <button
                                onClick={handleTransfer}
                                disabled={
                                    transferring ||
                                    !transferTech ||
                                    transferNote.trim().length < 50
                                }
                                className="flex items-center gap-2 px-5 py-2.5 bg-orange-600 text-white rounded-xl font-bold text-xs uppercase tracking-wide hover:bg-orange-700 disabled:opacity-40 disabled:cursor-not-allowed transition-all active:scale-95"
                            >
                                {transferring
                                    ? <Loader2 size={13} className="animate-spin" />
                                    : <ArrowRight size={13} />
                                }
                                Derivar a Campo
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
