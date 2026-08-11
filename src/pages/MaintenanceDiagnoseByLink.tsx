import { useState, useEffect, useRef, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import {
    Loader2, AlertTriangle, Wrench, CheckCircle2, KeyRound, Camera, ChevronDown,
    Plus, Trash2, Search, X, Send,
} from 'lucide-react';
import clsx from 'clsx';
import { MttoService } from '../lib/mttoService';
import { money, TIPO_SERVICIO_LABEL, fechaVencimiento } from '../lib/mttoLabels';

/**
 * Pantalla PÚBLICA de diagnóstico por enlace. La usa el mecánico, que no
 * tiene cuenta: abre el enlace que le mandaron por WhatsApp, marca los ítems
 * que no están bien, toma fotos, cotiza y envía con su PIN.
 *
 * Todo se guarda en UNA sola llamada al final, para validar el PIN una vez y
 * que las validaciones duras corran juntas del lado del servidor. Mientras
 * tanto el borrador vive en localStorage, para que no se pierda si se cierra
 * el navegador o se va la señal.
 */

type EstadoItem = 'B' | 'R' | 'M' | 'NA';
type Marca = { estado: EstadoItem; observacion: string; fotos: string[] };
type Linea = {
    key: string; arreglo_id: string; descripcion: string; sistema: string; repuesto: string;
    cantidad: number; valor_unitario: number; mano_obra: number; prioridad: string; fotos: string[];
};

export function MaintenanceDiagnoseByLink() {
    const { token } = useParams<{ token: string }>();
    const [loading, setLoading] = useState(true);
    const [datos, setDatos] = useState<any>(null);
    const [error, setError] = useState('');
    const [listo, setListo] = useState(false);

    const [marcas, setMarcas] = useState<Record<string, Marca>>({});
    const [lineas, setLineas] = useState<Linea[]>([]);
    const [diagnostico, setDiagnostico] = useState('');
    const [kilometraje, setKilometraje] = useState('');
    const [ivaTasa, setIvaTasa] = useState(0.19);
    const [pin, setPin] = useState('');
    const [enviando, setEnviando] = useState(false);
    const [paso, setPaso] = useState<'inspeccion' | 'cotizacion' | 'enviar'>('inspeccion');

    const claveBorrador = `mtto_diag_${token}`;

    useEffect(() => {
        if (!token) return;
        (async () => {
            try {
                const d = await MttoService.verDiagnosticoPorToken(token);
                setDatos(d);
                setKilometraje(d?.orden?.kilometraje?.toString() || '');
                setDiagnostico(d?.orden?.diagnostico || '');
                setIvaTasa(Number(d?.orden?.iva_tasa ?? 0.19));

                const guardado = localStorage.getItem(claveBorrador);
                if (guardado) {
                    const b = JSON.parse(guardado);
                    setMarcas(b.marcas || {});
                    setLineas(b.lineas || []);
                    if (b.diagnostico) setDiagnostico(b.diagnostico);
                    if (b.kilometraje) setKilometraje(b.kilometraje);
                }
            } catch (e: any) {
                setError(e.message || 'No se pudo abrir el enlace');
            } finally {
                setLoading(false);
            }
        })();
    }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

    // Autoguardado local
    useEffect(() => {
        if (loading || !datos) return;
        localStorage.setItem(claveBorrador, JSON.stringify({ marcas, lineas, diagnostico, kilometraje }));
    }, [marcas, lineas, diagnostico, kilometraje]); // eslint-disable-line react-hooks/exhaustive-deps

    const secciones = datos?.secciones || [];
    const totalItems = useMemo(
        () => secciones.reduce((a: number, s: any) => a + (s.items?.length || 0), 0),
        [secciones]
    );

    const noBuenos = Object.entries(marcas).filter(([, m]) => m.estado !== 'B');
    const enR = noBuenos.filter(([, m]) => m.estado === 'R').length;
    const enM = noBuenos.filter(([, m]) => m.estado === 'M').length;
    const enNA = noBuenos.filter(([, m]) => m.estado === 'NA').length;

    const subtotal = lineas.reduce((a, l) => a + l.cantidad * l.valor_unitario + l.mano_obra, 0);
    const total = Math.round(subtotal * (1 + ivaTasa));

    // Problemas que bloquean el envío, mostrados antes de intentar
    const problemas = useMemo(() => {
        const p: string[] = [];
        for (const [itemId, m] of noBuenos) {
            const nombre = secciones.flatMap((s: any) => s.items).find((i: any) => i.id === itemId)?.nombre || 'Ítem';
            if ((m.estado === 'R' || m.estado === 'M') && !m.observacion.trim()) p.push(`"${nombre}" está en ${m.estado} y le falta la observación`);
            if (m.estado === 'M' && m.fotos.length === 0) p.push(`"${nombre}" está en M y le falta la foto`);
        }
        if (enM > 0 && lineas.length === 0) p.push('Hay ítems en M pero no ha cotizado ninguna reparación');
        return p;
    }, [noBuenos, lineas, enM, secciones]);

    const enviar = async () => {
        if (!/^\d{4,6}$/.test(pin)) { setError('Escriba su PIN'); return; }
        setEnviando(true);
        setError('');
        try {
            await MttoService.guardarDiagnosticoPorToken(token!, pin, {
                hallazgos: noBuenos.map(([item_id, m]) => ({
                    item_id, estado: m.estado, observacion: m.observacion, fotos: m.fotos,
                })),
                reparaciones: lineas.map((l) => ({
                    arreglo_id: l.arreglo_id || null, descripcion: l.descripcion, sistema: l.sistema,
                    repuesto: l.repuesto, cantidad: l.cantidad, valor_unitario: l.valor_unitario,
                    mano_obra: l.mano_obra, prioridad: l.prioridad, fotos: l.fotos,
                })),
                diagnostico,
                kilometraje: kilometraje ? Number(kilometraje) : null,
                ivaTasa,
            });
            localStorage.removeItem(claveBorrador);
            setListo(true);
        } catch (e: any) {
            setError(e.message || 'No se pudo enviar');
        } finally {
            setEnviando(false);
        }
    };

    if (loading) return <Marco><div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mr-2" /> Abriendo...</div></Marco>;

    if (!datos) return (
        <Marco>
            <div className="text-center py-12">
                <AlertTriangle className="w-12 h-12 mx-auto mb-3 text-amber-500" />
                <h2 className="font-bold text-lg mb-1">No se pudo abrir el enlace</h2>
                <p className="text-sm text-muted-foreground">{error}</p>
            </div>
        </Marco>
    );

    if (listo) return (
        <Marco>
            <div className="text-center py-12">
                <CheckCircle2 className="w-14 h-14 mx-auto mb-3 text-emerald-500" />
                <h2 className="font-bold text-xl mb-1">Diagnóstico enviado</h2>
                <p className="text-sm text-muted-foreground">
                    Gracias. La orden quedó lista para aprobación. Ya puede cerrar esta página.
                </p>
            </div>
        </Marco>
    );

    const { orden, vehiculo, mecanico } = datos;

    return (
        <Marco>
            <div className="mb-3">
                <h1 className="text-lg font-bold">Diagnóstico del vehículo</h1>
                <p className="text-sm text-muted-foreground">
                    {orden.numero} · {vehiculo.codigo}{vehiculo.placa ? ` (${vehiculo.placa})` : ''} · {TIPO_SERVICIO_LABEL[orden.tipo_servicio]}
                </p>
                {mecanico?.nombre && <p className="text-xs text-muted-foreground mt-0.5">Diligencia: {mecanico.nombre}</p>}
                {orden.motivo && <p className="text-sm mt-2 bg-muted/50 rounded-lg p-2">Motivo: {orden.motivo}</p>}
            </div>

            {/* Pasos */}
            <div className="flex gap-1 mb-3 overflow-x-auto">
                {([['inspeccion', '1. Inspección'], ['cotizacion', '2. Cotización'], ['enviar', '3. Enviar']] as const).map(([k, l]) => (
                    <button key={k} onClick={() => setPaso(k)}
                        className={clsx('px-3 py-2.5 rounded-lg text-sm font-semibold whitespace-nowrap min-h-[44px]',
                            paso === k ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted')}>
                        {l}
                    </button>
                ))}
            </div>

            {paso === 'inspeccion' && (
                <>
                    <div className="grid grid-cols-4 gap-2 text-center mb-3">
                        <Contador label="Bueno" valor={totalItems - noBuenos.length} color="text-emerald-600" />
                        <Contador label="Regular" valor={enR} color="text-amber-600" />
                        <Contador label="Malo" valor={enM} color="text-red-600" />
                        <Contador label="N/A" valor={enNA} color="text-muted-foreground" />
                    </div>
                    <p className="text-xs text-muted-foreground mb-3">
                        Todo arranca en <strong>Bueno</strong>. Marque solo lo que esté mal.
                    </p>
                    <div className="space-y-2">
                        {secciones.map((s: any) => (
                            <Seccion key={s.id} seccion={s} marcas={marcas} setMarcas={setMarcas} ordenId={orden.id} />
                        ))}
                    </div>
                </>
            )}

            {paso === 'cotizacion' && (
                <Cotizacion
                    lineas={lineas} setLineas={setLineas} catalogo={datos.catalogo || []}
                    ordenId={orden.id} ivaTasa={ivaTasa} setIvaTasa={setIvaTasa}
                    subtotal={subtotal} total={total}
                    marcasEnM={noBuenos.filter(([, m]) => m.estado === 'M')}
                    secciones={secciones}
                />
            )}

            {paso === 'enviar' && (
                <div className="space-y-3">
                    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                        <div>
                            <label className="text-sm font-medium block mb-1">Kilometraje</label>
                            <input type="number" value={kilometraje} onChange={(e) => setKilometraje(e.target.value)}
                                className="w-full border border-border rounded-lg px-3 py-2.5 bg-background min-h-[44px]" />
                        </div>
                        <div>
                            <label className="text-sm font-medium block mb-1">Diagnóstico general</label>
                            <textarea value={diagnostico} onChange={(e) => setDiagnostico(e.target.value)}
                                className="w-full border border-border rounded-lg px-3 py-2 bg-background min-h-[80px] text-sm"
                                placeholder="Resumen de lo que encontró" />
                        </div>
                    </div>

                    <div className="bg-card border border-border rounded-xl p-4 text-sm space-y-1">
                        <div className="flex justify-between"><span className="text-muted-foreground">Ítems en regular</span><span>{enR}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Ítems en malo</span><span>{enM}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Reparaciones cotizadas</span><span>{lineas.length}</span></div>
                        <div className="flex justify-between font-bold pt-2 border-t border-border mt-2">
                            <span>TOTAL COTIZADO</span><span className="text-primary text-lg">{money(total)}</span>
                        </div>
                    </div>

                    {problemas.length > 0 && (
                        <div className="bg-red-500/10 border border-red-500/40 rounded-xl p-3">
                            <p className="font-semibold text-sm text-red-700 dark:text-red-400 mb-1">Falta corregir antes de enviar:</p>
                            <ul className="text-sm text-red-700 dark:text-red-400 list-disc pl-5 space-y-0.5">
                                {problemas.map((p, i) => <li key={i}>{p}</li>)}
                            </ul>
                        </div>
                    )}

                    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
                        <label className="text-sm font-medium flex items-center gap-1.5">
                            <KeyRound className="w-4 h-4" /> Su PIN
                        </label>
                        <input type="password" inputMode="numeric" maxLength={6} value={pin}
                            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••"
                            className="w-full border border-border rounded-lg px-3 py-3 bg-background min-h-[48px] tracking-widest text-center text-xl" />
                        {error && <p className="text-sm text-destructive">{error}</p>}
                        <button onClick={enviar} disabled={enviando || pin.length < 4 || problemas.length > 0}
                            className="w-full bg-primary text-primary-foreground py-4 rounded-xl font-bold min-h-[52px] flex items-center justify-center gap-2 disabled:opacity-60">
                            {enviando ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                            Enviar diagnóstico
                        </button>
                    </div>
                </div>
            )}

            <p className="text-xs text-muted-foreground text-center py-6">
                Su avance se guarda solo en este teléfono hasta que envíe.
                {fechaVencimiento(datos.expira_at)
                    ? ` El enlace vence el ${fechaVencimiento(datos.expira_at)!.toLocaleString('es-CO')}.`
                    : ' El enlace no tiene fecha de vencimiento.'}
            </p>
        </Marco>
    );
}

// ── Sección del checklist ─────────────────────────────────────────────
function Seccion({ seccion, marcas, setMarcas, ordenId }: any) {
    const [abierto, setAbierto] = useState(false);
    const items = seccion.items || [];
    const r = items.filter((i: any) => marcas[i.id]?.estado === 'R').length;
    const m = items.filter((i: any) => marcas[i.id]?.estado === 'M').length;
    const limpio = r === 0 && m === 0;

    return (
        <div className="bg-card border border-border rounded-xl overflow-hidden">
            <button onClick={() => setAbierto(!abierto)} className="w-full flex items-center justify-between p-3 min-h-[44px]">
                <div className="flex items-center gap-2 text-left">
                    <span className={clsx('w-2.5 h-2.5 rounded-full shrink-0', limpio ? 'bg-emerald-500' : m > 0 ? 'bg-red-500' : 'bg-amber-500')} />
                    <span className="font-semibold text-sm">{seccion.nombre}</span>
                </div>
                <div className="flex items-center gap-2">
                    {!limpio && <span className="text-[11px] font-semibold text-muted-foreground">{r > 0 && `${r} R `}{m > 0 && `${m} M`}</span>}
                    <ChevronDown className={clsx('w-4 h-4 transition-transform', abierto && 'rotate-180')} />
                </div>
            </button>
            {abierto && (
                <div className="border-t border-border divide-y divide-border">
                    {items.map((item: any) => (
                        <Item key={item.id} item={item} marcas={marcas} setMarcas={setMarcas} ordenId={ordenId} />
                    ))}
                </div>
            )}
        </div>
    );
}

const BOTONES: { k: EstadoItem; label: string; activo: string }[] = [
    { k: 'B', label: 'B', activo: 'bg-emerald-500 text-white border-emerald-500' },
    { k: 'R', label: 'R', activo: 'bg-amber-500 text-white border-amber-500' },
    { k: 'M', label: 'M', activo: 'bg-red-500 text-white border-red-500' },
    { k: 'NA', label: 'N/A', activo: 'bg-slate-500 text-white border-slate-500' },
];

function Item({ item, marcas, setMarcas, ordenId }: any) {
    const marca: Marca = marcas[item.id] || { estado: 'B', observacion: '', fotos: [] };
    const [subiendo, setSubiendo] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const set = (patch: Partial<Marca>) =>
        setMarcas((prev: any) => ({ ...prev, [item.id]: { ...marca, ...patch } }));

    const cambiar = (estado: EstadoItem) => {
        if (estado === 'B') {
            setMarcas((prev: any) => { const n = { ...prev }; delete n[item.id]; return n; });
        } else {
            set({ estado });
        }
    };

    const subir = async (file: File) => {
        setSubiendo(true);
        try {
            const path = await MttoService.subirFotoDiagnostico(ordenId, file);
            set({ fotos: [...marca.fotos, path] });
        } catch (e: any) {
            alert('No se pudo subir la foto: ' + e.message);
        } finally { setSubiendo(false); }
    };

    const necesitaObs = marca.estado === 'R' || marca.estado === 'M';

    return (
        <div className="p-3">
            <div className="flex items-center justify-between gap-2">
                <div className="text-sm flex-1">
                    {item.nombre}
                    {item.critico && <span className="ml-1.5 text-[10px] font-bold text-red-600">CRÍTICO</span>}
                </div>
                <div className="flex gap-1 shrink-0">
                    {BOTONES.map((b) => (
                        <button key={b.k} onClick={() => cambiar(b.k)}
                            className={clsx('w-11 h-11 rounded-lg border text-xs font-bold flex items-center justify-center',
                                marca.estado === b.k ? b.activo : 'bg-background border-border text-muted-foreground')}>
                            {b.label}
                        </button>
                    ))}
                </div>
            </div>

            {necesitaObs && (
                <div className="mt-2 space-y-2">
                    <textarea value={marca.observacion} onChange={(e) => set({ observacion: e.target.value })}
                        placeholder="¿Qué encontró? (obligatorio)"
                        className={clsx('w-full border rounded-lg px-3 py-2 text-sm bg-background min-h-[60px]',
                            !marca.observacion.trim() ? 'border-red-500/60' : 'border-border')} />
                    <div className="flex items-center gap-2 flex-wrap">
                        {marca.fotos.map((p) => (
                            <div key={p} className="w-14 h-14 rounded-lg border border-border bg-emerald-500/10 flex items-center justify-center relative">
                                <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                                <button onClick={() => set({ fotos: marca.fotos.filter((x) => x !== p) })}
                                    className="absolute -top-1.5 -right-1.5 bg-destructive text-destructive-foreground rounded-full w-5 h-5 flex items-center justify-center">
                                    <X className="w-3 h-3" />
                                </button>
                            </div>
                        ))}
                        <button onClick={() => inputRef.current?.click()} disabled={subiendo}
                            className={clsx('w-14 h-14 rounded-lg border-2 border-dashed flex items-center justify-center min-h-[44px]',
                                marca.estado === 'M' && marca.fotos.length === 0 ? 'border-red-500/60 text-red-600' : 'border-border text-muted-foreground')}>
                            {subiendo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-5 h-5" />}
                        </button>
                        <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden"
                            onChange={(e) => { const f = e.target.files?.[0]; if (f) subir(f); e.target.value = ''; }} />
                    </div>
                    {marca.estado === 'M' && marca.fotos.length === 0 && (
                        <p className="text-xs text-red-600">Los ítems en M necesitan al menos una foto.</p>
                    )}
                </div>
            )}
        </div>
    );
}

// ── Cotización ────────────────────────────────────────────────────────
function Cotizacion({ lineas, setLineas, catalogo, ordenId, ivaTasa, setIvaTasa, subtotal, total, marcasEnM, secciones }: any) {
    const nueva = (desc = 'Nueva reparación') => setLineas((p: Linea[]) => [...p, {
        key: crypto.randomUUID(), arreglo_id: '', descripcion: desc, sistema: '', repuesto: '',
        cantidad: 1, valor_unitario: 0, mano_obra: 0, prioridad: 'media', fotos: [],
    }]);

    const traerMalos = () => {
        const nombres = marcasEnM.map(([id]: any) =>
            secciones.flatMap((s: any) => s.items).find((i: any) => i.id === id)?.nombre || 'Reparación');
        const faltantes = nombres.filter((n: string) => !lineas.some((l: Linea) => l.descripcion === n));
        setLineas((p: Linea[]) => [...p, ...faltantes.map((n: string) => ({
            key: crypto.randomUUID(), arreglo_id: '', descripcion: n, sistema: '', repuesto: '',
            cantidad: 1, valor_unitario: 0, mano_obra: 0, prioridad: 'media', fotos: [],
        }))]);
    };

    return (
        <div className="space-y-3">
            <div className="flex gap-2">
                <button onClick={() => nueva()} className="flex items-center gap-1.5 bg-primary text-primary-foreground px-3 py-2.5 rounded-lg text-sm font-semibold min-h-[44px]">
                    <Plus className="w-4 h-4" /> Agregar
                </button>
                {marcasEnM.length > 0 && (
                    <button onClick={traerMalos} className="flex items-center gap-1.5 bg-muted px-3 py-2.5 rounded-lg text-sm font-semibold min-h-[44px]">
                        <AlertTriangle className="w-4 h-4" /> Traer ítems en M
                    </button>
                )}
            </div>

            {lineas.length === 0 && <p className="text-sm text-muted-foreground text-center py-6">Sin reparaciones cotizadas.</p>}

            {lineas.map((l: Linea) => (
                <LineaCard key={l.key} linea={l} setLineas={setLineas} catalogo={catalogo} ordenId={ordenId} />
            ))}

            <div className="bg-card border border-border rounded-xl p-4 text-sm space-y-1.5">
                <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>{money(subtotal)}</span></div>
                <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">IVA</span>
                    <select value={ivaTasa} onChange={(e) => setIvaTasa(Number(e.target.value))}
                        className="border border-border rounded-lg px-2 py-1.5 bg-background text-sm min-h-[36px]">
                        <option value={0}>0%</option><option value={0.05}>5%</option><option value={0.19}>19%</option>
                    </select>
                </div>
                <div className="flex justify-between font-bold pt-2 border-t border-border">
                    <span>TOTAL</span><span className="text-primary text-lg">{money(total)}</span>
                </div>
            </div>
        </div>
    );
}

function LineaCard({ linea, setLineas, catalogo, ordenId }: any) {
    const [buscador, setBuscador] = useState(false);
    const [q, setQ] = useState('');
    const [subiendo, setSubiendo] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const set = (patch: Partial<Linea>) =>
        setLineas((p: Linea[]) => p.map((x) => x.key === linea.key ? { ...x, ...patch } : x));
    const borrar = () => setLineas((p: Linea[]) => p.filter((x) => x.key !== linea.key));

    const subir = async (file: File) => {
        setSubiendo(true);
        try {
            const path = await MttoService.subirFotoDiagnostico(ordenId, file);
            set({ fotos: [...linea.fotos, path] });
        } catch (e: any) {
            alert('No se pudo subir la foto: ' + e.message);
        } finally { setSubiendo(false); }
    };

    const grupos = catalogo
        .map((s: any) => ({ sistema: s.sistema, arreglos: s.arreglos.filter((a: any) => !q || a.nombre.toLowerCase().includes(q.toLowerCase())) }))
        .filter((g: any) => g.arreglos.length > 0);

    const total = linea.cantidad * linea.valor_unitario + linea.mano_obra;

    return (
        <div className="bg-card border border-border rounded-xl p-3 space-y-2">
            <div className="flex items-start gap-2">
                <div className="flex-1 relative">
                    <button onClick={() => setBuscador(!buscador)}
                        className="w-full text-left text-sm font-medium border border-border rounded-lg px-3 py-2 bg-background flex items-center justify-between gap-2 min-h-[44px]">
                        <span className="truncate">{linea.descripcion}</span>
                        <Search className="w-4 h-4 text-muted-foreground shrink-0" />
                    </button>
                    {buscador && (
                        <div className="absolute z-20 mt-1 w-full bg-popover border border-border rounded-xl shadow-2xl max-h-72 overflow-hidden flex flex-col">
                            <div className="p-2 border-b border-border flex items-center gap-2">
                                <Search className="w-4 h-4 text-muted-foreground" />
                                <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar arreglo..."
                                    className="flex-1 bg-transparent text-sm outline-none py-2" />
                                <button onClick={() => setBuscador(false)}><X className="w-4 h-4" /></button>
                            </div>
                            <div className="overflow-y-auto">
                                {grupos.map((g: any) => (
                                    <div key={g.sistema}>
                                        <div className="px-3 py-1.5 text-[11px] font-bold uppercase text-muted-foreground bg-muted/50">{g.sistema}</div>
                                        {g.arreglos.map((a: any) => (
                                            <button key={a.id} onClick={() => {
                                                set({
                                                    arreglo_id: a.id, descripcion: a.nombre, sistema: g.sistema,
                                                    valor_unitario: a.precio_repuesto_ref ?? linea.valor_unitario,
                                                    mano_obra: a.precio_mo_ref ?? linea.mano_obra,
                                                });
                                                setBuscador(false);
                                            }} className="w-full text-left px-3 py-2.5 text-sm hover:bg-muted min-h-[44px]">
                                                {a.nombre}
                                            </button>
                                        ))}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
                <button onClick={borrar} className="p-2.5 text-muted-foreground min-h-[44px] min-w-[44px]"><Trash2 className="w-4 h-4" /></button>
            </div>

            <div className="grid grid-cols-2 gap-2">
                <Campo label="Repuesto / ref">
                    <input value={linea.repuesto} onChange={(e) => set({ repuesto: e.target.value })}
                        className="w-full border border-border rounded-lg px-2 py-2 bg-background text-sm min-h-[40px]" />
                </Campo>
                <Campo label="Prioridad">
                    <select value={linea.prioridad} onChange={(e) => set({ prioridad: e.target.value })}
                        className="w-full border border-border rounded-lg px-2 py-2 bg-background text-sm min-h-[40px]">
                        <option value="alta">Alta</option><option value="media">Media</option><option value="baja">Baja</option>
                    </select>
                </Campo>
                <Campo label="Cantidad">
                    <input type="number" value={linea.cantidad} onChange={(e) => set({ cantidad: Number(e.target.value) || 0 })}
                        className="w-full border border-border rounded-lg px-2 py-2 bg-background text-sm min-h-[40px]" />
                </Campo>
                <Campo label="Valor unitario">
                    <input type="number" value={linea.valor_unitario} onChange={(e) => set({ valor_unitario: Number(e.target.value) || 0 })}
                        className="w-full border border-border rounded-lg px-2 py-2 bg-background text-sm min-h-[40px]" />
                </Campo>
                <Campo label="Mano de obra">
                    <input type="number" value={linea.mano_obra} onChange={(e) => set({ mano_obra: Number(e.target.value) || 0 })}
                        className="w-full border border-border rounded-lg px-2 py-2 bg-background text-sm min-h-[40px]" />
                </Campo>
                <Campo label="Total línea">
                    <div className="font-bold text-sm py-2">{money(total)}</div>
                </Campo>
            </div>

            <div className="pt-2 border-t border-border/60">
                <div className="text-[11px] text-muted-foreground mb-1">Fotos del repuesto (opcional)</div>
                <div className="flex items-center gap-2 flex-wrap">
                    {linea.fotos.map((p: string) => (
                        <div key={p} className="w-14 h-14 rounded-lg border border-border bg-emerald-500/10 flex items-center justify-center relative">
                            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                            <button onClick={() => set({ fotos: linea.fotos.filter((x: string) => x !== p) })}
                                className="absolute -top-1.5 -right-1.5 bg-destructive text-destructive-foreground rounded-full w-5 h-5 flex items-center justify-center">
                                <X className="w-3 h-3" />
                            </button>
                        </div>
                    ))}
                    <button onClick={() => inputRef.current?.click()} disabled={subiendo}
                        className="w-14 h-14 rounded-lg border-2 border-dashed border-border text-muted-foreground flex items-center justify-center min-h-[44px]">
                        {subiendo ? <Loader2 className="w-4 h-4 animate-spin" /> : <Camera className="w-5 h-5" />}
                    </button>
                    <input ref={inputRef} type="file" accept="image/*" capture="environment" className="hidden"
                        onChange={(e) => { const f = e.target.files?.[0]; if (f) subir(f); e.target.value = ''; }} />
                </div>
            </div>
        </div>
    );
}

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
    return <div><div className="text-[11px] text-muted-foreground mb-0.5">{label}</div>{children}</div>;
}

function Contador({ label, valor, color }: { label: string; valor: number; color: string }) {
    return (
        <div className="bg-card border border-border rounded-lg p-2">
            <div className={clsx('text-lg font-bold', color)}>{valor}</div>
            <div className="text-[10px] text-muted-foreground uppercase">{label}</div>
        </div>
    );
}

function Marco({ children }: { children: React.ReactNode }) {
    return (
        <div className="min-h-screen bg-background text-foreground">
            <div className="max-w-2xl mx-auto p-4">
                <div className="flex items-center gap-2 py-3 mb-2 border-b border-border">
                    <Wrench className="w-5 h-5 text-primary" />
                    <span className="font-bold">RAPILINK S.A.S. — Mantenimiento Vehicular</span>
                </div>
                {children}
            </div>
        </div>
    );
}
