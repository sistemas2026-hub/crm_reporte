import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
    Search,
    Truck,
    AlertCircle,
    User,
    MapPin,
    Phone,
    FileText,
    X,
    Loader2,
    ExternalLink,
    ChevronDown,
    CloudUpload,
    CloudDownload,
    RefreshCw
} from 'lucide-react';
import { MapContainer, TileLayer, Marker, Popup, Circle } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { DragDropContext, Droppable, Draggable } from '@hello-pangea/dnd';
import type { DropResult } from '@hello-pangea/dnd';
import { WorkflowService } from '../lib/workflowService';
import { WisphubService } from '../lib/wisphub';
import { useWisphubTickets } from '../hooks/useWisphubTickets';
import { OperationalTimeline } from './OperationalTimeline';
import { SmartOltWidget } from '../components/operations/SmartOltWidget';
import clsx from 'clsx';

// Componente Portal para evitar el recorte de los tickets durante el arrastre
const Portal = ({ children }: { children: React.ReactNode }) => {
    return createPortal(children, document.body);
};

// Función para crear marcadores personalizados con conteo
const createClusterIcon = (count: number) => {
    return L.divIcon({
        className: 'custom-cluster-icon',
        html: `
            <div class="relative flex items-center justify-center" style="width: 32px; height: 36px;">
                <div class="absolute top-0 w-8 h-8 bg-primary/20 rounded-full animate-ping"></div>
                <div class="relative w-8 h-8 bg-primary border-2 border-white rounded-full flex items-center justify-center shadow-xl">
                    <span class="text-[10px] font-black text-white">${count}</span>
                </div>
                <!-- Punta del marcador -->
                <div class="absolute bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-primary rotate-45 border-r border-b border-white"></div>
            </div>
        `,
        iconSize: [32, 36],
        iconAnchor: [16, 36],
        popupAnchor: [0, -36]
    });
};
// Mapping para clasificación de Asuntos de WispHub (Lógica de detección por palabras clave)
const CATEGORIES_MAP: Record<string, string[]> = {
    'Soporte Técnico / Falla': [
        'lento', 'intermitente', 'falla', 'no tiene', 'no responde', 'dañado', 
        'quemado', 'altos', 'conexion', 'conexión', 'reseteado', 'tv', 
        'colgados', 'bajito', 'inactivo', 'verificacion', 'revisión', 
        'router', 'contraseña', 'fibra partida', 'niveles', 'daño', 'problema', 'soporte'
    ],
    'Instalaciones / Físico': [
        'instalacion', 'instalación', 'instalar', 'retiro', 'traslado', 
        'reubicacion', 'reubicación', 'cambio a fibra', 'desconexión', 
        'recolección', 'recoleccion', 'reconexion', 'reconexión', 'equipo', 'onu', 'pigtail'
    ],
    'Retención / Casos Comerciales': [
        'cancelacion', 'cancelación', 'plan', 'titular', 'descuento', 'fecha', 
        'cancela', 'satisfaccion', 'satisfacción', 'bienvenida', 'oferta', 
        'clausula', 'no interesado', 'comercial', 'encuesta', 'asesoria'
    ],
    'Gestión de Cartera / Cobranza': [
        'cartera', 'pago', 'datacredito', 'datacrédito', 'cobro', 'paz y salvo', 'prorrateo', 'factura', 'deuda', 'mora'
    ]
};

const getTicketCategory = (asunto?: string) => {
    if (!asunto) return 'Otros';
    const name = asunto.toLowerCase();
    for (const [catName, keywords] of Object.entries(CATEGORIES_MAP)) {
        if (keywords.some(kw => name.includes(kw))) {
            return catName;
        }
    }
    return 'Otros';
};

interface DispatchTicket {
    id: string;
    asunto: string;
    nombre_cliente: string;
    barrio: string;
    prioridad: string;
    id_prioridad: number;
    id_estado: number;
    nombre_estado: string;
    score: number;
    recurrence: number;
    fecha_creacion: string;
    horas_abierto: number;
    current_tecnico?: string;
    descripcion?: string;
    direccion?: string;
    telefono?: string;
    celular?: string;
    id_servicio?: string | number;
    creado_por?: string;
    estado_servicio?: string;
    tecnico_actual?: string;
    usuario_wisphub?: string;
    cedula?: string;
    latitud?: string;
    longitud?: string;
    // Campos de tracking (WispHub API)
    fecha_inicio?: string;
    fecha_fin?: string;
    estado?: string;
    isPublished?: boolean;
    servicio_completo?: any;
    servicio?: any;
    nombre_tecnico?: string;
    tecnico_id?: string | number;
    tecnico_usuario?: string;
    email_tecnico?: string;
    departamento?: string;
}

