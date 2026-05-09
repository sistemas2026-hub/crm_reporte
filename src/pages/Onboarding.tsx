import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Globe, Key, CheckCircle2, ArrowRight, Loader2, Zap, AlertTriangle } from 'lucide-react';
import { orgService } from '../lib/orgService';
import clsx from 'clsx';

type Step = 'org' | 'wisphub' | 'smartolt' | 'done';

function slugify(text: string): string {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .slice(0, 40);
}

export function Onboarding() {
    const navigate = useNavigate();
    const [step, setStep] = useState<Step>('org');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    // Step 1: Org info
    const [orgName, setOrgName] = useState('');
    const [companyName, setCompanyName] = useState('');

    // Step 2: WispHub
    const [wisphubUrl, setWisphubUrl] = useState('https://');
    const [wisphubToken, setWisphubToken] = useState('');
    const [wisphubStatus, setWisphubStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

    // Step 3: SmartOLT (opcional)
    const [smartoltUrl, setSmartoltUrl] = useState('https://');
    const [smartoltToken, setSmartoltToken] = useState('');
    const [smartoltStatus, setSmartoltStatus] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');

    const [createdOrgId, setCreatedOrgId] = useState<string | null>(null);

    const handleCreateOrg = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!orgName.trim() || !companyName.trim()) return;

        setLoading(true);
        setError('');

        try {
            const slug = slugify(orgName);
            const { org_id, error: orgError } = await orgService.createOrganization({
                orgName: orgName.trim(),
                slug,
                companyName: companyName.trim(),
                wisphubUrl: wisphubUrl.trim(),
                wisphubToken: wisphubToken.trim(),
            });

            if (orgError) throw new Error(orgError);

            setCreatedOrgId(org_id);
            setStep('wisphub');
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    const handleSaveWisphub = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!wisphubUrl.trim() || !wisphubToken.trim()) return;

        setLoading(true);
        setError('');

        try {
            await orgService.saveApiCredentials({
                wisphub_url: wisphubUrl.trim(),
                wisphub_token: wisphubToken.trim(),
            });
            setStep('smartolt');
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    const handleTestWisphub = async () => {
        setWisphubStatus('testing');
        await orgService.saveApiCredentials({
            wisphub_url: wisphubUrl.trim(),
            wisphub_token: wisphubToken.trim(),
        });
        const { ok, message } = await orgService.verifyWisphub();
        setWisphubStatus(ok ? 'ok' : 'fail');
        if (!ok) setError(message);
        else setError('');
    };

    const handleTestSmartOLT = async () => {
        setSmartoltStatus('testing');
        await orgService.saveApiCredentials({
            smartolt_url: smartoltUrl.trim(),
            smartolt_token: smartoltToken.trim(),
        });
        const { ok, message } = await orgService.verifySmartOLT();
        setSmartoltStatus(ok ? 'ok' : 'fail');
        if (!ok) setError(message);
        else setError('');
    };

    const handleSaveSmartOLT = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError('');

        try {
            if (smartoltUrl.trim() !== 'https://' && smartoltToken.trim()) {
                await orgService.saveApiCredentials({
                    smartolt_url: smartoltUrl.trim(),
                    smartolt_token: smartoltToken.trim(),
                });
            }
            setStep('done');
        } catch (e: any) {
            setError(e.message);
        } finally {
            setLoading(false);
        }
    };

    const steps: { id: Step; label: string; icon: React.ElementType }[] = [
        { id: 'org', label: 'Tu Empresa', icon: Building2 },
        { id: 'wisphub', label: 'WispHub', icon: Globe },
        { id: 'smartolt', label: 'SmartOLT', icon: Zap },
        { id: 'done', label: 'Listo', icon: CheckCircle2 },
    ];

    const stepIndex = steps.findIndex(s => s.id === step);

    return (
        <div className="min-h-screen bg-zinc-50 flex items-center justify-center p-4">
            <div className="w-full max-w-lg">
                {/* Header */}
                <div className="text-center mb-8">
                    <h1 className="text-2xl font-black text-zinc-900 uppercase tracking-tight">
                        Configuración Inicial
                    </h1>
                    <p className="text-zinc-500 text-sm mt-1 font-medium">
                        Conecta tu empresa en 3 pasos
                    </p>
                </div>

                {/* Step Indicators */}
                <div className="flex items-center justify-center gap-2 mb-8">
                    {steps.map((s, idx) => {
                        const Icon = s.icon;
                        const isActive = s.id === step;
                        const isDone = idx < stepIndex;
                        return (
                            <div key={s.id} className="flex items-center gap-2">
                                <div className={clsx(
                                    "w-8 h-8 rounded-full flex items-center justify-center border-2 transition-all",
                                    isActive && "bg-zinc-900 border-zinc-900 text-white",
                                    isDone && "bg-emerald-500 border-emerald-500 text-white",
                                    !isActive && !isDone && "bg-white border-zinc-200 text-zinc-400"
                                )}>
                                    {isDone ? <CheckCircle2 size={14} strokeWidth={3} /> : <Icon size={14} />}
                                </div>
                                {idx < steps.length - 1 && (
                                    <div className={clsx("w-8 h-0.5 rounded-full", idx < stepIndex ? "bg-emerald-400" : "bg-zinc-200")} />
                                )}
                            </div>
                        );
                    })}
                </div>

                {/* Card */}
                <div className="bg-white rounded-3xl border border-zinc-200 shadow-xl p-8 space-y-6">
                    {error && (
                        <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-xs font-bold text-red-700 flex items-center gap-2">
                            <AlertTriangle size={14} /> {error}
                        </div>
                    )}

                    {/* STEP 1: Organización */}
                    {step === 'org' && (
                        <form onSubmit={handleCreateOrg} className="space-y-5">
                            <div>
                                <h2 className="text-base font-black text-zinc-900 uppercase tracking-tight flex items-center gap-2">
                                    <Building2 size={18} className="text-zinc-500" /> Datos de tu empresa
                                </h2>
                                <p className="text-xs text-zinc-400 mt-1">Esta información aparecerá en reportes y marcas de agua.</p>
                            </div>
                            <div className="space-y-4">
                                <div>
                                    <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest block mb-1">Nombre del Workspace</label>
                                    <input
                                        required
                                        value={orgName}
                                        onChange={e => setOrgName(e.target.value)}
                                        placeholder="Ej: Rapilink SAS"
                                        className="w-full p-3 rounded-xl border border-zinc-200 bg-zinc-50 text-sm font-medium focus:ring-2 focus:ring-zinc-900/10 focus:border-zinc-900 outline-none transition-all"
                                    />
                                    {orgName && <p className="text-[10px] text-zinc-400 mt-1 font-mono">slug: {slugify(orgName)}</p>}
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest block mb-1">Nombre de la Empresa (para reportes)</label>
                                    <input
                                        required
                                        value={companyName}
                                        onChange={e => setCompanyName(e.target.value)}
                                        placeholder="Ej: RAPILINK SAS"
                                        className="w-full p-3 rounded-xl border border-zinc-200 bg-zinc-50 text-sm font-medium focus:ring-2 focus:ring-zinc-900/10 focus:border-zinc-900 outline-none transition-all"
                                    />
                                </div>
                            </div>
                            <button
                                type="submit"
                                disabled={loading || !orgName.trim() || !companyName.trim()}
                                className="w-full py-3 bg-zinc-900 text-white rounded-xl font-black uppercase text-xs tracking-widest flex items-center justify-center gap-2 hover:bg-black transition-all active:scale-95 disabled:opacity-40"
                            >
                                {loading ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                                Continuar
                            </button>
                        </form>
                    )}

                    {/* STEP 2: WispHub */}
                    {step === 'wisphub' && (
                        <form onSubmit={handleSaveWisphub} className="space-y-5">
                            <div>
                                <h2 className="text-base font-black text-zinc-900 uppercase tracking-tight flex items-center gap-2">
                                    <Globe size={18} className="text-blue-500" /> Conectar WispHub
                                </h2>
                                <p className="text-xs text-zinc-400 mt-1">Tu CRM administrativo. Obtén el token en WispHub → Configuración → API.</p>
                            </div>
                            <div className="space-y-4">
                                <div>
                                    <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest block mb-1">URL de tu WispHub</label>
                                    <input
                                        required
                                        value={wisphubUrl}
                                        onChange={e => setWisphubUrl(e.target.value)}
                                        placeholder="https://miempresa.wisphub.io"
                                        className="w-full p-3 rounded-xl border border-zinc-200 bg-zinc-50 text-sm font-mono font-medium focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest block mb-1">Token de API (Api-Key)</label>
                                    <div className="relative">
                                        <Key size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                                        <input
                                            required
                                            type="password"
                                            value={wisphubToken}
                                            onChange={e => { setWisphubToken(e.target.value); setWisphubStatus('idle'); }}
                                            placeholder="••••••••••••••••"
                                            className="w-full pl-9 pr-4 py-3 rounded-xl border border-zinc-200 bg-zinc-50 text-sm font-mono focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 outline-none transition-all"
                                        />
                                    </div>
                                </div>
                            </div>
                            <button
                                type="button"
                                onClick={handleTestWisphub}
                                disabled={wisphubStatus === 'testing' || !wisphubUrl.trim() || !wisphubToken.trim()}
                                className={clsx(
                                    "w-full py-2.5 rounded-xl font-black uppercase text-xs tracking-widest flex items-center justify-center gap-2 border transition-all active:scale-95",
                                    wisphubStatus === 'ok' && "bg-emerald-50 border-emerald-200 text-emerald-700",
                                    wisphubStatus === 'fail' && "bg-red-50 border-red-200 text-red-700",
                                    wisphubStatus === 'idle' && "bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100",
                                    wisphubStatus === 'testing' && "bg-zinc-50 border-zinc-200 text-zinc-500 cursor-wait"
                                )}
                            >
                                {wisphubStatus === 'testing' && <Loader2 size={12} className="animate-spin" />}
                                {wisphubStatus === 'ok' && <CheckCircle2 size={12} />}
                                {wisphubStatus === 'fail' && <AlertTriangle size={12} />}
                                {wisphubStatus === 'idle' && <Zap size={12} />}
                                {wisphubStatus === 'testing' ? 'Probando conexión...' : wisphubStatus === 'ok' ? 'Conexión exitosa' : wisphubStatus === 'fail' ? 'Falló — revisar datos' : 'Probar Conexión'}
                            </button>
                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full py-3 bg-zinc-900 text-white rounded-xl font-black uppercase text-xs tracking-widest flex items-center justify-center gap-2 hover:bg-black transition-all active:scale-95 disabled:opacity-40"
                            >
                                {loading ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                                Guardar y Continuar
                            </button>
                        </form>
                    )}

                    {/* STEP 3: SmartOLT */}
                    {step === 'smartolt' && (
                        <form onSubmit={handleSaveSmartOLT} className="space-y-5">
                            <div>
                                <h2 className="text-base font-black text-zinc-900 uppercase tracking-tight flex items-center gap-2">
                                    <Zap size={18} className="text-orange-500" /> Conectar SmartOLT
                                    <span className="text-[9px] font-black bg-zinc-100 text-zinc-500 px-2 py-0.5 rounded-full uppercase">Opcional</span>
                                </h2>
                                <p className="text-xs text-zinc-400 mt-1">Para consultas de señal óptica automáticas. Puedes configurarlo después.</p>
                            </div>
                            <div className="space-y-4">
                                <div>
                                    <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest block mb-1">URL de tu SmartOLT</label>
                                    <input
                                        value={smartoltUrl}
                                        onChange={e => setSmartoltUrl(e.target.value)}
                                        placeholder="https://miempresa.smartolt.com"
                                        className="w-full p-3 rounded-xl border border-zinc-200 bg-zinc-50 text-sm font-mono font-medium focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 outline-none transition-all"
                                    />
                                </div>
                                <div>
                                    <label className="text-[10px] font-black text-zinc-500 uppercase tracking-widest block mb-1">X-Token</label>
                                    <div className="relative">
                                        <Key size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
                                        <input
                                            type="password"
                                            value={smartoltToken}
                                            onChange={e => { setSmartoltToken(e.target.value); setSmartoltStatus('idle'); }}
                                            placeholder="••••••••••••••••"
                                            className="w-full pl-9 pr-4 py-3 rounded-xl border border-zinc-200 bg-zinc-50 text-sm font-mono focus:ring-2 focus:ring-orange-500/20 focus:border-orange-500 outline-none transition-all"
                                        />
                                    </div>
                                </div>
                            </div>
                            {smartoltUrl.trim() !== 'https://' && smartoltToken.trim() && (
                                <button
                                    type="button"
                                    onClick={handleTestSmartOLT}
                                    disabled={smartoltStatus === 'testing'}
                                    className={clsx(
                                        "w-full py-2.5 rounded-xl font-black uppercase text-xs tracking-widest flex items-center justify-center gap-2 border transition-all active:scale-95",
                                        smartoltStatus === 'ok' && "bg-emerald-50 border-emerald-200 text-emerald-700",
                                        smartoltStatus === 'fail' && "bg-red-50 border-red-200 text-red-700",
                                        (smartoltStatus === 'idle' || smartoltStatus === 'testing') && "bg-orange-50 border-orange-200 text-orange-700"
                                    )}
                                >
                                    {smartoltStatus === 'testing' && <Loader2 size={12} className="animate-spin" />}
                                    {smartoltStatus === 'ok' && <CheckCircle2 size={12} />}
                                    {smartoltStatus !== 'ok' && smartoltStatus !== 'testing' && <Zap size={12} />}
                                    {smartoltStatus === 'testing' ? 'Probando...' : smartoltStatus === 'ok' ? 'Conexión exitosa' : 'Probar SmartOLT'}
                                </button>
                            )}
                            <div className="flex gap-3">
                                <button
                                    type="button"
                                    onClick={() => setStep('done')}
                                    className="flex-1 py-3 bg-zinc-100 text-zinc-600 rounded-xl font-black uppercase text-xs tracking-widest hover:bg-zinc-200 transition-all active:scale-95"
                                >
                                    Omitir por ahora
                                </button>
                                <button
                                    type="submit"
                                    disabled={loading}
                                    className="flex-1 py-3 bg-zinc-900 text-white rounded-xl font-black uppercase text-xs tracking-widest flex items-center justify-center gap-2 hover:bg-black transition-all active:scale-95 disabled:opacity-40"
                                >
                                    {loading ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
                                    Guardar
                                </button>
                            </div>
                        </form>
                    )}

                    {/* STEP 4: Listo */}
                    {step === 'done' && (
                        <div className="text-center space-y-6 py-4">
                            <div className="w-20 h-20 bg-emerald-50 rounded-full flex items-center justify-center mx-auto border-4 border-emerald-100">
                                <CheckCircle2 size={40} className="text-emerald-500" strokeWidth={1.5} />
                            </div>
                            <div>
                                <h2 className="text-xl font-black text-zinc-900 uppercase tracking-tight">¡Todo listo!</h2>
                                <p className="text-sm text-zinc-400 mt-2 font-medium">
                                    Tu organización está configurada. Puedes actualizar las credenciales en cualquier momento desde <span className="font-black text-zinc-600">Configuración → Credenciales API</span>.
                                </p>
                            </div>
                            <button
                                onClick={() => navigate('/', { replace: true })}
                                className="w-full py-4 bg-zinc-900 text-white rounded-xl font-black uppercase text-xs tracking-widest flex items-center justify-center gap-2 hover:bg-black transition-all active:scale-95"
                            >
                                <ArrowRight size={14} /> Ir al Dashboard
                            </button>
                        </div>
                    )}
                </div>

                <p className="text-center text-[10px] text-zinc-400 mt-4 font-medium">
                    Tus credenciales API se guardan encriptadas y solo son accesibles por tu organización.
                </p>
            </div>
        </div>
    );
}
