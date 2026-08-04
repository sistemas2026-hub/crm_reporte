import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
    ArrowLeft, ChevronDown, Camera, Trash2, AlertTriangle, Loader2, Plus, Lock,
    Printer, Send, ShieldCheck, ShieldX, ShieldAlert, Clock, X, Search, Check, KeyRound,
} from 'lucide-react';
import clsx from 'clsx';
import {
    MttoService,
    type MttoOrden, type MttoVehiculo, type MttoOrdenHallazgo, type MttoOrdenFoto,
    type MttoOrdenReparacion, type ChecklistSeccionConItems, type CatalogoSistemaConArreglos,
    type MttoOrdenEvento, type MttoChecklistItem, type MttoUsuarioRol,
    type MttoReparacionFoto,
} from '../lib/mttoService';
import type { MttoEstadoHallazgo, MttoTipoServicio, MttoDecision, MttoPrioridad } from '../types/database';
import { ESTADO_LABEL, ESTADO_COLOR, TIPO_SERVICIO_LABEL, EVENTO_LABEL, money, toast } from '../lib/mttoLabels';

type OrdenConVehiculo = MttoOrden & { vehiculo?: MttoVehiculo };
type HallazgoConFotos = MttoOrdenHallazgo & { fotos?: MttoOrdenFoto[] };
type ReparacionConFotos = MttoOrdenReparacion & { fotos?: MttoReparacionFoto[] };

// ============================================================
// Wrapper de bloqueo visual: opacidad + no-interactivo cuando el
// bloque no corresponde al rol o al estado actual del usuario.
// ============================================================
function Bloqueado({ activo, motivo, children }: { activo: boolean; motivo?: string; children: React.ReactNode }) {
    if (activo) return <>{children}</>;
    return (
        <div className="relative">
            <div className="opacity-50 pointer-events-none select-none">{children}</div>
            {motivo && (
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground bg-muted/60 rounded-lg px-3 py-2">
                    <Lock className="w-3.5 h-3.5 shrink-0" /> {motivo}
                </div>
            )}
        </div>
    );
}

const isVencimientoProximo = (fecha: string | null, dias = 30) => {
    if (!fecha) return false;
    const limite = new Date();
    limite.setDate(limite.getDate() + dias);
    return new Date(fecha) <= limite;
};

export function MaintenanceOrder() {
    const { id } = useParams<{ id: string }>();
    const navigate = useNavigate();

    const [loading, setLoading] = useState(true);
    const [orden, setOrden] = useState<OrdenConVehiculo | null>(null);
    const [contexto, setContexto] = useState<{ userId: string | null; rol: string | null; esAdmin: boolean }>({ userId: null, rol: null, esAdmin: false });
    const [checklist, setChecklist] = useState<ChecklistSeccionConItems[]>([]);
    const [hallazgos, setHallazgos] = useState<HallazgoConFotos[]>([]);
    const [reparaciones, setReparaciones] = useState<ReparacionConFotos[]>([]);
    const [catalogo, setCatalogo] = useState<CatalogoSistemaConArreglos[]>([]);
    const [eventos, setEventos] = useState<(MttoOrdenEvento & { usuario?: { full_name: string | null } })[]>([]);
    const [tab, setTab] = useState<'vehiculo' | 'inspeccion' | 'reparaciones' | 'revision'>('vehiculo');

    const cargarTodo = useCallback(async () => {
        if (!id) return;
        setLoading(true);
        try {
            const [ctx, ordenData] = await Promise.all([MttoService.getMiContexto(), MttoService.getOrden(id)]);
            setContexto(ctx);
            setOrden(ordenData);
            if (!ordenData) return;

            const [checklistData, hallazgosData, reparacionesData, catalogoData, eventosData] = await Promise.all([
                MttoService.getChecklist(ordenData.vehiculo!.tipo),
                MttoService.listHallazgos(id),
                MttoService.listReparaciones(id),
                MttoService.getCatalogo(),
                MttoService.listEventos(id),
            ]);
            setChecklist(checklistData);
            setHallazgos(hallazgosData);
            setReparaciones(reparacionesData);
            setCatalogo(catalogoData);
            setEventos(eventosData);
        } catch (e: any) {
            console.error('[Mantenimiento] Error cargando orden:', e);
            toast('Error al cargar la orden', 'error', e.message);
        } finally {
            setLoading(false);
        }
    }, [id]);

    useEffect(() => { cargarTodo(); }, [cargarTodo]);

    if (loading) {
        return <div className="flex items-center justify-center py-24 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mr-2" /> Cargando orden...</div>;
    }
    if (!orden || !orden.vehiculo) {
        return (
            <div className="p-6 text-center text-muted-foreground">
                Orden no encontrada o sin acceso.
                <div><Link to="/mantenimiento" className="text-primary underline">Volver a la bandeja</Link></div>
            </div>
        );
    }

    const soyDueno = orden.creado_por === contexto.userId;
    const esMecanico = contexto.rol === 'mecanico' || contexto.esAdmin;
    const enBorrador = orden.estado === 'borrador';
    const puedoEditarContenido = enBorrador && soyDueno && esMecanico;
    const puedoRevisar = orden.estado === 'en_revision' && (contexto.rol === 'encargado' || contexto.esAdmin);
    const puedoAprobar = orden.estado === 'en_aprobacion' && (contexto.rol === 'aprobador' || contexto.esAdmin);
    const puedoDevolver = (orden.estado === 'en_revision' || orden.estado === 'en_aprobacion') &&
        (contexto.rol === 'encargado' || contexto.rol === 'aprobador' || contexto.esAdmin);
    const puedoIniciarEjecucion = orden.estado === 'aprobada' && soyDueno && esMecanico;
    const puedoCerrar = orden.estado === 'en_ejecucion' && soyDueno && esMecanico;

    const critico = hallazgos.some((h) => h.estado === 'M' && checklist.some((s) => s.items.some((i) => i.id === h.item_id && i.critico)));

    const refrescarHallazgos = async () => setHallazgos(await MttoService.listHallazgos(id!));
    const refrescarReparaciones = async () => setReparaciones(await MttoService.listReparaciones(id!));
    const refrescarOrdenYEventos = async () => {
        const [o, ev] = await Promise.all([MttoService.getOrden(id!), MttoService.listEventos(id!)]);
        setOrden(o);
        setEventos(ev);
    };

    return (
        <div className="pb-24 max-w-4xl mx-auto">
            {/* Header */}
            <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border p-3 flex items-center gap-2">
                <button onClick={() => navigate('/mantenimiento')} className="p-2 hover:bg-muted rounded-full min-h-[44px] min-w-[44px]">
                    <ArrowLeft className="w-5 h-5" />
                </button>
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                        <h1 className="font-bold text-base">{orden.numero || 'Sin número'}</h1>
                        <span className={clsx('text-[11px] font-semibold px-2 py-0.5 rounded-full border', ESTADO_COLOR[orden.estado])}>
                            {ESTADO_LABEL[orden.estado]}
                        </span>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">{orden.vehiculo.codigo} · {TIPO_SERVICIO_LABEL[orden.tipo_servicio]}</p>
                </div>
                <a href={`/mantenimiento/${id}/imprimir`} target="_blank" rel="noreferrer" className="p-2 hover:bg-muted rounded-full min-h-[44px] min-w-[44px]" title="Vista imprimible">
                    <Printer className="w-5 h-5" />
                </a>
            </div>

            {critico && (
                <div className="m-3 bg-red-500/10 border border-red-500/40 text-red-700 dark:text-red-400 rounded-xl p-3 flex items-center gap-2 font-semibold text-sm">
                    <AlertTriangle className="w-5 h-5 shrink-0" />
                    Hay ítems CRÍTICOS en Malo — este vehículo no debe salir a ruta.
                </div>
            )}

            {/* Tabs */}
            <div className="flex gap-1 px-3 pt-3 overflow-x-auto">
                {([
                    ['vehiculo', 'Vehículo'],
                    ['inspeccion', 'Inspección'],
                    ['reparaciones', 'Reparaciones'],
                    ['revision', 'Revisión y aprobación'],
                ] as const).map(([k, label]) => (
                    <button
                        key={k}
                        onClick={() => setTab(k)}
                        className={clsx(
                            'px-3 py-2.5 rounded-lg text-sm font-semibold whitespace-nowrap min-h-[44px]',
                            tab === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                        )}
                    >
                        {label}
                    </button>
                ))}
            </div>

            <div className="p-3">
                {tab === 'vehiculo' && (
                    <TabVehiculo orden={orden} puedoEditar={puedoEditarContenido} onGuardado={cargarTodo} />
                )}
                {tab === 'inspeccion' && (
                    <TabInspeccion
                        ordenId={id!}
                        checklist={checklist}
                        hallazgos={hallazgos}
                        puedoEditar={puedoEditarContenido}
                        motivoBloqueo={!enBorrador ? 'La inspección ya no se puede editar fuera de borrador.' : !soyDueno ? 'Solo el mecánico que creó la orden puede editarla.' : undefined}
                        onCambio={refrescarHallazgos}
                    />
                )}
                {tab === 'reparaciones' && (
                    <TabReparaciones
                        ordenId={id!}
                        orden={orden}
                        reparaciones={reparaciones}
                        catalogo={catalogo}
                        puedoEditar={puedoEditarContenido}
                        motivoBloqueo={!enBorrador ? 'La cotización ya no se puede editar fuera de borrador.' : !soyDueno ? 'Solo el mecánico que creó la orden puede editarla.' : undefined}
                        onCambio={refrescarReparaciones}
                        onOrdenActualizada={setOrden}
                    />
                )}
                {tab === 'revision' && (
                    <TabRevision
                        orden={orden}
                        reparaciones={reparaciones}
                        eventos={eventos}
                        puedoRevisar={puedoRevisar}
                        puedoAprobar={puedoAprobar}
                        puedoDevolver={puedoDevolver}
                        onCambio={refrescarOrdenYEventos}
                    />
                )}
            </div>

            {/* Barra de acción inferior — solo transiciones simples de un clic */}
            {(puedoEditarContenido || puedoIniciarEjecucion || puedoCerrar) && (
                <BarraAccionInferior
                    orden={orden}
                    puedoEnviar={puedoEditarContenido}
                    puedoIniciarEjecucion={puedoIniciarEjecucion}
                    puedoCerrar={puedoCerrar}
                    onCambio={async () => { await cargarTodo(); }}
                />
            )}
        </div>
    );
}

