import { useState, useEffect, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Printer, Loader2, ArrowLeft } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
    MttoService,
    type MttoOrden, type MttoVehiculo, type MttoOrdenHallazgo, type MttoOrdenFoto,
    type MttoOrdenReparacion, type ChecklistSeccionConItems, type MttoOrdenTotal, type MttoOrdenEvento,
} from '../lib/mttoService';
import { ESTADO_LABEL, TIPO_SERVICIO_LABEL, EVENTO_LABEL, money } from '../lib/mttoLabels';

type OrdenConVehiculo = MttoOrden & { vehiculo?: MttoVehiculo };
type HallazgoConFotos = MttoOrdenHallazgo & { fotos?: MttoOrdenFoto[] };
type Firmante = { full_name: string | null } | null;

export function MaintenanceOrderPrint() {
    const { id } = useParams<{ id: string }>();
    const [loading, setLoading] = useState(true);
    const [orden, setOrden] = useState<OrdenConVehiculo | null>(null);
    const [checklist, setChecklist] = useState<ChecklistSeccionConItems[]>([]);
    const [hallazgos, setHallazgos] = useState<HallazgoConFotos[]>([]);
    const [reparaciones, setReparaciones] = useState<MttoOrdenReparacion[]>([]);
    const [totales, setTotales] = useState<MttoOrdenTotal | null>(null);
    const [eventos, setEventos] = useState<(MttoOrdenEvento & { usuario?: Firmante })[]>([]);
    const [firmantes, setFirmantes] = useState<Record<string, Firmante>>({});
    const [fotoUrls, setFotoUrls] = useState<Record<string, string>>({});

    useEffect(() => {
        if (!id) return;
        (async () => {
            setLoading(true);
            try {
                const ordenData = await MttoService.getOrden(id);
                setOrden(ordenData);
                if (!ordenData || !ordenData.vehiculo) return;

                const [checklistData, hallazgosData, reparacionesData, totalesData, eventosData] = await Promise.all([
                    MttoService.getChecklist(ordenData.vehiculo.tipo),
                    MttoService.listHallazgos(id),
                    MttoService.listReparaciones(id),
                    MttoService.getTotales(id),
                    MttoService.listEventos(id),
                ]);
                setChecklist(checklistData);
                setHallazgos(hallazgosData);
                setReparaciones(reparacionesData);
                setTotales(totalesData);
                setEventos(eventosData);

                const ids = [ordenData.creado_por, ordenData.revisado_por, ordenData.aprobado_por].filter(Boolean) as string[];
                if (ids.length > 0) {
                    const { data: perfiles } = await supabase.from('profiles').select('id, full_name').in('id', ids);
                    setFirmantes(Object.fromEntries((perfiles || []).map((p: any) => [p.id, { full_name: p.full_name }])));
                }

                // Precarga las URLs firmadas de todas las fotos para que la vista de impresión no quede con miniaturas vacías.
                const todasLasFotos = hallazgosData.flatMap((h) => h.fotos || []);
                const urls = await Promise.all(todasLasFotos.map(async (f) => [f.id, await MttoService.getFotoUrl(f.path).catch(() => '')] as const));
                setFotoUrls(Object.fromEntries(urls));
            } finally {
                setLoading(false);
            }
        })();
    }, [id]);

    const itemInfo = useMemo(() => {
        const map = new Map<string, { nombre: string; seccion: string; critico: boolean }>();
        for (const s of checklist) for (const i of s.items) map.set(i.id, { nombre: i.nombre, seccion: s.nombre, critico: i.critico });
        return map;
    }, [checklist]);

    if (loading) return <div className="flex items-center justify-center py-24 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mr-2" /> Generando vista de impresión...</div>;
    if (!orden || !orden.vehiculo) return <div className="p-6 text-center text-muted-foreground">Orden no encontrada.</div>;

    const v = orden.vehiculo;

    return (
        <div className="max-w-3xl mx-auto p-6 print:p-0 bg-background text-foreground">
            <style>{`
                @media print {
                    @page { margin: 14mm; }
                    body { background: white !important; }
                    .no-print { display: none !important; }
                    .print-avoid-break { break-inside: avoid; }
                }
            `}</style>

            <div className="no-print flex items-center justify-between mb-4">
                <Link to={`/mantenimiento/${id}`} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <ArrowLeft className="w-4 h-4" /> Volver a la orden
                </Link>
                <button onClick={() => window.print()} className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2.5 rounded-lg font-semibold min-h-[44px]">
                    <Printer className="w-4 h-4" /> Imprimir / Guardar PDF
                </button>
            </div>

            {/* Encabezado */}
            <div className="flex items-start justify-between border-b border-border pb-4 mb-4 print-avoid-break">
                <div>
                    <h1 className="text-xl font-bold">Orden de Mantenimiento Vehicular</h1>
                    <p className="text-sm text-muted-foreground">RAPILINK S.A.S. — NIT 901062663</p>
                </div>
                <div className="text-right">
                    <div className="text-lg font-bold">{orden.numero || 'Sin número'}</div>
                    <div className="text-sm text-muted-foreground">{ESTADO_LABEL[orden.estado]}</div>
                </div>
            </div>

            {/* Ficha del vehículo y datos del ingreso */}
            <div className="grid grid-cols-2 gap-3 text-sm mb-4 print-avoid-break">
                <Dato label="Vehículo" value={`${v.codigo} — ${v.tipo === 'motocarro' ? 'Motocarro' : 'Moto con tráiler'}`} />
                <Dato label="Placa" value={v.placa} />
                <Dato label="No. motor" value={v.num_motor} />
                <Dato label="No. chasis" value={v.num_chasis} />
                <Dato label="Fecha" value={new Date(orden.fecha).toLocaleDateString('es-CO')} />
                <Dato label="Kilometraje" value={orden.kilometraje ? `${orden.kilometraje} km` : null} />
                <Dato label="Tipo de servicio" value={TIPO_SERVICIO_LABEL[orden.tipo_servicio]} />
                <Dato label="Taller" value={orden.taller} />
                <Dato label="Motivo" value={orden.motivo} />
                <Dato label="Diagnóstico" value={orden.diagnostico} />
            </div>

            {/* Hallazgos (solo lo que no está en Bueno) */}
            <Seccion titulo="Hallazgos de la inspección">
                {hallazgos.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Sin hallazgos — todos los ítems aplicables quedaron en Bueno.</p>
                ) : (
                    <div className="space-y-3">
                        {hallazgos.map((h) => {
                            const info = itemInfo.get(h.item_id);
                            return (
                                <div key={h.id} className="text-sm border-b border-border/60 pb-2 print-avoid-break">
                                    <div className="flex items-center gap-2 flex-wrap">
                                        <span className="font-semibold">{info?.nombre || h.item_id}</span>
                                        <span className="text-[11px] font-bold px-1.5 py-0.5 rounded border">{h.estado}</span>
                                        {info?.critico && <span className="text-[11px] font-bold text-red-600">CRÍTICO</span>}
                                        <span className="text-xs text-muted-foreground">({info?.seccion})</span>
                                    </div>
                                    {h.observacion && <p className="text-muted-foreground mt-0.5">{h.observacion}</p>}
                                    {(h.fotos || []).length > 0 && (
                                        <div className="flex gap-2 mt-1.5 flex-wrap">
                                            {(h.fotos || []).map((f) => (
                                                fotoUrls[f.id] ? <img key={f.id} src={fotoUrls[f.id]} alt="" className="w-24 h-24 object-cover rounded border border-border" /> : null
                                            ))}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </Seccion>

            {/* Cotización */}
            <Seccion titulo="Cotización">
                {reparaciones.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Sin reparaciones cotizadas.</p>
                ) : (
                    <table className="w-full text-xs">
                        <thead>
                            <tr className="text-left border-b border-border">
                                <th className="py-1 pr-2">Descripción</th>
                                <th className="py-1 pr-2">Cant.</th>
                                <th className="py-1 pr-2">Vlr. unit.</th>
                                <th className="py-1 pr-2">M.O.</th>
                                <th className="py-1 pr-2">Total</th>
                                <th className="py-1">Autorizado</th>
                            </tr>
                        </thead>
                        <tbody>
                            {reparaciones.map((r) => (
                                <tr key={r.id} className="border-b border-border/40">
                                    <td className="py-1 pr-2">{r.descripcion}</td>
                                    <td className="py-1 pr-2">{r.cantidad}</td>
                                    <td className="py-1 pr-2">{money(r.valor_unitario)}</td>
                                    <td className="py-1 pr-2">{money(r.mano_obra)}</td>
                                    <td className="py-1 pr-2">{money(Number(r.total))}</td>
                                    <td className="py-1">{r.autorizado ? 'Sí' : 'No'}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                )}
                {totales && (
                    <div className="mt-3 text-sm ml-auto max-w-xs space-y-1">
                        <div className="flex justify-between"><span className="text-muted-foreground">Subtotal repuestos</span><span>{money(totales.subtotal_repuestos)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">Subtotal mano de obra</span><span>{money(totales.subtotal_mano_obra)}</span></div>
                        <div className="flex justify-between"><span className="text-muted-foreground">IVA</span><span>{money(totales.iva)}</span></div>
                        <div className="flex justify-between font-bold border-t border-border pt-1"><span>TOTAL AUTORIZADO</span><span>{money(totales.total)}</span></div>
                    </div>
                )}
            </Seccion>

            {/* Decisión */}
            {orden.decision && (
                <Seccion titulo="Decisión de aprobación">
                    <p className="text-sm"><strong>{orden.decision.replace('_', ' ').toUpperCase()}</strong></p>
                    {orden.obs_aprobador && <p className="text-sm text-muted-foreground mt-1">{orden.obs_aprobador}</p>}
                </Seccion>
            )}

            {/* Firmas electrónicas */}
            <Seccion titulo="Firmas electrónicas">
                <div className="grid grid-cols-3 gap-3 text-xs">
                    <Firma label="Creación (mecánico)" nombre={firmantes[orden.creado_por]?.full_name} fecha={orden.enviado_at || orden.created_at} />
                    <Firma label="Revisión (encargado de flota)" nombre={orden.revisado_por ? firmantes[orden.revisado_por]?.full_name : null} fecha={orden.revisado_at} />
                    <Firma label="Aprobación (resp. mantenimiento)" nombre={orden.aprobado_por ? firmantes[orden.aprobado_por]?.full_name : null} fecha={orden.aprobado_at} />
                </div>
            </Seccion>

            {/* Trazabilidad completa */}
            <Seccion titulo="Trazabilidad">
                <div className="space-y-1 text-xs">
                    {eventos.map((e) => (
                        <div key={e.id} className="flex justify-between border-b border-border/30 py-0.5">
                            <span>{EVENTO_LABEL[e.accion] || e.accion} — {e.usuario?.full_name || 'Usuario'}</span>
                            <span className="text-muted-foreground">{new Date(e.created_at).toLocaleString('es-CO')}</span>
                        </div>
                    ))}
                </div>
            </Seccion>
        </div>
    );
}

function Dato({ label, value }: { label: string; value: string | null }) {
    return (
        <div>
            <span className="text-muted-foreground">{label}: </span>
            <span className="font-medium">{value || '—'}</span>
        </div>
    );
}

function Seccion({ titulo, children }: { titulo: string; children: React.ReactNode }) {
    return (
        <div className="mb-5 print-avoid-break">
            <h2 className="text-sm font-bold uppercase tracking-wide border-b border-border pb-1 mb-2">{titulo}</h2>
            {children}
        </div>
    );
}

function Firma({ label, nombre, fecha }: { label: string; nombre?: string | null; fecha: string | null }) {
    return (
        <div className="border border-border rounded-lg p-2">
            <div className="text-muted-foreground mb-1">{label}</div>
            {nombre ? (
                <>
                    <div className="font-semibold">{nombre}</div>
                    <div className="text-muted-foreground">{fecha ? new Date(fecha).toLocaleString('es-CO') : ''}</div>
                </>
            ) : (
                <div className="text-muted-foreground italic">Pendiente</div>
            )}
        </div>
    );
}
