import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import {
    Loader2, AlertTriangle, ShieldCheck, ShieldX, ShieldAlert, Wrench, CheckCircle2, KeyRound,
} from 'lucide-react';
import clsx from 'clsx';
import { MttoService } from '../lib/mttoService';
import type { MttoDecision } from '../types/database';
import { money, TIPO_SERVICIO_LABEL, fechaVencimiento } from '../lib/mttoLabels';

/**
 * Pantalla PÚBLICA de firma por enlace. No requiere sesión.
 *
 * El enlace prueba posesión (llegó al WhatsApp de la persona) y el PIN
 * prueba conocimiento. Toda la validación real ocurre del lado del
 * servidor en mtto_ver_orden_por_token / mtto_firmar_por_token: aquí no
 * hay ninguna decisión de seguridad, solo presentación.
 */
export function MaintenanceSignByLink() {
    const { token } = useParams<{ token: string }>();
    const [loading, setLoading] = useState(true);
    const [datos, setDatos] = useState<any>(null);
    const [error, setError] = useState('');
    const [listo, setListo] = useState(false);

    const [pin, setPin] = useState('');
    const [obs, setObs] = useState('');
    const [decision, setDecision] = useState<MttoDecision>('aprobado');
    const [lineasElegidas, setLineasElegidas] = useState<Set<string>>(new Set());
    const [procesando, setProcesando] = useState(false);

    useEffect(() => {
        if (!token) return;
        (async () => {
            try {
                const d = await MttoService.verOrdenPorToken(token);
                setDatos(d);
                setObs(d?.orden?.obs_encargado || '');
                setLineasElegidas(new Set((d?.reparaciones || []).map((r: any) => r.id)));
            } catch (e: any) {
                setError(e.message || 'No se pudo abrir el enlace');
            } finally {
                setLoading(false);
            }
        })();
    }, [token]);

    const firmar = async () => {
        if (!/^\d{4,6}$/.test(pin)) { setError('Escriba su PIN (4 a 6 dígitos)'); return; }
        setProcesando(true);
        setError('');
        try {
            await MttoService.firmarPorToken(token!, pin, {
                obs,
                decision: datos.accion === 'aprobar' ? decision : undefined,
                valorAprobado: datos.accion === 'aprobar' ? totalPropuesto : undefined,
                lineasAutorizadas: decision === 'aprobado_parcial' ? Array.from(lineasElegidas) : undefined,
            });
            setListo(true);
        } catch (e: any) {
            setError(e.message || 'No se pudo firmar');
        } finally {
            setProcesando(false);
        }
    };

    if (loading) {
        return <Marco><div className="flex items-center justify-center py-16 text-muted-foreground"><Loader2 className="w-6 h-6 animate-spin mr-2" /> Abriendo la orden...</div></Marco>;
    }

    if (!datos) {
        return (
            <Marco>
                <div className="text-center py-12">
                    <AlertTriangle className="w-12 h-12 mx-auto mb-3 text-amber-500" />
                    <h2 className="font-bold text-lg mb-1">No se pudo abrir el enlace</h2>
                    <p className="text-sm text-muted-foreground">{error}</p>
                </div>
            </Marco>
        );
    }

    if (listo) {
        return (
            <Marco>
                <div className="text-center py-12">
                    <CheckCircle2 className="w-14 h-14 mx-auto mb-3 text-emerald-500" />
                    <h2 className="font-bold text-xl mb-1">Firma registrada</h2>
                    <p className="text-sm text-muted-foreground">
                        Gracias. Su decisión quedó guardada con la fecha y hora del sistema.
                        Ya puede cerrar esta página.
                    </p>
                </div>
            </Marco>
        );
    }

    const { orden, vehiculo, hallazgos = [], reparaciones = [], fotos = {}, firmante, usuario } = datos;
    const esAprobar = datos.accion === 'aprobar';
    const quien = firmante?.nombre || usuario?.nombre || 'Usted';

    const subtotal = reparaciones.reduce((acc: number, r: any) => acc + Number(r.total), 0);
    const totalPropuesto = Math.round(subtotal * (1 + Number(orden.iva_tasa)));
    const hayCriticoMalo = hallazgos.some((h: any) => h.estado === 'M' && h.critico);

    const toggleLinea = (id: string) => setLineasElegidas((prev) => {
        const n = new Set(prev);
        n.has(id) ? n.delete(id) : n.add(id);
        return n;
    });

    return (
        <Marco>
            <div className="mb-4">
                <h1 className="text-lg font-bold">{esAprobar ? 'Aprobación de orden' : 'Revisión de orden'}</h1>
                <p className="text-sm text-muted-foreground">
                    {orden.numero} · {vehiculo.codigo}{vehiculo.placa ? ` (${vehiculo.placa})` : ''} ·{' '}
                    {TIPO_SERVICIO_LABEL[orden.tipo_servicio]}
                </p>
                <p className="text-xs text-muted-foreground mt-1">Para firmar como <strong>{quien}</strong></p>
            </div>

            {hayCriticoMalo && (
                <div className="mb-4 bg-red-500/10 border border-red-500/40 text-red-700 dark:text-red-400 rounded-xl p-3 flex items-center gap-2 font-semibold text-sm">
                    <AlertTriangle className="w-5 h-5 shrink-0" />
                    Hay ítems CRÍTICOS en mal estado — el vehículo no debería salir a ruta.
                </div>
            )}

            {orden.motivo && (
                <Bloque titulo="Motivo del ingreso">
                    <p className="text-sm">{orden.motivo}</p>
                </Bloque>
            )}

            <Bloque titulo={`Hallazgos (${hallazgos.length})`}>
                {hallazgos.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Sin hallazgos: todo quedó en buen estado.</p>
                ) : (
                    <div className="space-y-3">
                        {hallazgos.map((h: any) => (
                            <div key={h.id} className="text-sm border-b border-border/50 pb-2 last:border-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <span className={clsx('text-[11px] font-bold px-1.5 py-0.5 rounded border',
                                        h.estado === 'M' ? 'border-red-500 text-red-600' : h.estado === 'R' ? 'border-amber-500 text-amber-600' : 'border-border text-muted-foreground')}>
                                        {h.estado}
                                    </span>
                                    <span className="font-medium">{h.item}</span>
                                    {h.critico && <span className="text-[10px] font-bold text-red-600">CRÍTICO</span>}
                                </div>
                                {h.observacion && <p className="text-muted-foreground mt-0.5">{h.observacion}</p>}
                                {h.fotos?.length > 0 && (
                                    <div className="flex gap-2 mt-1.5 flex-wrap">
                                        {h.fotos.map((p: string) => fotos[p] ? (
                                            <a key={p} href={fotos[p]} target="_blank" rel="noreferrer">
                                                <img src={fotos[p]} alt="" className="w-20 h-20 object-cover rounded border border-border" />
                                            </a>
                                        ) : null)}
                                    </div>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </Bloque>

            <Bloque titulo="Cotización">
                {reparaciones.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Sin reparaciones cotizadas.</p>
                ) : (
                    <div className="space-y-2">
                        {reparaciones.map((r: any) => (
                            <div key={r.id} className="text-sm border-b border-border/50 pb-2 last:border-0">
                                <div className="flex items-start gap-2">
                                    {esAprobar && decision === 'aprobado_parcial' && (
                                        <input type="checkbox" checked={lineasElegidas.has(r.id)} onChange={() => toggleLinea(r.id)} className="w-5 h-5 mt-0.5" />
                                    )}
                                    <div className="flex-1">
                                        <div className="flex justify-between gap-2">
                                            <span className="font-medium">{r.descripcion}</span>
                                            <span className="font-semibold whitespace-nowrap">{money(Number(r.total))}</span>
                                        </div>
                                        <div className="text-xs text-muted-foreground">
                                            {r.repuesto ? `${r.repuesto} · ` : ''}{r.cantidad} × {money(r.valor_unitario)}
                                            {Number(r.mano_obra) > 0 ? ` + M.O. ${money(r.mano_obra)}` : ''}
                                        </div>
                                        {r.fotos?.length > 0 && (
                                            <div className="flex gap-2 mt-1 flex-wrap">
                                                {r.fotos.map((p: string) => fotos[p] ? (
                                                    <a key={p} href={fotos[p]} target="_blank" rel="noreferrer">
                                                        <img src={fotos[p]} alt="" className="w-16 h-16 object-cover rounded border border-border" />
                                                    </a>
                                                ) : null)}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                        <div className="flex justify-between pt-2 font-bold">
                            <span>TOTAL {esAprobar ? 'A APROBAR' : 'COTIZADO'}</span>
                            <span className="text-primary text-lg">{money(totalPropuesto)}</span>
                        </div>
                    </div>
                )}
            </Bloque>

            {esAprobar && orden.obs_encargado && (
                <Bloque titulo="Observaciones del encargado de flota">
                    <p className="text-sm">{orden.obs_encargado}</p>
                </Bloque>
            )}

            {/* Decisión */}
            <div className="bg-card border border-border rounded-xl p-4 space-y-3 mb-4">
                {esAprobar ? (
                    <>
                        <h3 className="font-bold text-sm">Su decisión</h3>
                        <div className="grid grid-cols-3 gap-2">
                            <button onClick={() => setDecision('aprobado')}
                                className={clsx('py-3 rounded-xl font-bold text-xs flex flex-col items-center gap-1 min-h-[44px] border-2',
                                    decision === 'aprobado' ? 'bg-emerald-500 text-white border-emerald-500' : 'border-border text-muted-foreground')}>
                                <ShieldCheck className="w-5 h-5" /> APROBADO
                            </button>
                            <button onClick={() => setDecision('aprobado_parcial')}
                                className={clsx('py-3 rounded-xl font-bold text-xs flex flex-col items-center gap-1 min-h-[44px] border-2',
                                    decision === 'aprobado_parcial' ? 'bg-amber-500 text-white border-amber-500' : 'border-border text-muted-foreground')}>
                                <ShieldAlert className="w-5 h-5" /> PARCIAL
                            </button>
                            <button onClick={() => setDecision('no_aprobado')}
                                className={clsx('py-3 rounded-xl font-bold text-xs flex flex-col items-center gap-1 min-h-[44px] border-2',
                                    decision === 'no_aprobado' ? 'bg-red-500 text-white border-red-500' : 'border-border text-muted-foreground')}>
                                <ShieldX className="w-5 h-5" /> NO APROBADO
                            </button>
                        </div>
                        {decision === 'aprobado_parcial' && (
                            <p className="text-xs text-muted-foreground">Marque arriba las líneas que autoriza.</p>
                        )}
                    </>
                ) : (
                    <h3 className="font-bold text-sm">Sus observaciones</h3>
                )}

                <textarea value={obs} onChange={(e) => setObs(e.target.value)}
                    className="w-full border border-border rounded-lg px-3 py-2 bg-background min-h-[80px] text-sm"
                    placeholder={decision === 'aprobado_parcial' ? 'Observaciones (obligatorias en aprobación parcial)' : 'Observaciones (opcional)'} />

                <div>
                    <label className="text-sm font-medium mb-1 flex items-center gap-1.5">
                        <KeyRound className="w-4 h-4" /> Su PIN
                    </label>
                    <input type="password" inputMode="numeric" maxLength={6} value={pin}
                        onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                        placeholder="••••"
                        className="w-full border border-border rounded-lg px-3 py-3 bg-background min-h-[48px] tracking-widest text-center text-xl" />
                    <p className="text-xs text-muted-foreground mt-1">
                        Confirma que es usted quien firma. Si no lo recuerda, pídalo al administrador.
                    </p>
                </div>

                {error && <p className="text-sm text-destructive">{error}</p>}

                <button onClick={firmar} disabled={procesando || pin.length < 4}
                    className="w-full bg-primary text-primary-foreground py-4 rounded-xl font-bold min-h-[52px] flex items-center justify-center gap-2 disabled:opacity-60">
                    {procesando && <Loader2 className="w-5 h-5 animate-spin" />}
                    {esAprobar ? 'Firmar decisión' : 'Firmar revisión'}
                </button>
            </div>

            <p className="text-xs text-muted-foreground text-center pb-6">
                Este enlace es de un solo uso
                {fechaVencimiento(datos.expira_at)
                    ? ` y vence el ${fechaVencimiento(datos.expira_at)!.toLocaleString('es-CO')}.`
                    : ' y no tiene fecha de vencimiento.'}
            </p>
        </Marco>
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

function Bloque({ titulo, children }: { titulo: string; children: React.ReactNode }) {
    return (
        <div className="bg-card border border-border rounded-xl p-4 mb-3">
            <h3 className="font-bold text-sm mb-2">{titulo}</h3>
            {children}
        </div>
    );
}