// ============================================================
// TAB 1 — Vehículo
// ============================================================
function TabVehiculo({ orden, puedoEditar, onGuardado }: {
    orden: OrdenConVehiculo; puedoEditar: boolean; onGuardado: () => void;
}) {
    const v = orden.vehiculo!;
    const [kilometraje, setKilometraje] = useState(orden.kilometraje?.toString() || '');
    const [tipoServicio, setTipoServicio] = useState<MttoTipoServicio>(orden.tipo_servicio);
    const [taller, setTaller] = useState(orden.taller || '');
    const [motivo, setMotivo] = useState(orden.motivo || '');
    const [guardando, setGuardando] = useState(false);

    const guardar = async () => {
        setGuardando(true);
        try {
            await MttoService.updateOrden(orden.id, {
                kilometraje: kilometraje ? Number(kilometraje) : null,
                tipo_servicio: tipoServicio,
                taller: taller || null,
                motivo: motivo || null,
            });
            toast('Datos guardados', 'success');
            onGuardado();
        } catch (e: any) {
            toast('Error al guardar', 'error', e.message);
        } finally {
            setGuardando(false);
        }
    };

    return (
        <div className="space-y-4">
            <div className="bg-card border border-border rounded-xl p-4">
                <h3 className="font-bold mb-3">{v.codigo} — {v.tipo === 'motocarro' ? 'Motocarro' : 'Moto con tráiler'}</h3>
                <div className="grid grid-cols-2 gap-3 text-sm">
                    <Ficha label="Placa" value={v.placa} />
                    <Ficha label="Marca / línea" value={[v.marca, v.linea].filter(Boolean).join(' ') || null} />
                    <Ficha label="No. motor" value={v.num_motor} />
                    <Ficha label="No. chasis" value={v.num_chasis} />
                    <Ficha label="SOAT vence" value={v.soat_vence ? new Date(v.soat_vence).toLocaleDateString('es-CO') : null} alerta={isVencimientoProximo(v.soat_vence)} />
                    <Ficha label="Tecnomecánica vence" value={v.tecno_vence ? new Date(v.tecno_vence).toLocaleDateString('es-CO') : null} alerta={isVencimientoProximo(v.tecno_vence)} />
                </div>
            </div>

            <Bloqueado activo={puedoEditar} motivo={!puedoEditar ? 'Solo editable en borrador por el mecánico creador.' : undefined}>
                <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                    <div>
                        <label className="text-sm font-medium block mb-1">Kilometraje</label>
                        <input type="number" value={kilometraje} onChange={(e) => setKilometraje(e.target.value)}
                            className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                    </div>
                    <div>
                        <label className="text-sm font-medium block mb-1">Tipo de servicio</label>
                        <select value={tipoServicio} onChange={(e) => setTipoServicio(e.target.value as MttoTipoServicio)}
                            className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]">
                            {Object.entries(TIPO_SERVICIO_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="text-sm font-medium block mb-1">Taller</label>
                        <input value={taller} onChange={(e) => setTaller(e.target.value)}
                            className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                    </div>
                    <div>
                        <label className="text-sm font-medium block mb-1">Motivo del ingreso</label>
                        <textarea value={motivo} onChange={(e) => setMotivo(e.target.value)}
                            className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[80px]" />
                    </div>
                    <button onClick={guardar} disabled={guardando}
                        className="bg-primary text-primary-foreground px-4 py-2.5 rounded-lg font-semibold min-h-[44px] disabled:opacity-60 flex items-center gap-2">
                        {guardando && <Loader2 className="w-4 h-4 animate-spin" />} Guardar
                    </button>
                </div>
            </Bloqueado>
        </div>
    );
}

function Ficha({ label, value, alerta }: { label: string; value: string | null; alerta?: boolean }) {
    return (
        <div>
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className={clsx('font-medium', !value && 'text-muted-foreground italic', alerta && 'text-red-600 dark:text-red-400 font-bold')}>
                {value || 'Sin dato'}
            </div>
        </div>
    );
}

// ============================================================
// TAB 2 — Inspección (llenado por excepción)
// ============================================================
function TabInspeccion({ ordenId, checklist, hallazgos, puedoEditar, motivoBloqueo, onCambio }: {
    ordenId: string;
    checklist: ChecklistSeccionConItems[];
    hallazgos: HallazgoConFotos[];
    puedoEditar: boolean;
    motivoBloqueo?: string;
    onCambio: () => void;
}) {
    const hallazgoPorItem = useMemo(() => new Map(hallazgos.map((h) => [h.item_id, h])), [hallazgos]);

    const totalItems = checklist.reduce((acc, s) => acc + s.items.length, 0);
    const contadores = { R: 0, M: 0, NA: 0 };
    for (const h of hallazgos) contadores[h.estado as 'R' | 'M' | 'NA']++;
    const bueno = totalItems - hallazgos.length;

    return (
        <div className="space-y-3">
            <div className="grid grid-cols-4 gap-2 text-center">
                <Contador label="Bueno" valor={bueno} color="text-emerald-600 dark:text-emerald-400" />
                <Contador label="Regular" valor={contadores.R} color="text-amber-600 dark:text-amber-400" />
                <Contador label="Malo" valor={contadores.M} color="text-red-600 dark:text-red-400" />
                <Contador label="N/A" valor={contadores.NA} color="text-muted-foreground" />
            </div>

            <Bloqueado activo={puedoEditar} motivo={motivoBloqueo}>
                <div className="space-y-2">
                    {checklist.map((seccion) => (
                        <ChecklistSectionCard
                            key={seccion.id}
                            seccion={seccion}
                            hallazgoPorItem={hallazgoPorItem}
                            ordenId={ordenId}
                            puedoEditar={puedoEditar}
                            onCambio={onCambio}
                        />
                    ))}
                </div>
            </Bloqueado>
        </div>
    );
}

function Contador({ label, valor, color }: { label: string; valor: number; color: string }) {
    return (
        <div className="bg-card border border-border rounded-lg p-2">
            <div className={clsx('text-lg font-bold', color)}>{valor}</div>
            <div className="text-[10px] text-muted-foreground uppercase">{label}</div>
        </div>
    );
}

function ChecklistSectionCard({ seccion, hallazgoPorItem, ordenId, puedoEditar, onCambio }: {
    seccion: ChecklistSeccionConItems;
    hallazgoPorItem: Map<string, HallazgoConFotos>;
    ordenId: string;
    puedoEditar: boolean;
    onCambio: () => void;
}) {
    const [abierto, setAbierto] = useState(false);
    const rCount = seccion.items.filter((i) => hallazgoPorItem.get(i.id)?.estado === 'R').length;
    const mCount = seccion.items.filter((i) => hallazgoPorItem.get(i.id)?.estado === 'M').length;
    const limpio = rCount === 0 && mCount === 0;

    return (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
            <button onClick={() => setAbierto((v) => !v)} className="w-full flex items-center justify-between p-3 min-h-[44px]">
                <div className="flex items-center gap-2 text-left">
                    <span className={clsx('w-2.5 h-2.5 rounded-full shrink-0', limpio ? 'bg-emerald-500' : mCount > 0 ? 'bg-red-500' : 'bg-amber-500')} />
                    <span className="font-semibold text-sm">{seccion.nombre}</span>
                </div>
                <div className="flex items-center gap-2">
                    {!limpio && (
                        <span className="text-[11px] font-semibold text-muted-foreground">
                            {rCount > 0 && `${rCount} R `}{mCount > 0 && `${mCount} M`}
                        </span>
                    )}
                    <ChevronDown className={clsx('w-4 h-4 transition-transform', abierto && 'rotate-180')} />
                </div>
            </button>
            {abierto && (
                <div className="border-t border-border divide-y divide-border">
                    {seccion.items.map((item) => (
                        <ChecklistItemRow
                            key={item.id}
                            item={item}
                            hallazgo={hallazgoPorItem.get(item.id)}
                            ordenId={ordenId}
                            puedoEditar={puedoEditar}
                            onCambio={onCambio}
                        />
                    ))}
                </div>
            )}
        </div>
    );
}

const ESTADOS_ITEM: { key: 'B' | MttoEstadoHallazgo; label: string; activo: string }[] = [
    { key: 'B', label: 'B', activo: 'bg-emerald-500 text-white border-emerald-500' },
    { key: 'R', label: 'R', activo: 'bg-amber-500 text-white border-amber-500' },
    { key: 'M', label: 'M', activo: 'bg-red-500 text-white border-red-500' },
    { key: 'NA', label: 'N/A', activo: 'bg-slate-500 text-white border-slate-500' },
];

function ChecklistItemRow({ item, hallazgo, ordenId, puedoEditar, onCambio }: {
    item: MttoChecklistItem;
    hallazgo?: HallazgoConFotos;
    ordenId: string;
    puedoEditar: boolean;
    onCambio: () => void;
}) {
    const [observacion, setObservacion] = useState(hallazgo?.observacion || '');
    const [subiendo, setSubiendo] = useState(false);
    const [fotoUrls, setFotoUrls] = useState<Record<string, string>>({});
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { setObservacion(hallazgo?.observacion || ''); }, [hallazgo?.observacion]);

    const estadoActual: 'B' | MttoEstadoHallazgo = hallazgo?.estado || 'B';
    const necesitaObs = estadoActual === 'R' || estadoActual === 'M';

    const cambiarEstado = async (nuevo: 'B' | MttoEstadoHallazgo) => {
        if (!puedoEditar) return;
        try {
            if (nuevo === 'B') {
                await MttoService.marcarBueno(ordenId, item.id);
            } else if (nuevo === 'NA') {
                await MttoService.setHallazgo(ordenId, item.id, 'NA', '');
            } else {
                // R o M sin observación aún: se guarda con placeholder editable; el submit exige que no quede vacío.
                await MttoService.setHallazgo(ordenId, item.id, nuevo, observacion || '');
            }
            onCambio();
        } catch (e: any) {
            toast('No se pudo actualizar el ítem', 'error', e.message);
        }
    };

    const guardarObservacion = async () => {
        if (!hallazgo || estadoActual === 'B') return;
        try {
            await MttoService.setHallazgo(ordenId, item.id, estadoActual as MttoEstadoHallazgo, observacion);
            onCambio();
        } catch (e: any) {
            toast('No se pudo guardar la observación', 'error', e.message);
        }
    };

    const subirFoto = async (file: File) => {
        if (!hallazgo) return;
        setSubiendo(true);
        try {
            await MttoService.subirFoto(ordenId, hallazgo.id, file);
            onCambio();
        } catch (e: any) {
            toast('Error al subir la foto', 'error', e.message);
        } finally {
            setSubiendo(false);
        }
    };

    const cargarUrlFoto = async (foto: MttoOrdenFoto) => {
        if (fotoUrls[foto.id]) return;
        try {
            const url = await MttoService.getFotoUrl(foto.path);
            setFotoUrls((prev) => ({ ...prev, [foto.id]: url }));
        } catch { /* ignora, la miniatura simplemente no carga */ }
    };

    return (
        <div className="p-3">
            <div className="flex items-center justify-between gap-2">
                <div className="text-sm flex-1">
                    {item.nombre}
                    {item.critico && <span className="ml-1.5 text-[10px] font-bold text-red-600 dark:text-red-400 align-middle">CRÍTICO</span>}
                </div>
                <div className="flex gap-1 shrink-0">
                    {ESTADOS_ITEM.map((e) => (
                        <button
                            key={e.key}
                            disabled={!puedoEditar}
                            onClick={() => cambiarEstado(e.key)}
                            className={clsx(
                                'w-11 h-11 rounded-lg border text-xs font-bold flex items-center justify-center transition-colors',
                                estadoActual === e.key ? e.activo : 'bg-background border-border text-muted-foreground'
                            )}
                        >
                            {e.label}
                        </button>
                    ))}
                </div>
            </div>

            {necesitaObs && hallazgo && (
                <div className="mt-2 space-y-2">
                    <textarea
                        value={observacion}
                        onChange={(e) => setObservacion(e.target.value)}
                        onBlur={guardarObservacion}
                        disabled={!puedoEditar}
                        placeholder="Observación (obligatoria)"
                        className={clsx(
                            'w-full border rounded-lg px-3 py-2 text-sm bg-background min-h-[60px]',
                            !observacion.trim() ? 'border-red-500/60' : 'border-border'
                        )}
                    />
                    <div className="flex items-center gap-2 flex-wrap">
                        {(hallazgo.fotos || []).map((f) => (
                            <button key={f.id} onClick={() => cargarUrlFoto(f)} className="w-14 h-14 rounded-lg overflow-hidden border border-border bg-muted">
                                {fotoUrls[f.id] ? <img src={fotoUrls[f.id]} alt="" className="w-full h-full object-cover" /> : <span className="text-[9px] text-muted-foreground flex items-center justify-center h-full">Ver</span>}
                            </button>
                        ))}
                        {puedoEditar && (
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={subiendo}
                                className={clsx(
                                    'w-14 h-14 rounded-lg border-2 border-dashed flex items-center justify-center min-h-[44px]',
                                    estadoActual === 'M' && (hallazgo.fotos || []).length === 0 ? 'border-red-500/60 text-red-600' : 'border-border text-muted-foreground'
                                )}
                            >
                                {subiendo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-5 h-5" />}
                            </button>
                        )}
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            capture="environment"
                            className="hidden"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) subirFoto(f); e.target.value = ''; }}
                        />
                    </div>
                    {estadoActual === 'M' && (hallazgo.fotos || []).length === 0 && (
                        <p className="text-xs text-red-600 dark:text-red-400">Falta al menos 1 foto — obligatoria para ítems en Malo.</p>
                    )}
                </div>
            )}
        </div>
    );
}

