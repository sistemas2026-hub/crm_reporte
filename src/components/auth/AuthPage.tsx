import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';

export function AuthPage() {
    const [loading, setLoading] = useState(false);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [message, setMessage] = useState('');
    const navigate = useNavigate();

    // Se removió el useEffect de purga automática que destruía la sesión prematuramente

    const handleAuth = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setMessage('');

        try {
            const { error } = await supabase.auth.signInWithPassword({
                email,
                password,
            });
            if (error) throw error;
            
            // Redirección forzada inmediata para evitar la sensación de congelamiento
            navigate('/', { replace: true });
        } catch (error: any) {
            console.error("Auth Error:", error);
            setMessage(error.message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="flex items-center justify-center min-h-screen bg-background text-foreground">
            <div className="w-full max-w-md p-8 space-y-6 bg-card rounded-xl border border-border shadow-lg">
                <h1 className="text-3xl font-bold text-center text-primary">
                    Iniciar Sesión
                </h1>
                <p className="text-center text-muted-foreground">
                    Sistema de Reportes ISP
                </p>

                {message && (
                    <div className="p-3 text-sm rounded bg-accent/20 text-accent-foreground border border-accent/50">
                        {message}
                    </div>
                )}

                <form onSubmit={handleAuth} className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium mb-1">Email</label>
                        <input
                            type="email"
                            autoComplete="email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full px-3 py-2 bg-background border border-input rounded focus:ring-2 focus:ring-ring focus:outline-none disabled:opacity-50"
                            required
                            disabled={loading}
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium mb-1">Contraseña</label>
                        <input
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full px-3 py-2 bg-background border border-input rounded focus:ring-2 focus:ring-ring focus:outline-none disabled:opacity-50"
                            required
                            disabled={loading}
                        />
                    </div>
                    <button
                        disabled={loading}
                        className="w-full py-2 px-4 bg-primary text-primary-foreground font-semibold rounded hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                        {loading ? 'Cargando...' : 'Entrar'}
                    </button>
                </form>
            </div>
        </div>
    );
}
