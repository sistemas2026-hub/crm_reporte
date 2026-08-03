import { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Wrench, Plus, X, Loader2, ChevronRight, Filter, AlertTriangle, Truck, KeyRound } from 'lucide-react';
import clsx from 'clsx';
import { MttoService, type MttoOrden, type MttoVehiculo, type MttoOrdenResumen } from '../lib/mttoService';
import { ESTADO_LABEL, ESTADO_COLOR, TIPO_SERVICIO_LABEL, toast } from '../lib/mttoLabels';

type OrdenConVehiculo = MttoOrden & { vehiculo?: MttoVehiculo };

export function MaintenanceHub() {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(true);
    const [ordenes, setOrdenes] = useState<OrdenConVehiculo[]>([]);
    const [resumenes, setResumenes] = useState<Record<string, MttoOrdenResumen>>({});
    const [vehiculos, setVehiculos] = useState<MttoVehiculo[]>([]);
    const [contexto, setContexto] = useState<{ rol: string | null; esAdmin: boolean }>({ rol: null, esAdmin: false });

    const [filtroEstado, setFiltroEstado] = useState<MttoOrden['estado'] | 'todas'>('todas');
    const [filtroVehiculo, setFiltroVehiculo] = useState('');
    const [mostrarFiltros, setMostrarFiltros] = useState(false);

    const [modalNuevaOrden, setModalNuevaOrden] = useState(false);
    const [creando, setCreando] = useState(false);
    const [nuevoVehiculoId, setNuevoVehiculoId] = useState('');
    const [nuevoTipoServicio, setNuevoTipoServicio] = useState<'preventivo' | 'correctivo' | 'emergencia' | 'diagnostico' | 'alistamiento'>('correctivo');
    const [nuevoTaller, setNuevoTaller] = useState('');
    const [nuevoMotivo, setNuevoMotivo] = useState('');
    const [nuevoKm, setNuevoKm] = useState('');
    const [errorNuevaOrden, setErrorNuevaOrden] = useState('');

    const [modalPin, setModalPin] = useState(false);
    const [pin, setPin] = useState('');
    const [pinConfirm, setPinConfirm] = useState('');
    const [guardandoPin, setGuardandoPin] = useState(false);

    const cargar = async () => {
        setLoading(true);
        try {
            const [ctx, vehiculosData, ordenesData] = await Promise.all([
                MttoService.getMiContexto(),
                MttoService.listVehiculos(),
                MttoService.listOrdenes(),
            ]);
            setContexto(ctx);
            setVehiculos(vehiculosData);
            setOrdenes(ordenesData);
            const res = await MttoService.listResumenes(ordenesData.map((o) => o.id));
            setResumenes(Object.fromEntries(res.map((r) => [r.orden_id, r])));
        } catch (e: any) {
            console.error('[Mantenimiento] Error cargando bandeja:', e);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => { cargar(); }, []);

    const puedeCrear = contexto.rol === 'mecanico' || contexto.esAdmin;

    // Estado que le "toca actuar" a este usuario según su rol
    const estadoPrioritario: MttoOrden['estado'] | null =
        contexto.rol === 'encargado' ? 'en_revision' :
        contexto.rol === 'aprobador' ? 'en_aprobacion' :
        contexto.rol === 'mecanico' ? 'borrador' : null;

    const pendientesParaMi = useMemo(() => {
        if (!estadoPrioritario) return 0;
        return ordenes.filter((o) => o.estado === estadoPrioritario).length;
    }, [ordenes, estadoPrioritario]);

    const ordenesFiltradas = useMemo(() => {
        let lista = [...ordenes];
        if (filtroEstado !== 'todas') lista = lista.filter((o) => o.estado === filtroEstado);
        if (filtroVehiculo) lista = lista.filter((o) => o.vehiculo_id === filtroVehiculo);

        if (estadoPrioritario) {
            lista.sort((a, b) => {
                const aPrio = a.estado === estadoPrioritario ? 0 : 1;
                const bPrio = b.estado === estadoPrioritario ? 0 : 1;
                if (aPrio !== bPrio) return aPrio - bPrio;
                return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
            });
        }
        return lista;
    }, [ordenes, filtroEstado, filtroVehiculo, estadoPrioritario]);

    const abrirNuevaOrden = () => {
        setNuevoVehiculoId(vehiculos[0]?.id || '');
        setNuevoTipoServicio('correctivo');
        setNuevoTaller('');
        setNuevoMotivo('');
        setNuevoKm('');
        setErrorNuevaOrden('');
        setModalNuevaOrden(true);
    };

    const crearOrden = async () => {
        if (!nuevoVehiculoId) { setErrorNuevaOrden('Seleccione un vehículo'); return; }
        setCreando(true);
        setErrorNuevaOrden('');
        try {
            const orden = await MttoService.createOrden({
                vehiculo_id: nuevoVehiculoId,
                tipo_servicio: nuevoTipoServicio,
                taller: nuevoTaller || null,
                motivo: nuevoMotivo || null,
                kilometraje: nuevoKm ? Number(nuevoKm) : null,
            });
            navigate(`/mantenimiento/${orden.id}`);
        } catch (e: any) {
            setErrorNuevaOrden(e.message || 'Error al crear la orden');
        } finally {
            setCreando(false);
        }
    };

    const guardarPin = async () => {
        if (!/^\d{4,6}$/.test(pin)) { toast('El PIN debe tener entre 4 y 6 dígitos', 'error'); return; }
        if (pin !== pinConfirm) { toast('Los PIN no coinciden', 'error'); return; }
        setGuardandoPin(true);
        try {
            await MttoService.configurarPin(pin);
            toast('PIN configurado', 'success', 'Ya puede usarlo para firmar revisiones/aprobaciones desde otro dispositivo.');
            setModalPin(false);
            setPin('');
            setPinConfirm('');
        } catch (e: any) {
            toast('No se pudo configurar el PIN', 'error', e.message);
        } finally {
            setGuardandoPin(false);
        }
    };

    return (
        <div className="p-4 md:p-6 max-w-5xl mx-auto">
            <div className="flex items-start justify-between gap-3 mb-4">
                <div>
                    <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2">
                        <Wrench className="w-6 h-6 text-primary" />
                        Mantenimiento Vehicular
                    </h1>
                    <p className="text-sm text-muted-foreground mt-0.5">
                        Flota: {vehiculos.length} vehículo{vehiculos.length !== 1 ? 's' : ''}
                        {pendientesParaMi > 0 && (
                            <span className="ml-2 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
                                <AlertTriangle className="w-3.5 h-3.5" /> {pendientesParaMi} pendiente{pendientesParaMi !== 1 ? 's' : ''} de tu acción
                            </span>
                        )}
                    </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <button
                        onClick={() => setModalPin(true)}
                        title="Configurar mi PIN de firma"
                        className="flex items-center gap-2 bg-muted text-foreground px-3 py-3 rounded-xl font-semibold min-h-[44px]"
                    >
                        <KeyRound className="w-5 h-5" /> <span className="hidden sm:inline">Mi PIN</span>
                    </button>
                    {puedeCrear && (
                        <button
                            onClick={abrirNuevaOrden}
                            className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-3 rounded-xl font-semibold shadow-sm active:scale-95 transition-transform min-h-[44px]"
                        >
                            <Plus className="w-5 h-5" /> <span className="hidden sm:inline">Nueva Orden</span>
                        </button>
                    )}
                </div>
            </div>

            {/* Filtros */}
            <div className="mb-4">
                <button
                    onClick={() => setMostrarFiltros((v) => !v)}
                    className="flex items-center gap-2 text-sm font-medium text-muted-foreground mb-2 min-h-[44px]"
                >
                    <Filter className="w-4 h-4" /> Filtros {mostrarFiltros ? '▲' : '▼'}
                </button>
                {mostrarFiltros && (
                    <div className="flex flex-col sm:flex-row gap-2 mb-2">
                        <select
                            value={filtroEstado}
                            onChange={(e) => setFiltroEstado(e.target.value as any)}
                            className="border border-border rounded-lg px-3 py-2.5 bg-card text-sm min-h-[44px]"
                        >
                            <option value="todas">Todos los estados</option>
                            {Object.entries(ESTADO_LABEL).map(([k, v]) => (
                                <option key={k} value={k}>{v}</option>
                            ))}
                        </select>
                        <select
                            value={filtroVehiculo}
                            onChange={(e) => setFiltroVehiculo(e.target.value)}
                            className="border border-border rounded-lg px-3 py-2.5 bg-card text-sm min-h-[44px]"
                        >
                            <option value="">Todos los vehículos</option>
                            {vehiculos.map((v) => (
                                <option key={v.id} value={v.id}>{v.codigo}{v.placa ? ` — ${v.placa}` : ''}</option>
                            ))}
                        </select>
                    </div>
                )}
                {/* Pills rápidas de estado */}
                <div className="flex gap-2 overflow-x-auto pb-1">
                    {(['todas', 'borrador', 'en_revision', 'en_aprobacion', 'aprobada', 'en_ejecucion', 'cerrada'] as const).map((k) => (
                        <button
                            key={k}
                            onClick={() => setFiltroEstado(k)}
                            className={clsx(
                                'px-3 py-2 rounded-full text-xs font-semibold border whitespace-nowrap min-h-[36px]',
                                filtroEstado === k ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-muted-foreground'
                            )}
                        >
                            {k === 'todas' ? 'Todas' : ESTADO_LABEL[k]}
                        </button>
                    ))}
                </div>
            </div>

            {loading ? (
                <div className="flex items-center justify-center py-16 text-muted-foreground">
                    <Loader2 className="w-6 h-6 animate-spin mr-2" /> Cargando órdenes...
                </div>
            ) : ordenesFiltradas.length === 0 ? (
                <div className="text-center py-16 text-muted-foreground border border-dashed border-border rounded-xl">
                    <Wrench className="w-10 h-10 mx-auto mb-2 opacity-40" />
                    No hay órdenes que coincidan con el filtro.
                </div>
            ) : (
                <div className="space-y-2">
                    {ordenesFiltradas.map((o) => {
                        const r = resumenes[o.id];
                        const critico = r?.tiene_critico_malo;
                        return (
                            <button
                                key={o.id}
                                onClick={() => navigate(`/mantenimiento/${o.id}`)}
                                className={clsx(
                                    'w-full text-left bg-card border rounded-xl p-4 flex items-center gap-3 hover:border-primary/50 transition-colors min-h-[44px]',
                                    critico ? 'border-red-500/50' : 'border-border'
                                )}
                            >
                                <div className="w-11 h-11 rounded-lg bg-muted flex items-center justify-center shrink-0">
                                    <Truck className="w-5 h-5 text-muted-foreground" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="font-bold text-sm">{o.numero || 'Sin número'}</span>
                                        <span className={clsx('text-[11px] font-semibold px-2 py-0.5 rounded-full border', ESTADO_COLOR[o.estado])}>
                                            {ESTADO_LABEL[o.estado]}
                                        </span>
                                        {critico && (
                                            <span className="text-[11px] font-bold text-red-600 dark:text-red-400 flex items-center gap-1">
                                                <AlertTriangle className="w-3 h-3" /> Crítico
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-sm text-muted-foreground truncate">
                                        {o.vehiculo?.codigo}{o.vehiculo?.placa ? ` (${o.vehiculo.placa})` : ''} · {TIPO_SERVICIO_LABEL[o.tipo_servicio]} · {new Date(o.fecha).toLocaleDateString('es-CO')}
                                    </div>
                                    {r && (
                                        <div className="flex gap-2 mt-1 text-[11px] font-medium">
                                            {r.regular > 0 && <span className="text-amber-600 dark:text-amber-400">{r.regular} R</span>}
                                            {r.malo > 0 && <span className="text-red-600 dark:text-red-400">{r.malo} M</span>}
                                            {r.no_aplica > 0 && <span className="text-muted-foreground">{r.no_aplica} N/A</span>}
                                        </div>
                                    )}
                                </div>
                                <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
                            </button>
                        );
                    })}
                </div>
            )}

            {/* Modal Nueva Orden */}
            {modalNuevaOrden && (
                <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/60" onClick={() => !creando && setModalNuevaOrden(false)} />
                    <div className="relative w-full max-w-md bg-card border border-border rounded-xl shadow-2xl flex flex-col max-h-[90vh]">
                        <div className="flex items-center justify-between p-4 border-b border-border">
                            <h3 className="font-bold text-lg">Nueva orden de trabajo</h3>
                            <button onClick={() => setModalNuevaOrden(false)} className="p-2 hover:bg-muted rounded-full min-h-[44px] min-w-[44px]">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-3">
                            <div>
                                <label className="text-sm font-medium block mb-1">Vehículo *</label>
                                <select
                                    value={nuevoVehiculoId}
                                    onChange={(e) => setNuevoVehiculoId(e.target.value)}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]"
                                >
                                    {vehiculos.map((v) => (
                                        <option key={v.id} value={v.id}>{v.codigo} — {v.tipo === 'motocarro' ? 'Motocarro' : 'Moto con tráiler'}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="text-sm font-medium block mb-1">Tipo de servicio *</label>
                                <select
                                    value={nuevoTipoServicio}
                                    onChange={(e) => setNuevoTipoServicio(e.target.value as any)}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]"
                                >
                                    {Object.entries(TIPO_SERVICIO_LABEL).map(([k, v]) => (
                                        <option key={k} value={k}>{v}</option>
                                    ))}
                                </select>
                            </div>
                            <div>
                                <label className="text-sm font-medium block mb-1">Kilometraje</label>
                                <input
                                    type="number"
                                    value={nuevoKm}
                                    onChange={(e) => setNuevoKm(e.target.value)}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]"
                                    placeholder="Ej: 12500"
                                />
                            </div>
                            <div>
                                <label className="text-sm font-medium block mb-1">Taller</label>
                                <input
                                    value={nuevoTaller}
                                    onChange={(e) => setNuevoTaller(e.target.value)}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]"
                                    placeholder="Nombre del taller"
                                />
                            </div>
                            <div>
                                <label className="text-sm font-medium block mb-1">Motivo del ingreso</label>
                                <textarea
                                    value={nuevoMotivo}
                                    onChange={(e) => setNuevoMotivo(e.target.value)}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[80px]"
                                    placeholder="Ej: Revisión periódica, ruido en motor, etc."
                                />
                            </div>
                            {errorNuevaOrden && <p className="text-sm text-destructive">{errorNuevaOrden}</p>}
                        </div>
                        <div className="p-4 border-t border-border">
                            <button
                                onClick={crearOrden}
                                disabled={creando}
                                className="w-full bg-primary text-primary-foreground py-3 rounded-xl font-semibold min-h-[44px] flex items-center justify-center gap-2 disabled:opacity-60"
                            >
                                {creando && <Loader2 className="w-4 h-4 animate-spin" />}
                                Crear orden en borrador
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Modal Configurar mi PIN */}
            {modalPin && (
                <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4">
                    <div className="absolute inset-0 bg-black/60" onClick={() => !guardandoPin && setModalPin(false)} />
                    <div className="relative w-full max-w-sm bg-card border border-border rounded-xl shadow-2xl flex flex-col">
                        <div className="flex items-center justify-between p-4 border-b border-border">
                            <h3 className="font-bold text-lg flex items-center gap-2"><KeyRound className="w-5 h-5" /> Configurar mi PIN</h3>
                            <button onClick={() => setModalPin(false)} className="p-2 hover:bg-muted rounded-full min-h-[44px] min-w-[44px]">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        <div className="p-4 space-y-3">
                            <p className="text-sm text-muted-foreground">
                                Sirve para revisar o aprobar órdenes desde el teléfono de otra persona (ej. el mecánico) sin tener que loguearse con correo y clave. Nadie más lo ve — quedará ligado a su cuenta.
                            </p>
                            <div>
                                <label className="text-sm font-medium block mb-1">PIN (4 a 6 dígitos)</label>
                                <input
                                    type="password" inputMode="numeric" pattern="[0-9]*" maxLength={6}
                                    value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px] tracking-widest text-center text-lg"
                                />
                            </div>
                            <div>
                                <label className="text-sm font-medium block mb-1">Confirmar PIN</label>
                                <input
                                    type="password" inputMode="numeric" pattern="[0-9]*" maxLength={6}
                                    value={pinConfirm} onChange={(e) => setPinConfirm(e.target.value.replace(/\D/g, ''))}
                                    className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px] tracking-widest text-center text-lg"
                                />
                            </div>
                        </div>
                        <div className="p-4 border-t border-border">
                            <button
                                onClick={guardarPin}
                                disabled={guardandoPin}
                                className="w-full bg-primary text-primary-foreground py-3 rounded-xl font-semibold min-h-[44px] flex items-center justify-center gap-2 disabled:opacity-60"
                            >
                                {guardandoPin && <Loader2 className="w-4 h-4 animate-spin" />}
                                Guardar PIN
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