// ============================================================
// TAB 3 — Reparaciones (cotización)
// ============================================================
function TabReparaciones({ ordenId, orden, reparaciones, catalogo, puedoEditar, motivoBloqueo, onCambio, onOrdenActualizada }: {
    ordenId: string;
    orden: MttoOrden;
    reparaciones: ReparacionConFotos[];
    catalogo: CatalogoSistemaConArreglos[];
    puedoEditar: boolean;
    motivoBloqueo?: string;
    onCambio: () => void;
    onOrdenActualizada: (o: MttoOrden) => void;
}) {
    const [agregando, setAgregando] = useState(false);
    const [trayendo, setTrayendo] = useState(false);
    const [ivaTasa, setIvaTasa] = useState(orden.iva_tasa);

    useEffect(() => { setIvaTasa(orden.iva_tasa); }, [orden.iva_tasa]);

    // Totales PROPUESTOS: todas las líneas cotizadas (autorizado se decide después, en aprobación)
    const subtotalRepuestos = reparaciones.reduce((acc, r) => acc + Number(r.subtotal_repuestos), 0);
    const subtotalManoObra = reparaciones.reduce((acc, r) => acc + Number(r.mano_obra), 0);
    const subtotal = subtotalRepuestos + subtotalManoObra;
    const iva = Math.round(subtotal * ivaTasa);
    const total = subtotal + iva;

    const agregarLinea = async () => {
        setAgregando(true);
        try {
            await MttoService.crearReparacion({ orden_id: ordenId, descripcion: 'Nueva reparación' });
            onCambio();
        } catch (e: any) {
            toast('Error al agregar la línea', 'error', e.message);
        } finally {
            setAgregando(false);
        }
    };

    const traerMalos = async () => {
        setTrayendo(true);
        try {
            const nuevas = await MttoService.crearReparacionesDesdeMalos(ordenId);
            toast(nuevas.length > 0 ? `${nuevas.length} línea(s) agregadas desde ítems en Malo` : 'No hay ítems en Malo pendientes de cotizar', 'info');
            onCambio();
        } catch (e: any) {
            toast('Error al traer hallazgos en M', 'error', e.message);
        } finally {
            setTrayendo(false);
        }
    };

    const cambiarIva = async (nuevo: number) => {
        setIvaTasa(nuevo);
        try {
            const actualizado = await MttoService.updateOrden(ordenId, { iva_tasa: nuevo });
            onOrdenActualizada(actualizado);
        } catch (e: any) {
            toast('No se pudo actualizar el IVA', 'error', e.message);
        }
    };

    return (
        <div className="space-y-3">
            <Bloqueado activo={puedoEditar} motivo={motivoBloqueo}>
                <div className="flex gap-2">
                    <button onClick={agregarLinea} disabled={agregando}
                        className="flex items-center gap-1.5 bg-primary text-primary-foreground px-3 py-2.5 rounded-lg text-sm font-semibold min-h-[44px]">
                        <Plus className="w-4 h-4" /> Agregar línea
                    </button>
                    <button onClick={traerMalos} disabled={trayendo}
                        className="flex items-center gap-1.5 bg-muted text-foreground px-3 py-2.5 rounded-lg text-sm font-semibold min-h-[44px]">
                        {trayendo ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertTriangle className="w-4 h-4" />} Traer hallazgos en M
                    </button>
                </div>

                <div className="space-y-2 mt-3">
                    {reparaciones.length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-6">Sin reparaciones cotizadas todavía.</p>
                    )}
                    {reparaciones.map((r) => (
                        <RepairLineCard key={r.id} ordenId={ordenId} reparacion={r} catalogo={catalogo} puedoEditar={puedoEditar} onCambio={onCambio} />
                    ))}
                </div>
            </Bloqueado>

            <div className="bg-card border border-border rounded-xl p-4 space-y-1.5 text-sm">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal repuestos</span><span>{money(subtotalRepuestos)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal mano de obra</span><span>{money(subtotalManoObra)}</span></div>
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>{money(subtotal)}</span></div>
                <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">IVA</span>
                    <div className="flex items-center gap-2">
                        <select
                            value={ivaTasa}
                            disabled={!puedoEditar}
                            onChange={(e) => cambiarIva(Number(e.target.value))}
                            className="border border-border rounded-lg px-2 py-1.5 bg-background text-sm min-h-[36px]"
                        >
                            <option value={0}>0%</option>
                            <option value={0.05}>5%</option>
                            <option value={0.19}>19%</option>
                        </select>
                        <span>{money(iva)}</span>
                    </div>
                </div>
                <div className="flex justify-between items-center pt-2 border-t border-border mt-2">
                    <span className="font-bold">TOTAL A APROBAR</span>
                    <span className="font-bold text-lg text-primary">{money(total)}</span>
                </div>
            </div>
        </div>
    );
}

