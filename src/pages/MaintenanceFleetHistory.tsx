import { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { AlertTriangle, Loader2, History, Repeat2 } from 'lucide-react';
import clsx from 'clsx';
import { MttoService, type MttoVehiculo, type MttoCostoVehiculo } from '../lib/mttoService';
import { money } from '../lib/mttoLabels';

const diasParaVencer = (fecha: string | null): number | null => {
    if (!fecha) return null;
    return Math.ceil((new Date(fecha).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
};

export function MaintenanceFleetHistory() {
    const [loading, setLoading] = useState(true);
    const [vehiculos, setVehiculos] = useState<MttoVehiculo[]>([]);
    const [seleccionado, setSeleccionado] = useState<string>('');
    const [costos, setCostos] = useState<MttoCostoVehiculo[]>([]);
    const [frecuentes, setFrecuentes] = useState<{ descripcion: string; veces: number }[]>([]);
    const [cargandoDetalle, setCargandoDetalle] = useState(false);

    useEffect(() => {
        (async () => {
            setLoading(true);
            try {
                const vs = await MttoService.listVehiculos();
                setVehiculos(vs);
                if (vs.length > 0) setSeleccionado(vs[0].id);
            } finally {
                setLoading(false);
            }
        })();
    }, []);

    useEffect(() => {
        if (!seleccionado) return;
        (async () => {
            setCargandoDetalle(true);
            try {
                const [c, f] = await Promise.all([
                    MttoService.getCostosPorVehiculo(seleccionado),
                    MttoService.getReparacionesFrecuentes(seleccionado),
                ]);
                setCostos(c);
                setFrecuentes(f);
            } finally {
                setCargandoDetalle(false);
            }
        })();
    }, [seleccionado]);

    const vehiculo = vehiculos.find((v) => v.id === seleccionado);

    const dataPorMes = useMemo(() => {
        return [...costos]
            .sort((a, b) => a.mes.localeCompare(b.mes))
            .map((c) => ({
                mes: new Date(c.mes).toLocaleDateString('es-CO', { month: 'short', year: '2-digit' }),
                total: Number(c.total_mes),
            }));
    }, [costos]);

    const dataPorAnio = useMemo(() => {
        const porAnio = new Map<string, number>();
        for (const c of costos) {
            const anio = c.mes.slice(0, 4);
            porAnio.set(anio, (porAnio.get(anio) || 0) + Number(c.total_mes));
        }
        return Array.from(porAnio.entries()).sort(([a], [b]) => a.localeCompare(b));
    }, [costos]);

    const totalAcumulado = costos.reduce((acc, c) => acc + Number(c.total_mes), 0);

    if (loading) {
        return <div className="flex items-center justify-center py-24 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mr-2" /> Cargando historial...</div>;
    }

    return (
        <div className="p-4 md:p-6 max-w-5xl mx-auto">
            <h1 className="text-xl md:text-2xl font-bold flex items-center gap-2 mb-4">
                <History className="w-6 h-6 text-primary" /> Historial por Vehículo
            </h1>

            {/* Selector de vehículo + alertas de vencimiento */}
            <div className="flex gap-2 overflow-x-auto pb-2 mb-4">
                {vehiculos.map((v) => {
                    const diasSoat = diasParaVencer(v.soat_vence);
                    const diasTecno = diasParaVencer(v.tecno_vence);
                    const alerta = (diasSoat !== null && diasSoat <= 30) || (diasTecno !== null && diasTecno <= 30);
                    return (
                        <button
                            key={v.id}
                            onClick={() => setSeleccionado(v.id)}
                            className={clsx(
                                'px-4 py-2.5 rounded-xl border text-sm font-semibold whitespace-nowrap min-h-[44px] flex items-center gap-1.5',
                                seleccionado === v.id ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border',
                                alerta && seleccionado !== v.id && 'border-red-500/50 text-red-600'
                            )}
                        >
                            {alerta && <AlertTriangle className="w-3.5 h-3.5" />}
                            {v.codigo}
                        </button>
                    );
                })}
            </div>

            {vehiculo && (
                <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                        <VencimientoCard label="SOAT" fecha={vehiculo.soat_vence} />
                        <VencimientoCard label="Tecnomecánica" fecha={vehiculo.tecno_vence} />
                    </div>

                    {cargandoDetalle ? (
                        <div className="flex items-center justify-center py-12 text-muted-foreground"><Loader2 className="w-5 h-5 animate-spin mr-2" /> Cargando datos del vehículo...</div>
                    ) : (
                        <>
                            <div className="bg-card border border-border rounded-xl p-4 mb-4">
                                <div className="flex items-center justify-between mb-3">
                                    <h3 className="font-bold text-sm">Costo por mes</h3>
                                    <span className="text-sm text-muted-foreground">Acumulado: <strong className="text-foreground">{money(totalAcumulado)}</strong></span>
                                </div>
                                {dataPorMes.length === 0 ? (
                                    <p className="text-sm text-muted-foreground text-center py-8">Sin costos registrados todavía para este vehículo.</p>
                                ) : (
                                    <div className="h-64">
                                        <ResponsiveContainer width="100%" height="100%">
                                            <BarChart data={dataPorMes} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                                                <CartesianGrid strokeDasharray="3 3" opacity={0.15} vertical={false} />
                                                <XAxis dataKey="mes" fontSize={11} axisLine={false} tickLine={false} />
                                                <YAxis fontSize={11} axisLine={false} tickLine={false} tickFormatter={(v) => money(v)} width={80} />
                                                <Tooltip formatter={(v?: number) => money(v)} contentStyle={{ borderRadius: 12, fontSize: 12 }} />
                                                <Bar dataKey="total" fill="var(--chart-1, #6366f1)" radius={[4, 4, 0, 0]} />
                                            </BarChart>
                                        </ResponsiveContainer>
                                    </div>
                                )}
                            </div>

                            {dataPorAnio.length > 0 && (
                                <div className="bg-card border border-border rounded-xl p-4 mb-4">
                                    <h3 className="font-bold text-sm mb-3">Costo por año</h3>
                                    <div className="flex gap-4">
                                        {dataPorAnio.map(([anio, total]) => (
                                            <div key={anio}>
                                                <div className="text-xs text-muted-foreground">{anio}</div>
                                                <div className="font-bold">{money(total)}</div>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )}

                            <div className="bg-card border border-border rounded-xl p-4">
                                <h3 className="font-bold text-sm mb-3 flex items-center gap-2"><Repeat2 className="w-4 h-4" /> Reparaciones que se repiten</h3>
                                {frecuentes.length === 0 ? (
                                    <p className="text-sm text-muted-foreground">Sin reparaciones recurrentes detectadas.</p>
                                ) : (
                                    <div className="space-y-1.5">
                                        {frecuentes.map((f) => (
                                            <div key={f.descripcion} className="flex justify-between text-sm border-b border-border/40 pb-1">
                                                <span>{f.descripcion}</span>
                                                <span className="font-semibold text-amber-600 dark:text-amber-400">{f.veces}×</span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </>
                    )}
                </>
            )}
        </div>
    );
}

function VencimientoCard({ label, fecha }: { label: string; fecha: string | null }) {
    const dias = diasParaVencer(fecha);
    const alerta = dias !== null && dias <= 30;
    return (
        <div className={clsx('border rounded-xl p-3', alerta ? 'border-red-500/50 bg-red-500/5' : 'border-border bg-card')}>
            <div className="text-xs text-muted-foreground">{label}</div>
            {fecha ? (
                <div className={clsx('font-bold', alerta && 'text-red-600 dark:text-red-400')}>
                    {new Date(fecha).toLocaleDateString('es-CO')}
                    {alerta && (
                        <span className="ml-2 text-xs font-semibold inline-flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> {dias! < 0 ? 'Vencido' : `${dias} día(s)`}
                        </span>
                    )}
                </div>
            ) : (
                <div className="text-muted-foreground italic">Sin dato</div>
            )}
        </div>
    );
}