export function OperationsDispatch() {
    const [loading, setLoading] = useState(true);
    const [tickets, setTickets] = useState<DispatchTicket[]>([]);
    const [assignedRoutes, setAssignedRoutes] = useState<Record<string, DispatchTicket[]>>({});
    const [searchQuery, setSearchQuery] = useState('');
    const [neighborhoods, setNeighborhoods] = useState<Record<string, any>>({});
    const [selectedTicket, setSelectedTicket] = useState<DispatchTicket | null>(null);
    const [detailLoading, setDetailLoading] = useState<boolean>(false);
    const [mapFilter, setMapFilter] = useState<string | null>(null);
    const normalize = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

    // Helper para fecha local (MOVIDO ARRIBA PARA EVITAR LINT ERRORS)
    const getLocalToday = useCallback(() => {
        return new Date().toLocaleDateString('en-CA');
    }, []);

    const [activeView, setActiveView] = useState<'dispatch' | 'timeline'>('dispatch');

    // MANIFIESTO DE DESPACHO V3: Persistencia de asignación diaria
    const [dispatchManifest, setDispatchManifest] = useState<Record<string, string>>({});
    const [enrichedCompleted, setEnrichedCompleted] = useState<any[]>([]);
    const [isEnriching, setIsEnriching] = useState(false);

    // Filtros Operativos
    const [filterTechId, setFilterTechId] = useState<string>('all');
    const [filterCategory, setFilterCategory] = useState<string>('all');
    const [showInstallations, setShowInstallations] = useState<boolean>(false);
    const [showHeatmap, setShowHeatmap] = useState<boolean>(false);
    const [selectedDate, setSelectedDate] = useState<string>(getLocalToday());

    // Ref para control del mapa (RESTAURADO)
    const mapRef = useRef<L.Map | null>(null);
    // Refs para evitar procesamientos duplicados o bucles infinitos
    const lastProcessedRef = useRef<string>('');
    const assignedRoutesRef = useRef(assignedRoutes);
    const neighborhoodsRef = useRef(neighborhoods);

    // Sincronizar refs con el estado para que processTickets tenga datos frescos sin ser reactivo
    useEffect(() => { assignedRoutesRef.current = assignedRoutes; }, [assignedRoutes]);
    useEffect(() => { neighborhoodsRef.current = neighborhoods; }, [neighborhoods]);

    const [isFullResyncing, setIsFullResyncing] = useState(false);

    // Inicializar caché de WispHub para mapeo de tickets
    useEffect(() => {
        WisphubService.getStaff();
    }, []);

    // Técnicos de plataforma (Supabase, se refresca cada 5 min)
    const [techList, setTechList] = useState<any[] | null>(null);
    const [isSyncingTechs, setIsSyncingTechs] = useState(false);
    useEffect(() => {
        setIsSyncingTechs(true);
        WorkflowService.getPlatformUsers()
            .then(setTechList)
            .finally(() => setIsSyncingTechs(false));
        const id = setInterval(() => {
            WorkflowService.getPlatformUsers().then(setTechList);
        }, 300000);
        return () => clearInterval(id);
    }, []);

    // Todos los tickets de WispHub (caché compartida, TTL 5 min)
    const { tickets: allWisphubTickets, loading: isSyncingMirror, refresh: mutateMirror } = useWisphubTickets(
        { status: ['1', '2', '3', '4'] },
        { autoRefresh: true, refreshIntervalMs: 5 * 60 * 1000 }
    );

    const rawTickets = useMemo(() => allWisphubTickets.filter(t => [1, 5, '1', '5'].includes(t.id_estado)), [allWisphubTickets]);
    const inProgressTickets = useMemo(() => allWisphubTickets.filter(t => [2, '2'].includes(t.id_estado)), [allWisphubTickets]);
    const completedTicketsRaw = useMemo(() => allWisphubTickets.filter(t => [3, 4, '3', '4'].includes(t.id_estado)), [allWisphubTickets]);

    const mutateTickets = mutateMirror;
    const isGlobalSyncing = isSyncingMirror || isSyncingTechs;


    const technicians = useMemo(() => {
        if (!techList) return [];
        return techList.filter(u => u.is_field_tech === true);
    }, [techList]);

    const isTodayResilient = useCallback((dateStr: string | null | undefined) => {
        if (!dateStr) return false;

        try {
            let date: Date;
            if (dateStr.includes('/') || dateStr.includes('-')) {
                const parts = dateStr.split(/[\/\s-:]/);
                if (parts.length >= 3) {
                    const p0 = parseInt(parts[0]);
                    const p1 = parseInt(parts[1]);
                    const p2 = parseInt(parts[2]);
                    const h = parts[3] ? parseInt(parts[3]) : 0;
                    const m = parts[4] ? parseInt(parts[4]) : 0;

                    if (p0 > 12) {
                        date = new Date(p2, p1 - 1, p0, h, m);
                    } else if (p1 > 12) {
                        date = new Date(p2, p0 - 1, p1, h, m);
                    } else {
                        // Por defecto tratar como MM/DD (Formato API WispHub US)
                        date = new Date(p2, p0 - 1, p1, h, m);
                    }
                } else {
                    date = new Date(dateStr);
                }
            } else {
                date = new Date(dateStr);
            }

            if (isNaN(date.getTime())) return false;

            // AJUSTE CRÍTICO: Restar 5 horas para normalizar el desfase UTC de la API
            const normalizedDate = new Date(date.getTime() - (5 * 60 * 60 * 1000));
            const y = normalizedDate.getFullYear();
            const mo = String(normalizedDate.getMonth() + 1).padStart(2, '0');
            const d = String(normalizedDate.getDate()).padStart(2, '0');
            const normalizedISO = `${y}-${mo}-${d}`;

            return normalizedISO === selectedDate;
        } catch (e) {
            return false;
        }
    }, [selectedDate]);

    const completedToday = useMemo(() => {
        if (!completedTicketsRaw) return [];
        return completedTicketsRaw.filter(t => isTodayResilient(t.fecha_final || t.fecha_fin || t.fecha_termino));
    }, [completedTicketsRaw, isTodayResilient]);

    // Lógica de Persistencia de Manifiesto
    useEffect(() => {
        const stored = localStorage.getItem(`dispatch_manifest_${selectedDate}`);
        if (stored) {
            try {
                const { date, manifest } = JSON.parse(stored);
                if (date === selectedDate) setDispatchManifest(manifest || {});
                else setDispatchManifest({});
            } catch (e) {
                setDispatchManifest({});
            }
        } else {
            setDispatchManifest({});
        }
    }, [selectedDate]);

    const saveManualDispatch = useCallback((newManifestEntries: Record<string, string>, dateStr?: string) => {
        const date = dateStr || getLocalToday();
        setDispatchManifest(prev => {
            const next = { ...prev, ...newManifestEntries };
            localStorage.setItem(`dispatch_manifest_${date}`, JSON.stringify({ date, manifest: next }));
            return next;
        });
    }, [getLocalToday]);

    useEffect(() => {
        // MIGRACIÓN Y LIMPIEZA DE LLAVES ANTIGUAS
        const legacyKeys = ['dispatch_manual_strict_v1', 'dispatch_draft_schedule_v1'];
        let migratedRoutes: Record<string, DispatchTicket[]> | null = null;

        legacyKeys.forEach(key => {
            const stored = localStorage.getItem(key);
            if (stored) {
                try {
                    const { date, routes } = JSON.parse(stored);
                    if (date === getLocalToday()) migratedRoutes = routes;
                } catch (e) { }
                localStorage.removeItem(key); // Limpiar llave antigua
            }
        });

        // CARGA DE LLAVE ESTÁNDAR
        const stored = localStorage.getItem('dispatch_v1_assigned_routes');
        let draftRoutes: Record<string, DispatchTicket[]> = migratedRoutes || {};

        if (stored) {
            try {
                const { date, routes } = JSON.parse(stored);
                if (date === getLocalToday()) {
                    draftRoutes = { ...draftRoutes, ...routes };
                }
            } catch (e) { }
        }

        // Cargar asignaciones reales desde el VPS para sincronizar el estado
        // MODO MANUAL ESTRICTO:
        // No cargamos asignaciones de la BD (WorkflowService.getTodayAssignments).
        // Solo respetamos lo que el usuario haya movido manualmente (draftRoutes).
        if (technicians.length > 0) {
            setAssignedRoutes(prev => {
                const next: Record<string, DispatchTicket[]> = { ...prev, ...draftRoutes };
                let hasChanged = false;

                // Inicializar con técnicos vacíos si no están
                technicians.forEach(tech => {
                    if (!next[tech.id]) {
                        next[tech.id] = [];
                        hasChanged = true;
                    }
                });

                if (!hasChanged) return prev;
                return next;
            });
        }
    }, [technicians.length, getLocalToday]);

    // Persistencia Automática de Rutas
    useEffect(() => {
        if (Object.keys(assignedRoutes).length > 0) {
            localStorage.setItem('dispatch_v1_assigned_routes', JSON.stringify({
                date: getLocalToday(),
                routes: assignedRoutes
            }));
        }
    }, [assignedRoutes, getLocalToday]);

    const processTickets = useCallback(async (allTickets: DispatchTicket[]) => {
        if (allTickets.length === 0) {
            setTickets([]);
            setLoading(false);
            return;
        }

        try {
            // Estado inicial rápido
            setTickets(allTickets.map(t => ({ ...t, barrio: t.barrio || 'Cargando...', score: 0 })));

            // 1. CARGA MASIVA DE RECURRENCIAS (Batching RPC)
            const clientIds = allTickets.map(t => t.servicio ? String(t.servicio) : '').filter(id => id && id !== '0');
            const now = new Date();

            // Intentar carga masiva, si falla (502), usamos 0 por defecto
            let visitCountsMap: Record<string, number> = {};
            try {
                visitCountsMap = await WorkflowService.getClientsVisitCountsBatch(clientIds, now.getFullYear(), now.getMonth() + 1);
            } catch (err) {
                console.warn("Error fetching recurrences (Server might be down):", err);
            }

            const enriched = await Promise.all(allTickets.map(async (t) => {
                const recurrence = visitCountsMap[String(t.servicio)] || 0;
                let score = 0;
                try {
                    score = await WorkflowService.calculateDispatchScore(t, recurrence);
                } catch (err) { /* silent fail on score calc if server 502 */ }

                const barrio = t.barrio || t.servicio_completo?.barrio || t.servicio_completo?.localidad || 'Sin Barrio';
                // Sanitizar nombre_tecnico: el string literal "undefined" se trata como vacío
                const techName = (t.nombre_tecnico && t.nombre_tecnico !== 'undefined') ? t.nombre_tecnico : null;
                return {
                    ...t,
                    barrio,
                    score,
                    recurrence,
                    tecnico_actual: techName || 'Sin Asignar',
                    tecnico_usuario: t.tecnico_usuario // Propagar campo crítico para filtro estricto
                };
            }));

            // El POOL solo debe mostrar tickets que NO están asignados a ningún técnico en la App
            const assignedIds = new Set(Object.values(assignedRoutesRef.current).flat().map(t => t.id));
            const poolTickets = enriched.filter(t => !assignedIds.has(t.id));
            const sorted = poolTickets.sort((a, b) => b.score - a.score);

            setTickets(sorted);
            setLoading(false);

            // Sincronizar assignedRoutes con datos frescos de WispHub (Filtro Anti-Fantasmas)
            const allValidTicketsMap = new Map<string, DispatchTicket>(enriched.map(t => [String(t.id), t]));
            setAssignedRoutes(prev => {
                const next: Record<string, DispatchTicket[]> = { ...prev };
                let modified = false;
                Object.keys(next).forEach(techId => {
                    const currentRoute = next[techId] || [];
                    const updatedRoute = currentRoute
                        .map(t => allValidTicketsMap.get(String(t.id)) || t)
                        .filter(t => allValidTicketsMap.has(String(t.id)));

                    if (JSON.stringify(currentRoute.map(t => t.id)) !== JSON.stringify(updatedRoute.map(t => t.id))) {
                        next[techId] = updatedRoute;
                        modified = true;
                    }
                });
                return modified ? next : prev;
            });

            // Georef (Barrios) - Procesamiento por lotes para no saturar
            const allBarrios = Array.from(new Set(enriched.map(t => t.barrio))).filter(b => b && b !== 'Sin Barrio' && !neighborhoodsRef.current[b]);

            if (allBarrios.length > 0) {
                const batchSize = 5;
                for (let i = 0; i < allBarrios.length; i += batchSize) {
                    const batch = allBarrios.slice(i, i + batchSize);
                    await Promise.all(batch.map(async (b) => {
                        try {
                            const ref = await WorkflowService.getNeighborhoodGeoref(b);
                            if (ref) {
                                setNeighborhoods(prev => ({ ...prev, [b]: ref }));
                            }
                        } catch (e) {
                            console.warn(`Error georeferencing barrio: ${b}`, e);
                        }
                    }));
                }
            }
        } catch (error) {
            console.error("Error in processTickets:", error);
            setLoading(false);
        }
    }, []);

    // Procesamiento de Tickets (Abiertos y En Progreso para el Pool)
    useEffect(() => {
        if (techList !== undefined && rawTickets !== undefined && inProgressTickets !== undefined) {
            const combined = [...(rawTickets || []), ...(inProgressTickets || [])];
            const signature = JSON.stringify(combined.map(t => t.id));

            if (signature !== lastProcessedRef.current) {
                lastProcessedRef.current = signature;
                processTickets(combined);
            }
        }
    }, [rawTickets, inProgressTickets, techList, processTickets]);


    // Filtro para Vista de Despacho (Pool)
    const filteredTickets = useMemo(() => {
        // Obtenemos los IDs asignados actualizados
        const assignedIds = new Set(Object.values(assignedRoutes).flat().map(t => t.id));

        return tickets
            .filter(t => !assignedIds.has(t.id)) // Doble filtro de seguridad para el pool
            .filter(t => {
                const matchesSearch = !searchQuery || normalize(t.nombre_cliente).includes(normalize(searchQuery)) || normalize(t.barrio).includes(normalize(searchQuery));
                const selectedTech = technicians.find(tech => tech.id === filterTechId);
                const matchesTech = filterTechId === 'all' || (selectedTech?.full_name && t.tecnico_actual && normalize(t.tecnico_actual).includes(normalize(selectedTech.full_name)));
                // FILTRO ESTRICTO DE INSTALACIONES:
                // Un ticket es de instalaciones si coincide el usuario o el correo electrónico conocido
                const isInstallationTicket = t.tecnico_usuario === 'instalaciones@rapilink-sas';

                // Si el toggle está OFF → excluir instalaciones del pool (matchesInstall=false para ellos)
                // Si el toggle está ON  → mostrar SOLO instalaciones
                const matchesInstall = showInstallations ? isInstallationTicket : !isInstallationTicket;
                const matchesMap = !mapFilter || t.barrio === mapFilter;
                
                // NUEVO FILTRO DE CATEGORÍA
                const matchesCategory = filterCategory === 'all' || getTicketCategory(t.asunto) === filterCategory;

                return matchesSearch && matchesTech && matchesInstall && matchesMap && matchesCategory;
            });
    }, [tickets, assignedRoutes, searchQuery, filterTechId, showInstallations, mapFilter, technicians, filterCategory]);

    const ticketsByNeighborhood = useMemo(() => {
        return filteredTickets.reduce((acc, t) => {
            if (!t.barrio || t.barrio === 'Sin Barrio') return acc;
            if (!acc[t.barrio]) acc[t.barrio] = [];
            acc[t.barrio].push(t);
            return acc;
        }, {} as Record<string, DispatchTicket[]>);
    }, [filteredTickets]);

    // ANALÍTICA DE FALLAS PARA MAPA DE CALOR (REACTIVA AL BARRIO)
    const failureAnalytics = useMemo(() => {
        const failureKeywords = ['falla', 'sin internet', 'lento', 'corte', 'intermitente', 'rojo', 'señal', 'soporte'];
        const failures = tickets.filter(t =>
            failureKeywords.some(kw => (t.asunto || '').toLowerCase().includes(kw) || (t.descripcion || '').toLowerCase().includes(kw))
        );

        const groups: Record<string, { count: number; lat: number; lng: number }> = {};
        failures.forEach(f => {
            const b = f.barrio || 'Sin Barrio';
            if (b === 'Sin Barrio') return;

            const nh = neighborhoods[b];
            if (!groups[b]) {
                groups[b] = {
                    count: 0,
                    lat: nh?.latitude ? parseFloat(nh.latitude) : 7.12539,
                    lng: nh?.longitude ? parseFloat(nh.longitude) : -73.1198
                };
            }
            groups[b].count++;
        });
        return groups;
    }, [tickets, neighborhoods]);

    // Carga Profunda (Timeline)
    useEffect(() => {
        if (activeView === 'timeline' && completedToday.length > 0 && !isEnriching) {
            const enrich = async () => {
                setIsEnriching(true);
                const enriched = [];
                const toProcess = completedToday.slice(0, 30);
                for (const t of toProcess) {
                    try {
                        const detail = await WisphubService.getTicketDetail(t.id);
                        enriched.push({ ...t, ...detail });
                    } catch (e) { enriched.push(t); }
                }
                setEnrichedCompleted(enriched);
                setIsEnriching(false);
            };
            enrich();
        }
    }, [activeView, completedToday.length]);

    // Iconos de Leaflet
    useEffect(() => {
        const DefaultIcon = L.icon({
            iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
            shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
            iconSize: [25, 41],
            iconAnchor: [12, 41]
        });
        L.Marker.prototype.options.icon = DefaultIcon;
    }, []);

    const onDragEnd = (result: DropResult) => {
        const { source, destination, draggableId } = result;
        if (!destination) return;
        if (source.droppableId === destination.droppableId && source.index === destination.index) return;

        // Caso 1: Reordenamiento dentro de la misma lista
        if (source.droppableId === destination.droppableId) {
            if (source.droppableId === 'unassigned') {
                setTickets(prev => {
                    const newList = Array.from(prev);
                    const [removed] = newList.splice(source.index, 1);
                    newList.splice(destination.index, 0, removed);
                    return newList;
                });
            } else {
                setAssignedRoutes(prev => {
                    const newList = Array.from(prev[source.droppableId] || []);
                    const [removed] = newList.splice(source.index, 1);
                    newList.splice(destination.index, 0, removed);
                    return { ...prev, [source.droppableId]: newList };
                });
            }
            return;
        }

        // Caso 2: Movimiento entre listas diferentes
        const itemToMove = source.droppableId === 'unassigned'
            ? tickets.find(t => String(t.id) === String(draggableId))
            : (assignedRoutes[source.droppableId] || []).find(t => String(t.id) === String(draggableId));

        if (!itemToMove) return;

        // --- LÓGICA DE REASIGNACIÓN INTELIGENTE ---
        // Si el ticket ya estaba publicado, reasignar inmediatamente en el VPS/WispHub
        if (itemToMove.isPublished && destination.droppableId !== 'unassigned') {
            const destTech = technicians.find(t => t.id === destination.droppableId);
            if (confirm(`¿Reasignar este ticket a ${destTech?.full_name}? El cambio será inmediato.`)) {
                WorkflowService.reassignPublishedTicket(String(itemToMove.id), destination.droppableId)
                    .then(success => {
                        if (success) {
                            mutateTickets(); // Refrescar datos
                        } else {
                            alert('Error al reasignar en el servidor. El cambio solo será visual.');
                        }
                    });
            } else {
                return; // Cancelar movimiento
            }
        }

        // Remover de origen e insertar en destino
        if (source.droppableId === 'unassigned') {
            setTickets(prev => prev.filter(t => t.id !== draggableId));
            setAssignedRoutes(prev => {
                const destList = Array.from(prev[destination.droppableId] || []);
                destList.splice(destination.index, 0, itemToMove);
                return { ...prev, [destination.droppableId]: destList };
            });
        } else if (destination.droppableId === 'unassigned') {
            setAssignedRoutes(prev => ({
                ...prev,
                [source.droppableId]: (prev[source.droppableId] || []).filter(t => t.id !== draggableId)
            }));
            setTickets(prev => {
                const newList = Array.from(prev);
                newList.splice(destination.index, 0, itemToMove);
                return newList;
            });
        } else {
            // Entre dos técnicos diferentes
            setAssignedRoutes(prev => {
                const newRoutes = { ...prev };
                const sourceList = Array.from(newRoutes[source.droppableId] || []);
                const destList = Array.from(newRoutes[destination.droppableId] || []);

                sourceList.splice(source.index, 1);
                // Si viene de una lista publicada, mantenemos la marca en el destino si se mueve entre técnicos
                destList.splice(destination.index, 0, itemToMove);

                newRoutes[source.droppableId] = sourceList;
                newRoutes[destination.droppableId] = destList;
                return newRoutes;
            });
        }
    };

    const handleFullResync = async () => {
        if (isFullResyncing) return;
        setIsFullResyncing(true);
        window.dispatchEvent(new CustomEvent('app:toast', {
            detail: { id: 'deep-sync', message: 'Actualizando tickets desde WispHub...', type: 'loading', duration: 0 }
        }));

        try {
            await mutateMirror();
            window.dispatchEvent(new CustomEvent('app:toast', {
                detail: { id: 'deep-sync', message: 'Tickets actualizados desde WispHub.', type: 'success', duration: 3000 }
            }));
        } catch {
            window.dispatchEvent(new CustomEvent('app:toast', {
                detail: { id: 'deep-sync', message: 'Error al actualizar tickets.', type: 'error', duration: 3000 }
            }));
        } finally {
            setIsFullResyncing(false);
        }
    };

    const handlePublish = async () => {
        const entries = Object.entries(assignedRoutes).filter(([, tickets]) => tickets.length > 0);
        const total = entries.reduce((sum, [, tickets]) => sum + tickets.length, 0);

        if (total === 0) {
            window.dispatchEvent(new CustomEvent('app:toast', { detail: { message: 'No hay tickets asignados para publicar.', type: 'info' } }));
            return;
        }
        if (!confirm(`¿Deseas publicar ${total} ticket(s) para ${entries.length} técnico(s)?`)) return;

        setLoading(true);
        window.dispatchEvent(new CustomEvent('app:toast', { detail: { id: 'publish-progress', message: `Publicando ${total} tickets...`, type: 'loading', duration: 0 } }));

        try {
            const manifestEntries: Record<string, string> = {};
            const failedTickets: Array<{ ticket: DispatchTicket; techId: string }> = [];

            // PRIMERA PASADA: Ejecutar TODAS las reasignaciones en PARALELO
            await Promise.all(
                entries.flatMap(([techId, routeTickets]) => {
                    const technician = technicians.find(t => t.id === techId);
                    return routeTickets.map(async (ticket) => {
                        const ok = await WorkflowService.changeWispHubTechnician(ticket.id, techId);
                        if (ok && technician) {
                            manifestEntries[String(ticket.id)] = technician.full_name || 'Desconocido';
                        } else {
                            // Capturar fallos para reintentar
                            failedTickets.push({ ticket, techId });
                        }
                    });
                })
            );

            // SEGUNDA PASADA: Reintentar tickets fallidos secuencialmente con delay
            const stillFailed: typeof failedTickets = [];
            for (const { ticket, techId } of failedTickets) {
                await new Promise(r => setTimeout(r, 600));
                const ok = await WorkflowService.changeWispHubTechnician(ticket.id, techId);
                if (ok) {
                    const technician = technicians.find(t => t.id === techId);
                    manifestEntries[String(ticket.id)] = technician?.full_name || 'Desconocido';
                    console.log(`[handlePublish] ✅ Reintento exitoso: ticket ${ticket.id} asignado a ${technician?.full_name}`);
                } else {
                    stillFailed.push({ ticket, techId });
                    console.warn(`[handlePublish] ❌ Fallo definitivo tras reintento: ticket ${ticket.id}`);
                }
            }

            // Guardar manifiesto local y auditoría
            saveManualDispatch(manifestEntries);

            // Conteo correcto de técnicos únicos con éxito
            const successfulTechIds = new Set(
                entries
                    .filter(([_techId, routeTickets]) => routeTickets.some(t => manifestEntries[String(t.id)]))
                    .map(([techId]) => techId)
            );
            const techCount = successfulTechIds.size;

            await WorkflowService.logDispatchBatch(techCount, Object.keys(manifestEntries).length, {
                manifest: manifestEntries,
                failed_ids: stillFailed.map(f => String(f.ticket.id))
            });

            mutateTickets();

            // Toast diferenciado según resultados
            const successful = Object.keys(manifestEntries).length;
            if (stillFailed.length === 0) {
                window.dispatchEvent(new CustomEvent('app:toast', {
                    detail: {
                        id: 'publish-progress',
                        message: `¡Despacho publicado! ${successful}/${total} tickets reasignados.`,
                        type: 'success'
                    }
                }));
            } else {
                const failedNames = stillFailed.map(f => f.ticket.asunto).join(', ');
                window.dispatchEvent(new CustomEvent('app:toast', {
                    detail: {
                        id: 'publish-progress',
                        message: `⚠️ ${successful}/${total} publicados. Fallos: ${failedNames}`,
                        type: 'warning',
                        duration: 8000
                    }
                }));
            }
        } catch (e) {
            console.error('[handlePublish] Error:', e);
            window.dispatchEvent(new CustomEvent('app:toast', { detail: { id: 'publish-progress', message: 'Error al publicar despacho. Revisa la consola.', type: 'error' } }));
        } finally {
            setLoading(false);
        }
    };

    const calculateBounds = useCallback(() => {
        const poolVisible = filteredTickets.filter(t => neighborhoods[t.barrio]?.latitude);
        const assignedVisible = filterTechId !== 'all'
            ? (assignedRoutes[filterTechId] || []).filter(t => neighborhoods[t.barrio]?.latitude)
            : [];

        const allVisible = [...poolVisible, ...assignedVisible];
        if (allVisible.length === 0) return null;
        return L.latLngBounds(allVisible.map(t => [Number(neighborhoods[t.barrio].latitude), Number(neighborhoods[t.barrio].longitude)]));
    }, [filteredTickets, assignedRoutes, filterTechId, neighborhoods]);

    useEffect(() => {
        if (!mapRef.current || activeView !== 'dispatch') return;
        const bounds = calculateBounds();
        if (bounds) mapRef.current.flyToBounds(bounds, { padding: [50, 50] });
    }, [calculateBounds, activeView]);

    const loadTicketDetail = async (id: string) => {
        setDetailLoading(true);
        try {
            const detail = await WisphubService.getTicketDetail(id);
            if (detail && selectedTicket?.id === id) {
                setSelectedTicket({ ...selectedTicket, ...detail });
            }
        } catch (e) { } finally { setDetailLoading(false); }
    };
    useEffect(() => { if (selectedTicket && !selectedTicket.creado_por) loadTicketDetail(selectedTicket.id); }, [selectedTicket?.id]);

    if (!techList) {
        return (
            <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
                <Loader2 className="w-12 h-12 animate-spin text-primary" />
                <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Iniciando Despacho...</p>
            </div>
        );
    }


    return (
        <div className="animate-in fade-in duration-700 h-full w-full overflow-hidden relative bg-slate-900">
            <DragDropContext onDragEnd={onDragEnd}>

                {/* CAPA 0: MAPA BASE (FULLSCREEN) */}
                <div className="absolute inset-0 z-0">
                    <div className="w-full h-full relative overflow-hidden">
                        {activeView === 'dispatch' ? (
                            <MapContainer
                                ref={mapRef}
                                center={[10.9685, -74.7813]} // Default center for Barranquilla
                                zoom={12}
                                style={{ height: '100%', width: '100%' }}
                                zoomControl={false}
                                className="z-0"
                            >
                                <TileLayer
                                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                                    url="https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
                                />
                                {Object.entries(ticketsByNeighborhood).map(([bName, ticketsInNeighborhood]) => {
                                    const data = {
                                        count: ticketsInNeighborhood.length,
                                        lat: neighborhoods[bName]?.latitude,
                                        lng: neighborhoods[bName]?.longitude
                                    };
                                    if (!data.lat || !data.lng) return null;

                                    return (
                                        <Marker
                                            key={bName}
                                            position={[data.lat, data.lng]}
                                            icon={createClusterIcon(data.count)}
                                            eventHandlers={{
                                                click: () => setMapFilter(bName)
                                            }}
                                        >
                                            <Popup className="noc-popup">
                                                <div className="p-3 text-center min-w-[120px]">
                                                    <p className="text-[10px] font-black uppercase text-slate-400 mb-1">{bName}</p>
                                                    <div className="bg-primary/10 text-primary text-[10px] font-black py-2 px-3 rounded-xl border border-primary/20">
                                                        {data.count} Reportes activos
                                                    </div>
                                                </div>
                                            </Popup>
                                        </Marker>
                                    );
                                })}

                                {/* WAYPOINTS INDIVIDUALES PARA EL TÉCNICO SELECCIONADO */}
                                {filterTechId !== 'all' && (assignedRoutes[filterTechId] || []).map((t, idx) => {
                                    const lat = neighborhoods[t.barrio]?.latitude;
                                    const lng = neighborhoods[t.barrio]?.longitude;
                                    if (!lat || !lng) return null;

                                    return (
                                        <Marker
                                            key={`tech-wp-${t.id}`}
                                            position={[Number(lat), Number(lng)]}
                                            icon={L.divIcon({
                                                className: 'custom-div-icon',
                                                html: `<div class="w-6 h-6 bg-primary text-white rounded-full border-2 border-white shadow-lg flex items-center justify-center text-[10px] font-black">${idx + 1}</div>`,
                                                iconSize: [24, 24],
                                                iconAnchor: [12, 12]
                                            })}
                                        >
                                            <Popup>
                                                <div className="p-2">
                                                    <p className="text-[9px] font-black uppercase text-primary mb-0.5">ORDEN #${idx + 1}</p>
                                                    <p className="text-[10px] font-bold text-slate-800">{t.nombre_cliente}</p>
                                                    <p className="text-[8px] font-medium text-slate-500 mt-1 uppercase">{t.barrio}</p>
                                                </div>
                                            </Popup>
                                        </Marker>
                                    );
                                })}

                                {showHeatmap && Object.entries(failureAnalytics).map(([bName, data]) => (
                                    <Circle
                                        key={`heat-${bName}`}
                                        center={[data.lat, data.lng]}
                                        radius={200 + (data.count * 100)}
                                        pathOptions={{
                                            fillColor: data.count > 4 ? '#ef4444' : data.count > 2 ? '#f97316' : '#eab308',
                                            color: 'transparent',
                                            fillOpacity: 0.4
                                        }}
                                    >
                                        <Popup>
                                            <div className="p-1 text-center">
                                                <p className="text-[10px] font-black uppercase text-red-600">{bName}</p>
                                                <p className="text-[9px] font-bold">Fallas Técnicas: {data.count}</p>
                                            </div>
                                        </Popup>
                                    </Circle>
                                ))}
                            </MapContainer>
                        ) : (
                            <div className="w-full h-full overflow-y-auto custom-scrollbar pt-40 px-6 bg-slate-50">
                                <OperationalTimeline
                                    // Solo pasamos tickets que están en el Borrador (assignedRoutes) 
                                    // o que ya fueron despachados hoy (dispatchManifest)
                                    // Inyectamos _assignedTechId para que el Timeline sepa a quién pertenecen
                                    tickets={[
                                        ...Object.entries(assignedRoutes).flatMap(([techId, routes]) =>
                                            routes.map(t => ({ ...t, _assignedTechId: techId }))
                                        ),
                                        ...(tickets
                                            .filter(t => dispatchManifest[String(t.id)] && !Object.values(assignedRoutes).flat().some(at => String(at.id) === String(t.id)))
                                            .map(t => {
                                                const techName = dispatchManifest[String(t.id)];
                                                const tech = technicians.find(ft => ft.full_name === techName);
                                                return { ...t, _assignedTechId: tech?.id };
                                            })
                                        ),
                                        // FALLBACK DE SEGURIDAD: Tickets que están en el manifiesto pero WispHub
                                        // aún no los reporta ni en activos ni en completados (Transición)
                                        ...Object.keys(dispatchManifest)
                                            .filter(id => {
                                                const isInActive = tickets.some(t => String(t.id) === id);
                                                const isInCompleted = (enrichedCompleted.length > 0 ? enrichedCompleted : completedToday).some(t => String(t.id) === id);
                                                const isInRoute = Object.values(assignedRoutes).flat().some(at => String(at.id) === id);
                                                return !isInActive && !isInCompleted && !isInRoute;
                                            })
                                            .map(id => {
                                                const techName = dispatchManifest[id];
                                                const tech = technicians.find(ft => ft.full_name === techName);
                                                return {
                                                    id,
                                                    nombre_cliente: 'Actualizando WispHub...',
                                                    barrio: '...',
                                                    asunto: 'Sincronizando estado',
                                                    _assignedTechId: tech?.id,
                                                    _forceTimeline: true
                                                };
                                            })
                                    ]}
                                    fieldTechnicians={technicians}
                                    // En progreso solo lo que nosotros despachamos hoy
                                    inProgressTickets={(inProgressTickets || [])
                                        .filter(t => dispatchManifest[String(t.id)] || Object.values(assignedRoutes).flat().some(at => String(at.id) === String(t.id)))
                                        .map(t => {
                                            const techIdFromRoute = Object.entries(assignedRoutes).find(([_, routes]) => routes.some(at => String(at.id) === String(t.id)))?.[0];
                                            const techName = dispatchManifest[String(t.id)];
                                            const techFromManifest = technicians.find(ft => ft.full_name === techName);
                                            return { ...t, _assignedTechId: techIdFromRoute || techFromManifest?.id };
                                        })
                                    }
                                    // Completados solo lo que nosotros despachamos hoy
                                    // Agregamos una capa de seguridad: si el ticket está en el manifiesto pero no aparece aún en completados ni en activos,
                                    // es que está en proceso de cierre o transición.
                                    completedTickets={[
                                        ...(enrichedCompleted.length > 0 ? enrichedCompleted : completedToday)
                                            .filter(t => dispatchManifest[String(t.id)])
                                            .map(t => {
                                                const techName = dispatchManifest[String(t.id)];
                                                const tech = technicians.find(ft => ft.full_name === techName);
                                                return { ...t, _assignedTechId: tech?.id };
                                            })
                                    ]}
                                />
                            </div>
                        )}
                    </div>
                </div>

                {/* CAPA 1: OVERLAY DE WIDGETS */}
                <div className="absolute inset-0 z-10 p-3 md:p-4 pointer-events-none overflow-hidden">
                    {/* CAPA 1.1: ENCABEZADO FLOTANTE (CENTRAL) */}
                    <div className="absolute top-6 left-1/2 -translate-x-1/2 z-[200] flex flex-col items-center gap-3 w-full pointer-events-none">
                        {/* CENTRO DE DESPACHO & STATS (ULTRA-COMPACTO) */}
                        <div className="flex items-center gap-6 bg-white/60 backdrop-blur-3xl px-6 py-2.5 rounded-full border border-white/50 shadow-lg pointer-events-auto">
                            <div className="flex items-center gap-3">
                                <div className="flex flex-col">
                                    <div className="flex items-center gap-3">
                                        <div className="flex items-center gap-1.5 px-2 py-0.5 bg-emerald-50 rounded-full border border-emerald-100 animate-pulse">
                                            <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full shadow-[0_0_6px_rgba(16,185,129,0.5)]" />
                                            <span className="text-[8px] font-black text-emerald-600 uppercase tracking-widest">Vivo</span>
                                        </div>
                                        <h1 className="text-xl font-black text-slate-900 uppercase tracking-tighter leading-none">
                                            Centro de Despacho
                                        </h1>
                                    </div>
                                    {(isGlobalSyncing || isFullResyncing) && (
                                        <div className="flex items-center gap-1.5 mt-1 ml-1 px-2 py-0.5 bg-primary/5 rounded-full border border-primary/10 animate-pulse w-fit">
                                            <Loader2 className="w-2 h-2 animate-spin text-primary" />
                                            <span className="text-[7px] font-black text-primary uppercase tracking-widest">
                                                {isFullResyncing ? 'Re-Sincronización Profunda' : 'Sincronizando Sistema'}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>

                            <button
                                onClick={handleFullResync}
                                disabled={isFullResyncing}
                                title="Resincronización Profunda (Borra tickets fantasma)"
                                className={clsx(
                                    "p-2 rounded-xl border border-slate-200/50 bg-white/50 backdrop-blur-xl transition-all pointer-events-auto",
                                    isFullResyncing ? "text-primary bg-primary/5 border-primary/20 animate-spin" : "text-slate-400 hover:text-primary hover:bg-white hover:border-slate-300"
                                )}
                            >
                                <RefreshCw size={18} />
                            </button>

                            <div className="flex items-center gap-6 pl-6 border-l border-slate-200/50">
                                <div className="flex flex-col">
                                    <span className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em] mb-0.5 leading-none">Barrios</span>
                                    <span className="text-xl font-black text-slate-900 tracking-tighter leading-none tabular-nums">{Object.keys(neighborhoods).length}</span>
                                </div>
                                <div className="flex flex-col">
                                    <span className="text-[8px] font-black text-slate-400 uppercase tracking-[0.2em] mb-0.5 leading-none">Tickets</span>
                                    <span className="text-xl font-black text-slate-900 tracking-tighter leading-none tabular-nums">{filteredTickets.length}</span>
                                </div>
                            </div>
                        </div>

                        {/* SELECTOR DE VISTA (TABS) */}
                        <div className="flex items-center gap-3">
                            <div className="bg-white/50 backdrop-blur-2xl p-1 rounded-[1.5rem] flex gap-1 pointer-events-auto border border-white/40 shadow-lg">
                                <button
                                    onClick={() => setActiveView('dispatch')}
                                    className={clsx(
                                        "px-6 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all",
                                        activeView === 'dispatch' ? "bg-white text-primary shadow-md border border-slate-100" : "text-slate-400 hover:text-slate-600"
                                    )}
                                >
                                    Mapa
                                </button>
                                <button
                                    onClick={() => setShowHeatmap(!showHeatmap)}
                                    className={clsx(
                                        "px-5 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center gap-2.5",
                                        showHeatmap ? "bg-red-500 text-white shadow-lg shadow-red-200" : "bg-white/30 text-slate-500 hover:text-red-500 hover:bg-white/60"
                                    )}
                                >
                                    <div className={clsx("w-1.5 h-1.5 rounded-full", showHeatmap ? "bg-white animate-pulse shadow-[0_0_6px_rgba(255,255,255,0.8)]" : "bg-red-500")} />
                                    Calor
                                </button>
                                <button
                                    onClick={() => setActiveView('timeline')}
                                    className={clsx(
                                        "px-6 py-2.5 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all",
                                        activeView === 'timeline' ? "bg-white text-primary shadow-md border border-slate-100" : "text-slate-400 hover:text-slate-600"
                                    )}
                                >
                                    Jornada
                                </button>
                            </div>

                            {activeView === 'timeline' && (
                                <div className="bg-white/80 backdrop-blur-xl p-1 rounded-2xl flex gap-1 pointer-events-auto border border-slate-200">
                                    <input
                                        type="date"
                                        value={selectedDate}
                                        onChange={(e) => setSelectedDate(e.target.value)}
                                        className="bg-transparent px-4 py-1.5 text-[10px] font-black uppercase tracking-widest text-primary outline-none"
                                    />
                                </div>
                            )}

                            <button
                                onClick={() => {
                                    if (confirm(`¿Cerrar Jornada de ${selectedDate}? Se limpiarán los borradores y el manifiesto local de este día.`)) {
                                        localStorage.removeItem('dispatch_v1_assigned_routes');
                                        localStorage.removeItem('dispatch_draft_schedule_v1');
                                        localStorage.removeItem('dispatch_manual_strict_v1');
                                        localStorage.removeItem(`dispatch_manifest_${selectedDate}`);
                                        setAssignedRoutes({});
                                        setDispatchManifest({});
                                        window.location.reload();
                                    }
                                }}
                                title="Limpiar todo para empezar de cero"
                                className="bg-white/80 backdrop-blur-xl p-2 rounded-2xl border border-white/50 shadow-sm pointer-events-auto hover:bg-red-50 hover:text-red-500 transition-all text-slate-400"
                            >
                                <X size={20} />
                            </button>
                        </div>
                    </div>

                    {/* CAPA 1.2: CONTENIDO DE DESPACHO (LATERALES) */}
                    {activeView === 'dispatch' && (
                        <div className="grid grid-cols-[280px_1fr_300px] gap-4 w-full h-full">
                            {/* Columna Izquierda: Control & Pool */}
                            <div className="w-[320px] flex flex-col gap-3 h-full overflow-hidden pointer-events-none">
                                {/* Widget: Filtros */}
                                <div className="bg-white/80 backdrop-blur-2xl p-4 rounded-3xl border border-white/50 shadow-xl pointer-events-auto animate-in slide-in-from-left-8 duration-700">
                                    <div className="flex items-center justify-between mb-3 px-1">
                                        <div className="flex items-center gap-2">
                                            <div className="w-1.5 h-5 bg-primary rounded-full"></div>
                                            <h2 className="text-[10px] font-black uppercase tracking-widest text-slate-800">Filtros</h2>
                                        </div>
                                        <div className="bg-slate-100 px-2 py-0.5 rounded-full text-[10px] font-black text-slate-500 tabular-nums">
                                            {filteredTickets.length} / {tickets.length}
                                        </div>
                                    </div>

                                    <div className="space-y-3">
                                        <div>
                                            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest ml-1 mb-1 block">Técnico Asignado</label>
                                            <div className="relative">
                                                <select
                                                    value={filterTechId}
                                                    onChange={(e) => setFilterTechId(e.target.value)}
                                                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-[10px] font-bold text-slate-700 outline-none focus:ring-1 focus:ring-primary/20 transition-all appearance-none pr-8"
                                                >
                                                    <option value="all">Todos los Técnicos</option>
                                                    {technicians.map(t => (
                                                        <option key={t.id} value={t.id}>{t.full_name}</option>
                                                    ))}
                                                </select>
                                                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={12} />
                                            </div>
                                        </div>

                                        <div>
                                            <label className="text-[9px] font-bold text-slate-400 uppercase tracking-widest ml-1 mb-1 block">Categoría de Asunto</label>
                                            <div className="relative">
                                                <select
                                                    value={filterCategory}
                                                    onChange={(e) => setFilterCategory(e.target.value)}
                                                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-[10px] font-bold text-slate-700 outline-none focus:ring-1 focus:ring-primary/20 transition-all appearance-none pr-8"
                                                >
                                                    <option value="all">Todas las Categorías</option>
                                                    <option value="Soporte Técnico / Falla">Soporte Técnico / Falla</option>
                                                    <option value="Instalaciones / Físico">Instalaciones / Físico</option>
                                                    <option value="Retención / Casos Comerciales">Retención / Casos Comerciales</option>
                                                    <option value="Gestión de Cartera / Cobranza">Gestión de Cartera / Cobranza</option>
                                                    <option value="Otros">Otros (No Reconocidos)</option>
                                                </select>
                                                <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" size={12} />
                                            </div>
                                        </div>

                                        <div className="flex items-center justify-between p-2.5 bg-slate-50 rounded-xl border border-slate-200/50">
                                            <label className="flex items-center gap-2 cursor-pointer group">
                                                <div className="relative">
                                                    <input
                                                        type="checkbox"
                                                        checked={showInstallations}
                                                        onChange={(e) => setShowInstallations(e.target.checked)}
                                                        className="sr-only peer"
                                                    />
                                                    <div className="w-8 h-4 bg-slate-200 rounded-full peer peer-checked:bg-primary transition-all duration-300"></div>
                                                    <div className="absolute left-0.5 top-0.5 w-3 h-3 bg-white rounded-full peer-checked:translate-x-4 transition-all duration-300 shadow-sm"></div>
                                                </div>
                                                <span className="text-[9px] font-black uppercase text-slate-600 group-hover:text-primary transition-colors tracking-tight">Ver Instalaciones</span>
                                            </label>
                                        </div>
                                    </div>
                                </div>

                                {/* Widget: Pool de Tickets Pendientes */}
                                <div className="flex-1 flex flex-col min-h-0 bg-white/70 backdrop-blur-3xl rounded-[1.5rem] border border-white/50 shadow-2xl overflow-hidden pointer-events-auto animate-in slide-in-from-left-8 duration-700 delay-150">
                                    <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between bg-white/50">
                                        <div className="flex items-center gap-2">
                                            <Truck size={12} className="text-primary" />
                                            <h2 className="text-[10px] font-black uppercase tracking-tight text-slate-800">Pool Pendientes</h2>
                                        </div>
                                    </div>

                                    <div className="px-3 py-2.5">
                                        <div className="relative">
                                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={14} />
                                            <input
                                                type="text"
                                                placeholder="Buscar..."
                                                value={searchQuery}
                                                onChange={(e) => setSearchQuery(e.target.value)}
                                                className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-9 pr-3 py-2 text-[10px] font-bold text-slate-700 outline-none focus:bg-white transition-all"
                                            />
                                        </div>
                                    </div>

                                    <div className="flex-1 overflow-y-auto custom-scrollbar px-3 pb-4">
                                        <Droppable droppableId="unassigned">
                                            {(provided, snapshot) => (
                                                <div
                                                    {...provided.droppableProps}
                                                    ref={provided.innerRef}
                                                    className={clsx(
                                                        "min-h-[200px] transition-all duration-300 rounded-xl",
                                                        snapshot.isDraggingOver ? "bg-primary/5 ring-1 ring-primary/20 ring-dashed" : "bg-transparent"
                                                    )}
                                                >
                                                    {filteredTickets.map((ticket, index) => (
                                                        <Draggable key={ticket.id} draggableId={String(ticket.id)} index={index}>
                                                            {(provided, snapshot) => {
                                                                const content = (
                                                                    <div
                                                                        ref={provided.innerRef}
                                                                        {...provided.draggableProps}
                                                                        {...provided.dragHandleProps}
                                                                        className={clsx(
                                                                            "group p-2.5 mb-1.5 rounded-xl transition-all border shadow-sm",
                                                                            snapshot.isDragging
                                                                                ? "bg-white shadow-xl border-primary ring-2 ring-primary/10 rotate-1 z-[9999] opacity-100 scale-105"
                                                                                : "bg-white border-slate-100 hover:border-primary/30 hover:shadow-md"
                                                                        )}
                                                                        onClick={() => setSelectedTicket(ticket)}
                                                                    >
                                                                        <div className="flex items-center justify-between mb-1">
                                                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                                                <div className="px-1.5 py-0.5 bg-slate-100 rounded text-[8px] font-black text-slate-500 uppercase tracking-tighter">#{ticket.id}</div>
                                                                                <div className={clsx(
                                                                                    "px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-tighter",
                                                                                    ticket.horas_abierto > 48 ? "bg-red-100 text-red-600" :
                                                                                        ticket.horas_abierto > 24 ? "bg-amber-100 text-amber-600" :
                                                                                            "bg-emerald-100 text-emerald-600"
                                                                                )}>
                                                                                    {ticket.horas_abierto >= 24
                                                                                        ? `${Math.floor(ticket.horas_abierto / 24)}d ${ticket.horas_abierto % 24}h`
                                                                                        : `${ticket.horas_abierto}h`}
                                                                                </div>
                                                                                {ticket.id_estado === 5 && (
                                                                                    <div className="px-1.5 py-0.5 bg-amber-500 text-white text-[8px] font-black uppercase rounded shadow-sm animate-pulse">
                                                                                        Escalado
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                            {ticket.id_prioridad >= 4 && (
                                                                                <div className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.5)]"></div>
                                                                            )}
                                                                        </div>
                                                                        <h3 className="text-[11px] font-black text-slate-900 group-hover:text-primary transition-colors leading-[1.1] mb-1 line-clamp-2">{ticket.nombre_cliente}</h3>
                                                                        <div className="flex items-center gap-1 text-slate-400">
                                                                            <MapPin size={8} className="text-primary/60 shrink-0" />
                                                                            <span className="text-[9px] font-bold uppercase tracking-tight truncate">{ticket.barrio}</span>
                                                                        </div>
                                                                        <div className="mt-1.5 pt-1 border-t border-slate-50 flex justify-between items-center gap-2">
                                                                            <span className="text-[8px] font-black text-slate-400 uppercase tracking-widest truncate flex-1">{ticket.asunto}</span>
                                                                        </div>
                                                                    </div>
                                                                );

                                                                if (snapshot.isDragging) {
                                                                    return <Portal>{content}</Portal>;
                                                                }
                                                                return content;
                                                            }}
                                                        </Draggable>
                                                    ))}
                                                    {provided.placeholder}
                                                </div>
                                            )}
                                        </Droppable>
                                    </div>
                                </div>
                            </div>

                            <div className="relative min-w-0 h-full">
                                {/* WIDGET: BADGE DE FILTRO MAPA (BOTTOM CENTER) */}
                                {mapFilter && (
                                    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-primary text-white px-8 py-4 rounded-full shadow-2xl flex items-center gap-4 pointer-events-auto animate-in slide-in-from-bottom-8 duration-500">
                                        <MapPin size={16} className="animate-bounce" />
                                        <span className="text-xs font-black uppercase tracking-widest">Barrio: {mapFilter}</span>
                                        <button
                                            onClick={() => setMapFilter(null)}
                                            className="bg-white/20 hover:bg-white/40 p-1.5 rounded-full transition-colors"
                                        >
                                            <X size={16} />
                                        </button>
                                    </div>
                                )}
                            </div>

                            {/* COLUMNA DERECHA: ASIGNACIÓN & TÉCNICOS */}
                            <div className="flex flex-col gap-4 h-full overflow-hidden">

                                {/* HEADER DE ASIGNACIÓN COMPACTO */}
                                <div className="bg-slate-900/90 backdrop-blur-3xl px-4 py-3 rounded-2xl border border-white/10 shadow-2xl flex items-center justify-between pointer-events-auto">
                                    <div className="flex flex-col">
                                        <h2 className="text-[10px] font-black text-white uppercase tracking-tighter leading-none">Asignación</h2>
                                        <span className="text-[8px] font-bold text-white/30 uppercase tracking-widest mt-1">Hoy</span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <button
                                            onClick={() => {
                                                mutateTickets();
                                                alert('Datos actualizados');
                                            }}
                                            className="px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all bg-white/5 text-slate-400 hover:bg-white/10 hover:text-white border border-white/5"
                                        >
                                            Refrescar
                                        </button>
                                        <button
                                            onClick={handlePublish}
                                            disabled={loading || Object.keys(assignedRoutes).length === 0}
                                            className={clsx(
                                                "px-4 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all flex items-center gap-2",
                                                loading || Object.keys(assignedRoutes).length === 0
                                                    ? "bg-slate-800 text-slate-500 cursor-not-allowed border border-white/5"
                                                    : "bg-primary text-white shadow-lg shadow-primary/25 hover:scale-105 active:scale-95 border border-primary/20"
                                            )}
                                        >
                                            {loading ? <Loader2 className="animate-spin" size={10} /> : (
                                                <>
                                                    <CloudUpload size={10} />
                                                    <span>Publicar</span>
                                                </>
                                            )}
                                        </button>
                                    </div>
                                </div>

                                {/* LISTA DE TÉCNICOS */}
                                <div className="flex-1 bg-white/70 backdrop-blur-3xl p-5 rounded-[2.5rem] border border-white/50 shadow-[0_25px_50px_rgba(0,0,0,0.05)] overflow-hidden pointer-events-auto animate-in slide-in-from-right-8 duration-700 delay-200">
                                    <div className="flex flex-col gap-5 h-full">
                                        <div className="custom-scrollbar pr-2 flex-1 overflow-y-auto min-h-0 pl-1">
                                            {technicians.map((tech) => (
                                                <div key={tech.id} className="mb-6">
                                                    <div className="flex items-center gap-2 px-2 py-1.5 hover:bg-slate-50/80 transition-colors group cursor-default">
                                                        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-primary/10 to-primary/5 flex items-center justify-center border border-primary/10">
                                                            <User size={12} className="text-primary" />
                                                        </div>
                                                        <div className="flex-1 min-w-0">
                                                            <h3 className="text-[11px] font-bold text-slate-800 tracking-tight truncate border-b border-transparent group-hover:border-primary/20 transition-all">{tech.full_name}</h3>
                                                        </div>
                                                        <div className="flex items-center gap-1.5 bg-slate-100 px-1.5 py-0.5 rounded-lg border border-slate-200/50">
                                                            <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse" />
                                                            <span className="text-[9px] font-black text-slate-600">{(assignedRoutes[tech.id] || []).length}</span>
                                                        </div>
                                                    </div>

                                                    <Droppable droppableId={String(tech.id)}>
                                                        {(provided, snapshot) => (
                                                            <div
                                                                {...provided.droppableProps}
                                                                ref={provided.innerRef}
                                                                className={clsx(
                                                                    "mt-1.5 min-h-[44px] transition-all duration-300 rounded-xl flex flex-col gap-1.5",
                                                                    snapshot.isDraggingOver
                                                                        ? "bg-primary/10 border-2 border-primary/40 shadow-[inset_0_2px_4px_rgba(var(--primary-rgb),0.1)] p-2"
                                                                        : "bg-slate-100/40 border border-slate-200/60 px-1 pb-2"
                                                                )}
                                                            >
                                                                {(assignedRoutes[tech.id] || []).map((ticket, index) => (
                                                                    <Draggable key={ticket.id} draggableId={String(ticket.id)} index={index}>
                                                                        {(provided, snapshot) => {
                                                                            const content = (
                                                                                <div
                                                                                    ref={provided.innerRef}
                                                                                    {...provided.draggableProps}
                                                                                    {...provided.dragHandleProps}
                                                                                    className={clsx(
                                                                                        "group relative p-2 rounded-lg transition-all cursor-grab active:cursor-grabbing border",
                                                                                        snapshot.isDragging
                                                                                            ? "bg-white shadow-xl border-primary ring-2 ring-primary/20 scale-105 rotate-1 z-[9999] opacity-100"
                                                                                            : "bg-white border-slate-100 hover:border-primary/20 shadow-sm"
                                                                                    )}
                                                                                >
                                                                                    <div className="flex items-center gap-2">
                                                                                        <div className="bg-slate-50 text-slate-400 text-[8px] font-black w-5 h-5 rounded flex items-center justify-center border border-slate-100">
                                                                                            {index + 1}
                                                                                        </div>
                                                                                        <div className="min-w-0 flex-1">
                                                                                            <h4 className="text-[10px] font-bold text-slate-700 tracking-tight group-hover:text-primary transition-colors truncate leading-tight flex items-center gap-1.5">
                                                                                                {ticket.nombre_cliente}
                                                                                                {ticket.isPublished && (
                                                                                                    <span className="shrink-0 px-1 py-0.5 bg-emerald-500 text-white text-[6px] font-black uppercase rounded shadow-sm">Hoy</span>
                                                                                                )}
                                                                                            </h4>
                                                                                            <div className="flex items-center gap-1">
                                                                                                <span className="text-[8px] font-black text-primary uppercase">#{ticket.id}</span>
                                                                                                {ticket.id_estado === 5 && (
                                                                                                    <span className="px-1 py-0.5 bg-amber-500 text-white text-[6px] font-black uppercase rounded shadow-sm">Escalado</span>
                                                                                                )}
                                                                                                <span className="text-[8px] font-medium text-slate-300">•</span>
                                                                                                <span className="text-[8px] font-bold text-slate-400 uppercase truncate">{ticket.barrio}</span>
                                                                                            </div>
                                                                                        </div>
                                                                                    </div>
                                                                                </div>
                                                                            );

                                                                            if (snapshot.isDragging) {
                                                                                return <Portal>{content}</Portal>;
                                                                            }
                                                                            return content;
                                                                        }}
                                                                    </Draggable>
                                                                ))}
                                                                {provided.placeholder}
                                                                {(assignedRoutes[tech.id] || []).length === 0 && !snapshot.isDraggingOver && (
                                                                    <div className="py-5 text-center border-2 border-dashed border-slate-200/80 rounded-xl group-hover:border-primary/30 transition-all bg-white/20">
                                                                        <div className="flex flex-col items-center gap-1.5 opacity-60 group-hover:opacity-100 transition-opacity">
                                                                            <CloudDownload size={12} className="text-slate-400 group-hover:text-primary transition-colors" />
                                                                            <span className="text-[8px] font-black text-slate-400 group-hover:text-primary uppercase tracking-[0.15em]">Soltar</span>
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </div>
                                                        )}
                                                    </Droppable>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            </DragDropContext>

            {/* PANEL DE DETALLE (OVERLAY ABSOLUTO) */}
            {selectedTicket && (
                <div className="fixed inset-0 z-[2000] flex items-center justify-end p-6 pointer-events-none">
                    <div
                        className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm pointer-events-auto"
                        onClick={() => setSelectedTicket(null)}
                    />
                    <div className="relative w-full max-w-xl h-full bg-[#f8fafc]/95 backdrop-blur-2xl rounded-[3rem] shadow-[0_0_40px_rgba(0,0,0,0.1)] border-l border-white/60 overflow-hidden flex flex-col animate-in slide-in-from-right-12 duration-500 pointer-events-auto">
                        {/* Header del Detalle */}
                        <div className="p-8 pb-4 flex justify-between items-start relative z-10">
                            <div className="space-y-1.5 w-full pr-8">
                                <div className="flex items-center gap-2 mb-3">
                                    <div className={clsx(
                                        "px-3.5 py-1.5 rounded-full text-[10px] font-black uppercase tracking-widest text-white shadow-md",
                                        selectedTicket.id_prioridad >= 4 ? "bg-gradient-to-r from-red-500 to-rose-600 shadow-red-500/30" :
                                            selectedTicket.id_prioridad === 3 ? "bg-gradient-to-r from-orange-500 to-amber-500 shadow-orange-500/30" : "bg-gradient-to-r from-blue-600 to-indigo-600 shadow-blue-500/30"
                                    )}>
                                        Ticket #{selectedTicket.id}
                                    </div>
                                    {selectedTicket.recurrence > 1 && (
                                        <div className="px-3.5 py-1.5 bg-rose-50 border border-rose-100/50 text-rose-600 rounded-full text-[10px] font-black uppercase tracking-widest flex items-center gap-1.5 shadow-sm">
                                            <AlertCircle size={12} strokeWidth={2.5} /> RECURRENTE
                                        </div>
                                    )}
                                </div>
                                <h2 className="text-3xl font-black uppercase tracking-tighter text-slate-800 leading-none drop-shadow-sm">
                                    {selectedTicket.nombre_cliente}
                                </h2>
                                <div className="flex flex-col gap-1 mt-2">
                                    {selectedTicket.cedula && (
                                        <p className="text-[11px] font-black text-slate-400 uppercase tracking-widest">C.C. <span className="text-slate-500">{selectedTicket.cedula}</span></p>
                                    )}
                                    <p className="text-xs font-bold text-slate-500 uppercase tracking-widest">{selectedTicket.asunto}</p>
                                </div>
                            </div>
                            <button
                                onClick={() => setSelectedTicket(null)}
                                className="absolute top-8 right-8 p-2.5 bg-white border border-slate-100 shadow-sm hover:shadow-md hover:bg-slate-50 rounded-full transition-all text-slate-400 hover:text-slate-600"
                            >
                                <X size={20} strokeWidth={2.5} />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto custom-scrollbar p-8 pt-4">
                            <div className="space-y-8">
                                {/* Información Principal */}
                                <div className="grid grid-cols-2 gap-5 z-10 relative">
                                    <div className="bg-white p-5 rounded-[2rem] border border-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] relative overflow-hidden group">
                                        <div className="absolute -right-4 -top-4 w-16 h-16 bg-blue-50 rounded-full opacity-50 group-hover:scale-150 transition-transform duration-500" />
                                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2 relative z-10">
                                            <MapPin size={14} className="text-blue-500" /> Sector / Barrio
                                        </p>
                                        <p className="text-sm font-black text-slate-800 uppercase leading-snug relative z-10">{selectedTicket.barrio || 'No especificado'}</p>
                                        <p className="text-[11px] font-bold text-slate-400 mt-1 truncate relative z-10">{selectedTicket.direccion}</p>
                                    </div>
                                    <div className="bg-white p-5 rounded-[2rem] border border-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.04)] relative overflow-hidden group">
                                        <div className="absolute -right-4 -top-4 w-16 h-16 bg-emerald-50 rounded-full opacity-50 group-hover:scale-150 transition-transform duration-500" />
                                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2 relative z-10">
                                            <Phone size={14} className="text-emerald-500" /> Contacto Directo
                                        </p>
                                        <p className="text-base font-black text-slate-800 leading-none relative z-10">{selectedTicket.celular || selectedTicket.telefono || 'Sin teléfono'}</p>
                                        <div className="flex gap-2 mt-2 relative z-10">
                                            <a
                                                href={`tel:${selectedTicket.celular}`}
                                                className="text-[10px] font-black text-emerald-600 bg-emerald-50 px-3 py-1 rounded-full uppercase hover:bg-emerald-100 transition-colors"
                                            >
                                                Llamar ahora
                                            </a>
                                        </div>
                                    </div>
                                </div>

                                {/* Widget de Señal SmartOLT */}
                                {(selectedTicket.cedula || selectedTicket.id_servicio) && (
                                    <div className="mt-6 mb-2 animate-in slide-in-from-bottom-4 duration-500 delay-150 fill-mode-both">
                                        <SmartOltWidget 
                                            cedula={selectedTicket.cedula} 
                                            idServicio={selectedTicket.id_servicio ? Number(selectedTicket.id_servicio) : null} 
                                            nombre={selectedTicket.nombre_cliente}
                                        />
                                    </div>
                                )}

                                <div className="bg-white p-6 rounded-[2rem] border border-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.03)] space-y-6 relative overflow-hidden">
                                    <div className="absolute top-0 right-0 w-32 h-32 bg-slate-50 rounded-full blur-3xl opacity-50 pointer-events-none" />
                                    
                                    <div className="flex items-center gap-3 group relative z-10">
                                        <div className="w-10 h-10 rounded-2xl bg-orange-50 border border-orange-100 flex items-center justify-center text-orange-500 transition-transform group-hover:scale-110 shadow-sm">
                                            <MapPin size={18} strokeWidth={2.5} />
                                        </div>
                                        <div className="flex-1">
                                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-0.5">Dirección de Servicio</span>
                                            <p className="text-sm font-bold text-slate-800">{selectedTicket.direccion}</p>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-5 relative z-10 pt-2 border-t border-slate-50">
                                        <div className="flex items-start gap-3 group">
                                            <div className="w-9 h-9 rounded-[1rem] bg-blue-50 border border-blue-100 flex items-center justify-center text-blue-500 transition-transform group-hover:scale-110 shadow-sm mt-0.5">
                                                <User size={16} strokeWidth={2.5} />
                                            </div>
                                            <div>
                                                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-0.5">ID / Usuario</span>
                                                <div className="text-xs font-bold text-slate-800 bg-slate-50 px-2.5 py-1 rounded-lg border border-slate-100 inline-block">
                                                    {detailLoading ? '...' : (selectedTicket.id_servicio || 'N/A') + ' / ' + (selectedTicket.usuario_wisphub?.split(' ')[0] || 'N/A')}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex items-start gap-3 group">
                                            <div className="w-9 h-9 rounded-[1rem] bg-emerald-50 border border-emerald-100 flex items-center justify-center text-emerald-500 transition-transform group-hover:scale-110 shadow-sm mt-0.5">
                                                <AlertCircle size={16} strokeWidth={2.5} />
                                            </div>
                                            <div>
                                                <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-0.5">Estado Serv.</span>
                                                {detailLoading ? (
                                                    <span className="animate-pulse bg-slate-100 h-6 w-16 block rounded-lg" />
                                                ) : (
                                                    <span className={clsx(
                                                        "text-[10px] font-black uppercase px-2.5 py-1 rounded-lg border inline-block",
                                                        selectedTicket.estado_servicio?.toLowerCase() === 'activo' ? "bg-emerald-50 border-emerald-200 text-emerald-600" : "bg-rose-50 border-rose-200 text-rose-600"
                                                    )}>
                                                        {selectedTicket.estado_servicio}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 relative z-10 pt-4 border-t border-slate-50">
                                        <div className="flex flex-col gap-1.5">
                                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Creado Por</span>
                                            <div className="flex items-center gap-2 bg-slate-50 p-1.5 rounded-xl border border-slate-100">
                                                <div className="w-6 h-6 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-[10px] font-black text-slate-600 shadow-sm">
                                                    {detailLoading ? '...' : selectedTicket.creado_por?.substring(0, 1)}
                                                </div>
                                                <span className="text-[11px] font-bold text-slate-700 truncate pr-2 uppercase">
                                                    {detailLoading ? 'Cargando...' : selectedTicket.creado_por}
                                                </span>
                                            </div>
                                        </div>
                                        <div className="flex flex-col gap-1.5">
                                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest">Técnico Actual</span>
                                            <div className="flex items-center gap-2 bg-slate-50 p-1.5 rounded-xl border border-slate-100">
                                                <div className="w-6 h-6 rounded-lg bg-white border border-slate-200 flex items-center justify-center text-[10px] font-black text-blue-600 shadow-sm">
                                                    {detailLoading ? '...' : (selectedTicket.tecnico_actual || 'S')?.substring(0, 1)}
                                                </div>
                                                <span className="text-[11px] font-bold text-slate-700 truncate pr-2 uppercase">
                                                    {detailLoading ? 'Cargando...' : selectedTicket.tecnico_actual}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                {/* Description */}
                                <div className="space-y-4">
                                    <div className="flex items-center gap-2 pl-2">
                                        <FileText size={16} strokeWidth={2.5} className="text-slate-400" />
                                        <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest relative top-0.5">Descripción del Reporte</span>
                                    </div>
                                    <div className="bg-white p-6 rounded-[2rem] border border-white/60 shadow-[0_8px_30px_rgb(0,0,0,0.03)] max-h-[400px] overflow-y-auto custom-scrollbar">
                                        <div
                                            className="text-[13px] font-medium text-slate-700 leading-relaxed html-content prose prose-slate prose-sm max-w-none"
                                            dangerouslySetInnerHTML={{ __html: selectedTicket.descripcion || 'Sin descripción detallada.' }}
                                        />
                                    </div>
                                </div>

                                {/* Metadata / Tags */}
                                <div className="flex flex-wrap gap-2 pt-4">
                                    <div className="px-3 py-1.5 bg-slate-100 rounded-xl text-[9px] font-black text-slate-500 uppercase">
                                        SLA: {selectedTicket.horas_abierto} Horas
                                    </div>
                                    <div className="px-3 py-1.5 bg-slate-100 rounded-xl text-[9px] font-black text-slate-500 uppercase">
                                        Smart Score: {selectedTicket.score} pts
                                    </div>
                                    {selectedTicket.recurrence > 1 && (
                                        <div className="px-3 py-1.5 bg-red-100 rounded-xl text-[9px] font-black text-red-600 uppercase flex items-center gap-1">
                                            <AlertCircle size={10} /> {selectedTicket.recurrence}ª RECURRENCIA
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Footer */}
                            <div className="p-6 bg-white/80 backdrop-blur-xl border-t border-slate-200/50 flex gap-4 mt-8 sticky bottom-0 z-20">
                                <button
                                    onClick={() => setSelectedTicket(null)}
                                    className="flex-1 py-4 bg-gradient-to-r from-slate-900 to-slate-800 text-white rounded-2xl text-[11px] font-black uppercase tracking-widest hover:from-slate-800 hover:to-slate-700 transition-all shadow-[0_8px_25px_rgba(15,23,42,0.25)] flex items-center justify-center gap-2"
                                >
                                    Cerrar Detalles
                                </button>
                                <button
                                    onClick={() => window.open(`https://wisphub.net/tickets/${selectedTicket.id}/`, '_blank')}
                                    className="px-6 bg-white border border-slate-200 shadow-sm text-slate-600 rounded-2xl hover:bg-slate-50 hover:text-blue-600 hover:border-blue-200 transition-all flex items-center justify-center"
                                    title="Ver en WispHub"
                                >
                                    <ExternalLink size={20} strokeWidth={2.5} />
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}

            <style>{`
                .html-content img {
                    max-width: 100% !important;
                    height: auto !important;
                    border-radius: 1.5rem;
                    margin: 1.5rem 0;
                    box-shadow: 0 10px 15px -3px rgb(0 0 0 / 0.1);
                    border: 4px solid white;
                }
                .html-content p {
                    margin-bottom: 0.75rem;
                }
                .html-content {
                    word-break: break-word;
                }
            `}</style>
        </div>
    );
}