function RepairLineCard({ ordenId, reparacion, catalogo, puedoEditar, onCambio }: {
    ordenId: string;
    reparacion: ReparacionConFotos;
    catalogo: CatalogoSistemaConArreglos[];
    puedoEditar: boolean;
    onCambio: () => void;
}) {
    const [descripcion, setDescripcion] = useState(reparacion.descripcion);
    const [repuesto, setRepuesto] = useState(reparacion.repuesto || '');
    const [cantidad, setCantidad] = useState(reparacion.cantidad.toString());
    const [valorUnitario, setValorUnitario] = useState(reparacion.valor_unitario.toString());
    const [manoObra, setManoObra] = useState(reparacion.mano_obra.toString());
    const [prioridad, setPrioridad] = useState<MttoPrioridad>(reparacion.prioridad);
    const [buscador, setBuscador] = useState(false);
    const [subiendoFoto, setSubiendoFoto] = useState(false);
    const [fotoUrls, setFotoUrls] = useState<Record<string, string>>({});
    const fotoInputRef = useRef<HTMLInputElement>(null);

    const fotos = reparacion.fotos || [];

    // Carga las miniaturas (URLs firmadas: el bucket es privado)
    useEffect(() => {
        let cancelado = false;
        (async () => {
            for (const f of fotos) {
                if (fotoUrls[f.id]) continue;
                try {
                    const url = await MttoService.getFotoUrl(f.path);
                    if (!cancelado) setFotoUrls((prev) => ({ ...prev, [f.id]: url }));
                } catch { /* si falla, la miniatura queda vacía */ }
            }
        })();
        return () => { cancelado = true; };
    }, [fotos.map((f) => f.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

    const subirFoto = async (file: File) => {
        setSubiendoFoto(true);
        try {
            await MttoService.subirFotoReparacion(ordenId, reparacion.id, file);
            onCambio();
        } catch (e: any) {
            toast('No se pudo subir la foto', 'error', e.message);
        } finally {
            setSubiendoFoto(false);
        }
    };

    const borrarFoto = async (fotoId: string, path: string) => {
        try {
            await MttoService.eliminarFotoReparacion(fotoId, path);
            onCambio();
        } catch (e: any) {
            toast('No se pudo eliminar la foto', 'error', e.message);
        }
    };

    const guardar = async (patch: Partial<MttoOrdenReparacion>) => {
        try {
            await MttoService.actualizarReparacion(reparacion.id, patch as any);
            onCambio();
        } catch (e: any) {
            toast('No se pudo guardar el cambio', 'error', e.message);
        }
    };

    const eliminar = async () => {
        try {
            await MttoService.eliminarReparacion(reparacion.id);
            onCambio();
        } catch (e: any) {
            toast('No se pudo eliminar la línea', 'error', e.message);
        }
    };

    const elegirArreglo = async (sistemaNombre: string, arreglo: CatalogoSistemaConArreglos['arreglos'][number]) => {
        setDescripcion(arreglo.nombre);
        if (arreglo.precio_repuesto_ref !== null) setValorUnitario(String(arreglo.precio_repuesto_ref));
        if (arreglo.precio_mo_ref !== null) setManoObra(String(arreglo.precio_mo_ref));
        setBuscador(false);
        await guardar({
            arreglo_id: arreglo.id,
            descripcion: arreglo.nombre,
            sistema: sistemaNombre,
            valor_unitario: arreglo.precio_repuesto_ref ?? undefined,
            mano_obra: arreglo.precio_mo_ref ?? undefined,
        } as any);
    };

    const total = Number(cantidad || 0) * Number(valorUnitario || 0) + Number(manoObra || 0);

    return (
        <div className="bg-card border border-border rounded-xl p-3 space-y-2">
            <div className="flex items-start justify-between gap-2">
                <div className="flex-1 relative">
                    <button
                        disabled={!puedoEditar}
                        onClick={() => setBuscador((v) => !v)}
                        className="w-full text-left text-sm font-medium border border-border rounded-lg px-3 py-2 bg-background flex items-center justify-between gap-2 min-h-[44px]"
                    >
                        <span className="truncate">{descripcion}</span>
                        <Search className="w-4 h-4 text-muted-foreground shrink-0" />
                    </button>
                    {buscador && <ArregloPicker catalogo={catalogo} onElegir={elegirArreglo} onCerrar={() => setBuscador(false)} />}
                </div>
                {puedoEditar && (
                    <button onClick={eliminar} className="p-2.5 text-muted-foreground hover:text-destructive min-h-[44px] min-w-[44px]">
                        <Trash2 className="w-4 h-4" />
                    </button>
                )}
            </div>

            {!puedoEditar ? null : (
                <textarea
                    value={descripcion}
                    onChange={(e) => setDescripcion(e.target.value)}
                    onBlur={() => guardar({ descripcion } as any)}
                    className="w-full border border-border rounded-lg px-3 py-2 text-sm bg-background"
                    placeholder="Descripción del arreglo"
                    disabled={!puedoEditar}
                />
            )}

            <div className="grid grid-cols-2 gap-2">
                <Campo label="Repuesto / ref">
                    <input value={repuesto} disabled={!puedoEditar} onChange={(e) => setRepuesto(e.target.value)} onBlur={() => guardar({ repuesto } as any)}
                        className="w-full border border-border rounded-lg px-2 py-2 bg-background text-sm min-h-[40px]" />
                </Campo>
                <Campo label="Prioridad">
                    <select value={prioridad} disabled={!puedoEditar} onChange={(e) => { setPrioridad(e.target.value as MttoPrioridad); guardar({ prioridad: e.target.value as MttoPrioridad } as any); }}
                        className="w-full border border-border rounded-lg px-2 py-2 bg-background text-sm min-h-[40px]">
                        <option value="alta">Alta</option>
                        <option value="media">Media</option>
                        <option value="baja">Baja</option>
                    </select>
                </Campo>
                <Campo label="Cantidad">
                    <input type="number" value={cantidad} disabled={!puedoEditar} onChange={(e) => setCantidad(e.target.value)} onBlur={() => guardar({ cantidad: Number(cantidad) } as any)}
                        className="w-full border border-border rounded-lg px-2 py-2 bg-background text-sm min-h-[40px]" />
                </Campo>
                <Campo label="Valor unitario">
                    <input type="number" value={valorUnitario} disabled={!puedoEditar} onChange={(e) => setValorUnitario(e.target.value)} onBlur={() => guardar({ valor_unitario: Number(valorUnitario) } as any)}
                        className="w-full border border-border rounded-lg px-2 py-2 bg-background text-sm min-h-[40px]" />
                </Campo>
                <Campo label="Mano de obra">
                    <input type="number" value={manoObra} disabled={!puedoEditar} onChange={(e) => setManoObra(e.target.value)} onBlur={() => guardar({ mano_obra: Number(manoObra) } as any)}
                        className="w-full border border-border rounded-lg px-2 py-2 bg-background text-sm min-h-[40px]" />
                </Campo>
                <Campo label="Total línea">
                    <div className="font-bold text-sm py-2">{money(total)}</div>
                </Campo>
            </div>

            {/* Fotos del repuesto — OPCIONALES. No confundir con las fotos de
                hallazgo del checklist, que sí son obligatorias en ítems en M. */}
            {(fotos.length > 0 || puedoEditar) && (
                <div className="pt-2 border-t border-border/60">
                    <div className="text-[11px] text-muted-foreground mb-1">
                        Fotos del repuesto {fotos.length === 0 && '(opcional)'}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap">
                        {fotos.map((f) => (
                            <div key={f.id} className="relative group">
                                <div className="w-14 h-14 rounded-lg overflow-hidden border border-border bg-muted">
                                    {fotoUrls[f.id]
                                        ? <img src={fotoUrls[f.id]} alt="Repuesto" className="w-full h-full object-cover" />
                                        : <div className="w-full h-full flex items-center justify-center"><Loader2 className="w-3 h-3 animate-spin text-muted-foreground" /></div>}
                                </div>
                                {puedoEditar && (
                                    <button onClick={() => borrarFoto(f.id, f.path)}
                                        title="Eliminar foto"
                                        className="absolute -top-1.5 -right-1.5 bg-destructive text-destructive-foreground rounded-full w-5 h-5 flex items-center justify-center shadow">
                                        <X className="w-3 h-3" />
                                    </button>
                                )}
                            </div>
                        ))}
                        {puedoEditar && (
                            <button onClick={() => fotoInputRef.current?.click()} disabled={subiendoFoto}
                                className="w-14 h-14 rounded-lg border-2 border-dashed border-border text-muted-foreground flex items-center justify-center min-h-[44px]">
                                {subiendoFoto ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-5 h-5" />}
                            </button>
                        )}
                        <input ref={fotoInputRef} type="file" accept="image/*" capture="environment" className="hidden"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) subirFoto(f); e.target.value = ''; }} />
                    </div>
                </div>
            )}
        </div>
    );
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <div>
            <div className="text-[11px] text-muted-foreground mb-0.5">{label}</div>
            {children}
        </div>
    );
}

function ArregloPicker({ catalogo, onElegir, onCerrar }: {
    catalogo: CatalogoSistemaConArreglos[];
    onElegir: (sistemaNombre: string, arreglo: CatalogoSistemaConArreglos['arreglos'][number]) => void;
    onCerrar: () => void;
}) {
    const [q, setQ] = useState('');
    const qNorm = q.trim().toLowerCase();

    const grupos = catalogo
        .map((s) => ({ sistema: s.nombre, arreglos: s.arreglos.filter((a) => !qNorm || a.nombre.toLowerCase().includes(qNorm)) }))
        .filter((g) => g.arreglos.length > 0);

    return (
        <div className="absolute z-20 mt-1 w-full bg-popover border border-border rounded-xl shadow-2xl max-h-80 overflow-hidden flex flex-col">
            <div className="p-2 border-b border-border flex items-center gap-2">
                <Search className="w-4 h-4 text-muted-foreground shrink-0" />
                <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar arreglo..."
                    className="flex-1 bg-transparent text-sm outline-none py-2" />
                <button onClick={onCerrar} className="p-1"><X className="w-4 h-4" /></button>
            </div>
            <div className="overflow-y-auto">
                {grupos.length === 0 && <p className="text-sm text-muted-foreground p-3 text-center">Sin resultados</p>}
                {grupos.map((g) => (
                    <div key={g.sistema}>
                        <div className="px-3 py-1.5 text-[11px] font-bold uppercase text-muted-foreground bg-muted/50 sticky top-0">{g.sistema}</div>
                        {g.arreglos.map((a) => (
                            <button key={a.id} onClick={() => onElegir(g.sistema, a)} className="w-full text-left px-3 py-2.5 text-sm hover:bg-muted min-h-[44px]">
                                {a.nombre}
                            </button>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    );
}

// ============================================================
// TAB 4 — Revisión y aprobación
// ============================================================
function TabRevision({ orden, reparaciones, eventos, puedoRevisar, puedoAprobar, puedoDevolver, onCambio }: {
    orden: MttoOrden;
    reparaciones: ReparacionConFotos[];
    eventos: (MttoOrdenEvento & { usuario?: { full_name: string | null } })[];
    puedoRevisar: boolean;
    puedoAprobar: boolean;
    puedoDevolver: boolean;
    onCambio: () => void;
}) {
    const [obsEncargado, setObsEncargado] = useState(orden.obs_encargado || '');
    const [decision, setDecision] = useState<MttoDecision>('aprobado');
    const [obsAprobador, setObsAprobador] = useState('');
    const [valorAprobado, setValorAprobado] = useState('');
    const [lineasElegidas, setLineasElegidas] = useState<Set<string>>(new Set(reparaciones.map((r) => r.id)));
    const [motivoDevolucion, setMotivoDevolucion] = useState('');
    const [mostrarDevolucion, setMostrarDevolucion] = useState(false);
    const [procesando, setProcesando] = useState(false);

    const [usuariosRol, setUsuariosRol] = useState<MttoUsuarioRol[]>([]);
    const [mostrarPinRevisar, setMostrarPinRevisar] = useState(false);
    const [firmanteRevisar, setFirmanteRevisar] = useState('');
    const [pinRevisar, setPinRevisar] = useState('');
    const [mostrarPinAprobar, setMostrarPinAprobar] = useState(false);
    const [firmanteAprobar, setFirmanteAprobar] = useState('');
    const [pinAprobar, setPinAprobar] = useState('');

    useEffect(() => {
        MttoService.listUsuariosRol().then(setUsuariosRol).catch(() => {});
    }, []);

    const encargados = usuariosRol.filter((u) => u.rol === 'encargado' || u.rol === 'admin');
    const aprobadores = usuariosRol.filter((u) => u.rol === 'aprobador' || u.rol === 'admin');

    const subtotal = reparaciones.reduce((acc, r) => acc + Number(r.total), 0);
    const totalPropuesto = Math.round(subtotal * (1 + orden.iva_tasa));

    useEffect(() => { if (!valorAprobado) setValorAprobado(String(totalPropuesto)); }, [totalPropuesto]); // eslint-disable-line react-hooks/exhaustive-deps

    const marcarRevisado = async () => {
        setProcesando(true);
        try {
            await MttoService.revisarOrden(orden.id, obsEncargado);
            toast('Orden revisada y enviada a aprobación', 'success');
            onCambio();
        } catch (e: any) {
            toast('No se pudo revisar la orden', 'error', e.message);
        } finally { setProcesando(false); }
    };

    const firmarRevisionPin = async () => {
        if (!firmanteRevisar) { toast('Seleccione quién firma', 'error'); return; }
        if (!/^\d{4,6}$/.test(pinRevisar)) { toast('PIN inválido', 'error'); return; }
        setProcesando(true);
        try {
            await MttoService.revisarConPin(orden.id, firmanteRevisar, pinRevisar, obsEncargado);
            toast('Orden revisada y enviada a aprobación', 'success');
            setPinRevisar('');
            setMostrarPinRevisar(false);
            onCambio();
        } catch (e: any) {
            toast('No se pudo revisar con PIN', 'error', e.message);
        } finally { setProcesando(false); }
    };

    const enviarDecision = async () => {
        setProcesando(true);
        try {
            await MttoService.aprobarOrden(
                orden.id, decision, obsAprobador, Number(valorAprobado || 0),
                decision === 'aprobado_parcial' ? Array.from(lineasElegidas) : undefined
            );
            toast('Decisión registrada', 'success');
            onCambio();
        } catch (e: any) {
            toast('No se pudo registrar la decisión', 'error', e.message);
        } finally { setProcesando(false); }
    };

    const firmarAprobacionPin = async () => {
        if (!firmanteAprobar) { toast('Seleccione quién firma', 'error'); return; }
        if (!/^\d{4,6}$/.test(pinAprobar)) { toast('PIN inválido', 'error'); return; }
        setProcesando(true);
        try {
            await MttoService.aprobarConPin(
                orden.id, firmanteAprobar, pinAprobar, decision, obsAprobador, Number(valorAprobado || 0),
                decision === 'aprobado_parcial' ? Array.from(lineasElegidas) : undefined
            );
            toast('Decisión registrada', 'success');
            setPinAprobar('');
            setMostrarPinAprobar(false);
            onCambio();
        } catch (e: any) {
            toast('No se pudo aprobar con PIN', 'error', e.message);
        } finally { setProcesando(false); }
    };

    const devolver = async () => {
        if (!motivoDevolucion.trim()) { toast('Indique el motivo de la devolución', 'error'); return; }
        setProcesando(true);
        try {
            await MttoService.devolverOrden(orden.id, motivoDevolucion);
            toast('Orden devuelta a borrador', 'info');
            setMostrarDevolucion(false);
            setMotivoDevolucion('');
            onCambio();
        } catch (e: any) {
            toast('No se pudo devolver la orden', 'error', e.message);
        } finally { setProcesando(false); }
    };

    const toggleLinea = (id: string) => {
        setLineasElegidas((prev) => {
            const next = new Set(prev);
            next.has(id) ? next.delete(id) : next.add(id);
            return next;
        });
    };

    const puedeFirmarRevisarPin = orden.estado === 'en_revision';
    const puedeFirmarAprobarPin = orden.estado === 'en_aprobacion';

    return (
        <div className="space-y-4">
            <div className="bg-card border border-border rounded-xl p-4 space-y-2">
                <h3 className="font-bold text-sm">Observaciones del encargado de flota</h3>
                <textarea value={obsEncargado} onChange={(e) => setObsEncargado(e.target.value)} disabled={!puedeFirmarRevisarPin}
                    className="w-full border border-border rounded-lg px-3 py-2 bg-background min-h-[80px] text-sm" placeholder="Diagnóstico revisado, observaciones adicionales..." />

                {puedoRevisar ? (
                    <button onClick={marcarRevisado} disabled={procesando}
                        className="w-full bg-primary text-primary-foreground py-3 rounded-xl font-semibold min-h-[44px] flex items-center justify-center gap-2 disabled:opacity-60">
                        {procesando && <Loader2 className="w-4 h-4 animate-spin" />} Marcar como revisado → enviar a aprobación
                    </button>
                ) : !puedeFirmarRevisarPin ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/60 rounded-lg px-3 py-2">
                        <Lock className="w-3.5 h-3.5 shrink-0" /> Solo disponible con la orden en "{ESTADO_LABEL.en_revision}".
                    </div>
                ) : (
                    <FirmaPin
                        etiqueta="encargado de flota"
                        candidatos={encargados}
                        abierto={mostrarPinRevisar}
                        onAbrir={() => setMostrarPinRevisar((v) => !v)}
                        firmante={firmanteRevisar}
                        onFirmante={setFirmanteRevisar}
                        pin={pinRevisar}
                        onPin={setPinRevisar}
                        onConfirmar={firmarRevisionPin}
                        procesando={procesando}
                    />
                )}
            </div>

            <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                <h3 className="font-bold text-sm">Decisión del aprobador</h3>
                <div className="grid grid-cols-3 gap-2">
                    <button onClick={() => setDecision('aprobado')} disabled={!puedeFirmarAprobarPin}
                        className={clsx('py-3 rounded-xl font-bold text-xs flex flex-col items-center gap-1 min-h-[44px] border-2',
                            decision === 'aprobado' ? 'bg-emerald-500 text-white border-emerald-500' : 'border-border text-muted-foreground')}>
                        <ShieldCheck className="w-5 h-5" /> APROBADO
                    </button>
                    <button onClick={() => setDecision('aprobado_parcial')} disabled={!puedeFirmarAprobarPin}
                        className={clsx('py-3 rounded-xl font-bold text-xs flex flex-col items-center gap-1 min-h-[44px] border-2',
                            decision === 'aprobado_parcial' ? 'bg-amber-500 text-white border-amber-500' : 'border-border text-muted-foreground')}>
                        <ShieldAlert className="w-5 h-5" /> PARCIAL
                    </button>
                    <button onClick={() => setDecision('no_aprobado')} disabled={!puedeFirmarAprobarPin}
                        className={clsx('py-3 rounded-xl font-bold text-xs flex flex-col items-center gap-1 min-h-[44px] border-2',
                            decision === 'no_aprobado' ? 'bg-red-500 text-white border-red-500' : 'border-border text-muted-foreground')}>
                        <ShieldX className="w-5 h-5" /> NO APROBADO
                    </button>
                </div>

                {decision === 'aprobado_parcial' && (
                    <div className="space-y-1.5">
                        <p className="text-xs text-muted-foreground">Seleccione las líneas que autoriza:</p>
                        {reparaciones.map((r) => (
                            <label key={r.id} className="flex items-center gap-2 text-sm p-2 border border-border rounded-lg min-h-[44px]">
                                <input type="checkbox" checked={lineasElegidas.has(r.id)} onChange={() => toggleLinea(r.id)} disabled={!puedeFirmarAprobarPin} className="w-5 h-5" />
                                <span className="flex-1">{r.descripcion}</span>
                                <span className="font-medium">{money(Number(r.total))}</span>
                            </label>
                        ))}
                    </div>
                )}

                <textarea value={obsAprobador} onChange={(e) => setObsAprobador(e.target.value)} disabled={!puedeFirmarAprobarPin}
                    className="w-full border border-border rounded-lg px-3 py-2 bg-background min-h-[70px] text-sm"
                    placeholder={decision === 'aprobado_parcial' ? 'Observaciones (obligatorias en aprobación parcial)' : 'Observaciones (opcional)'} />

                <div>
                    <label className="text-xs text-muted-foreground block mb-1">Valor aprobado</label>
                    <input type="number" value={valorAprobado} onChange={(e) => setValorAprobado(e.target.value)} disabled={!puedeFirmarAprobarPin}
                        className="w-full border border-border rounded-lg px-3 py-2 bg-background min-h-[44px]" />
                </div>

                {puedoAprobar ? (
                    <button onClick={enviarDecision} disabled={procesando}
                        className="w-full bg-primary text-primary-foreground py-3 rounded-xl font-semibold min-h-[44px] flex items-center justify-center gap-2 disabled:opacity-60">
                        {procesando && <Loader2 className="w-4 h-4 animate-spin" />} Confirmar decisión
                    </button>
                ) : !puedeFirmarAprobarPin ? (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/60 rounded-lg px-3 py-2">
                        <Lock className="w-3.5 h-3.5 shrink-0" /> Solo disponible con la orden en "{ESTADO_LABEL.en_aprobacion}".
                    </div>
                ) : (
                    <FirmaPin
                        etiqueta="aprobador"
                        candidatos={aprobadores}
                        abierto={mostrarPinAprobar}
                        onAbrir={() => setMostrarPinAprobar((v) => !v)}
                        firmante={firmanteAprobar}
                        onFirmante={setFirmanteAprobar}
                        pin={pinAprobar}
                        onPin={setPinAprobar}
                        onConfirmar={firmarAprobacionPin}
                        procesando={procesando}
                    />
                )}
            </div>

            <Bloqueado activo={puedoDevolver}>
                {!mostrarDevolucion ? (
                    <button onClick={() => setMostrarDevolucion(true)} className="text-sm text-muted-foreground underline min-h-[44px]">
                        Devolver la orden al mecánico (con motivo)
                    </button>
                ) : (
                    <div className="bg-card border border-border rounded-xl p-4 space-y-2">
                        <textarea value={motivoDevolucion} onChange={(e) => setMotivoDevolucion(e.target.value)}
                            className="w-full border border-border rounded-lg px-3 py-2 bg-background min-h-[70px] text-sm" placeholder="Motivo de la devolución (obligatorio)" />
                        <div className="flex gap-2">
                            <button onClick={devolver} disabled={procesando} className="flex-1 bg-destructive text-destructive-foreground py-2.5 rounded-lg font-semibold min-h-[44px]">Devolver</button>
                            <button onClick={() => setMostrarDevolucion(false)} className="px-4 py-2.5 rounded-lg border border-border min-h-[44px]">Cancelar</button>
                        </div>
                    </div>
                )}
            </Bloqueado>

            <div className="bg-card border border-border rounded-xl p-4">
                <h3 className="font-bold text-sm mb-2 flex items-center gap-2"><Clock className="w-4 h-4" /> Trazabilidad</h3>
                <div className="space-y-2">
                    {eventos.length === 0 && <p className="text-sm text-muted-foreground">Sin eventos todavía.</p>}
                    {eventos.map((e) => (
                        <div key={e.id} className="text-sm border-l-2 border-primary/40 pl-3 py-0.5">
                            <div className="font-medium">{EVENTO_LABEL[e.accion] || e.accion}</div>
                            <div className="text-xs text-muted-foreground">
                                {e.usuario?.full_name || 'Usuario'} · {new Date(e.created_at).toLocaleString('es-CO')}
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}

// ============================================================
// Firma rápida por PIN — para revisar/aprobar desde el teléfono de
// otra persona sin loguearse con correo+clave. El PIN se valida con
// bcrypt en el servidor (mtto_revisar_orden_pin/mtto_aprobar_orden_pin)
// y la orden queda firmada por el usuario_id real del firmante, no
// por quien tiene la sesión abierta en el dispositivo.
// ============================================================
function FirmaPin({ etiqueta, candidatos, abierto, onAbrir, firmante, onFirmante, pin, onPin, onConfirmar, procesando }: {
    etiqueta: string;
    candidatos: (MttoUsuarioRol & { profile?: { full_name: string | null } })[];
    abierto: boolean;
    onAbrir: () => void;
    firmante: string;
    onFirmante: (id: string) => void;
    pin: string;
    onPin: (v: string) => void;
    onConfirmar: () => void;
    procesando: boolean;
}) {
    if (!abierto) {
        return (
            <button onClick={onAbrir} className="w-full flex items-center justify-center gap-2 border-2 border-dashed border-border text-muted-foreground py-3 rounded-xl font-semibold text-sm min-h-[44px]">
                <KeyRound className="w-4 h-4" /> Firmar con PIN ({etiqueta})
            </button>
        );
    }

    return (
        <div className="border-2 border-primary/30 rounded-xl p-3 space-y-2">
            <p className="text-xs text-muted-foreground">
                Pásele el teléfono al {etiqueta} para que elija su nombre y escriba su PIN.
            </p>
            <select value={firmante} onChange={(e) => onFirmante(e.target.value)}
                className="w-full border border-border rounded-lg px-3 py-2.5 bg-background text-sm min-h-[44px]">
                <option value="">Seleccione quién firma...</option>
                {candidatos.map((u) => (
                    <option key={u.usuario_id} value={u.usuario_id}>{u.profile?.full_name || u.nombre || u.usuario_id}</option>
                ))}
            </select>
            <input
                type="password" inputMode="numeric" pattern="[0-9]*" maxLength={6}
                value={pin} onChange={(e) => onPin(e.target.value.replace(/\D/g, ''))}
                placeholder="PIN"
                className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px] tracking-widest text-center text-lg"
            />
            <div className="flex gap-2">
                <button onClick={onConfirmar} disabled={procesando || !firmante || pin.length < 4}
                    className="flex-1 bg-primary text-primary-foreground py-2.5 rounded-lg font-semibold min-h-[44px] flex items-center justify-center gap-2 disabled:opacity-60">
                    {procesando && <Loader2 className="w-4 h-4 animate-spin" />} Confirmar con PIN
                </button>
                <button onClick={onAbrir} className="px-4 py-2.5 rounded-lg border border-border min-h-[44px]">Cancelar</button>
            </div>
        </div>
    );
}

// ============================================================
// Barra de acción inferior — transiciones simples de un clic
// ============================================================
function BarraAccionInferior({ orden, puedoEnviar, puedoIniciarEjecucion, puedoCerrar, onCambio }: {
    orden: MttoOrden;
    puedoEnviar: boolean;
    puedoIniciarEjecucion: boolean;
    puedoCerrar: boolean;
    onCambio: () => void;
}) {
    const [procesando, setProcesando] = useState(false);
    const [notasCierre, setNotasCierre] = useState('');
    const [mostrarNotas, setMostrarNotas] = useState(false);

    const enviarRevision = async () => {
        setProcesando(true);
        try {
            await MttoService.enviarARevision(orden.id);
            toast('Orden enviada a revisión', 'success');
            onCambio();
        } catch (e: any) {
            toast('No se pudo enviar a revisión', 'error', e.message);
        } finally { setProcesando(false); }
    };

    const iniciarEjecucion = async () => {
        setProcesando(true);
        try {
            await MttoService.iniciarEjecucion(orden.id);
            toast('Ejecución iniciada', 'success');
            onCambio();
        } catch (e: any) {
            toast('No se pudo iniciar la ejecución', 'error', e.message);
        } finally { setProcesando(false); }
    };

    const cerrar = async () => {
        setProcesando(true);
        try {
            await MttoService.cerrarOrden(orden.id, notasCierre);
            toast('Orden cerrada', 'success');
            setMostrarNotas(false);
            onCambio();
        } catch (e: any) {
            toast('No se pudo cerrar la orden', 'error', e.message);
        } finally { setProcesando(false); }
    };

    return (
        <div className="fixed bottom-0 left-0 right-0 bg-background/95 backdrop-blur border-t border-border p-3 z-20">
            <div className="max-w-4xl mx-auto">
                {puedoEnviar && (
                    <button onClick={enviarRevision} disabled={procesando}
                        className="w-full bg-primary text-primary-foreground py-3.5 rounded-xl font-bold flex items-center justify-center gap-2 min-h-[44px] disabled:opacity-60">
                        {procesando ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />} Enviar a revisión
                    </button>
                )}
                {puedoIniciarEjecucion && (
                    <button onClick={iniciarEjecucion} disabled={procesando}
                        className="w-full bg-indigo-600 text-white py-3.5 rounded-xl font-bold flex items-center justify-center gap-2 min-h-[44px] disabled:opacity-60">
                        {procesando && <Loader2 className="w-5 h-5 animate-spin" />} Iniciar ejecución
                    </button>
                )}
                {puedoCerrar && !mostrarNotas && (
                    <button onClick={() => setMostrarNotas(true)}
                        className="w-full bg-emerald-600 text-white py-3.5 rounded-xl font-bold flex items-center justify-center gap-2 min-h-[44px]">
                        <Check className="w-5 h-5" /> Cerrar orden
                    </button>
                )}
                {puedoCerrar && mostrarNotas && (
                    <div className="space-y-2">
                        <textarea value={notasCierre} onChange={(e) => setNotasCierre(e.target.value)}
                            placeholder="Notas de cierre (opcional)" className="w-full border border-border rounded-lg px-3 py-2 bg-background text-sm" />
                        <div className="flex gap-2">
                            <button onClick={cerrar} disabled={procesando} className="flex-1 bg-emerald-600 text-white py-3 rounded-xl font-bold min-h-[44px] disabled:opacity-60">Confirmar cierre</button>
                            <button onClick={() => setMostrarNotas(false)} className="px-4 py-3 rounded-xl border border-border min-h-[44px]">Cancelar</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
