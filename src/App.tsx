import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { supabase, clearCorruptedSession } from './lib/supabase';
import { orgService } from './lib/orgService';
import { AuthPage } from './components/auth/AuthPage';
import { Layout } from './components/layout/Layout';
import { Onboarding } from './pages/Onboarding';
import { Dashboard } from './pages/Dashboard';
import { DailyReportsList } from './pages/DailyReportsList';
import { WeeklyReport } from './pages/WeeklyReport';
import { InteractionLog } from './pages/InteractionLog';
import { InteractionHistory } from './pages/InteractionHistory';
import { DailyReportGenerator } from './pages/DailyReportGenerator';
import { Configuration } from './pages/Configuration';
import { CampaignManager } from './pages/CampaignManager';
import { OperationsDashboard } from './pages/OperationsDashboard';
import { TechnicianAnalytics } from './pages/TechnicianAnalytics';
import { OperationsHub } from './pages/OperationsHub';
import DispatchHub from './pages/DispatchHub';
import { OperationsProductivity } from './pages/OperationsProductivity';
import { OperationsMyTasks } from './pages/OperationsMyTasks';
import { OperationsSupervision } from './pages/OperationsSupervision';
import { Pipeline } from './pages/Pipeline';
import InventoryDashboard from './pages/InventoryDashboard';
import AssetScanner from './pages/AssetScanner';
import InventoryCatalog from './pages/InventoryCatalog';
import InventoryStock from './pages/InventoryStock';
import InventoryAssignment from './pages/InventoryAssignment';
import InventoryKits from './pages/InventoryKits';
import TechnicianStock from './pages/TechnicianStock';
import InventoryRMA from './pages/InventoryRMA';
import InventoryAudit from './pages/InventoryAudit';
import InventoryAnalytics from './pages/InventoryAnalytics';
import InventorySlips from './pages/InventorySlips';
import InventoryMovements from './pages/InventoryMovements';
import { VoiceCampaigns } from './pages/VoiceCampaigns';
import { Clients } from './pages/Clients';
import { CustomerLifeCycle } from './pages/CustomerLifeCycle';

function App() {
  const [session, setSession] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  // null = unknown, true = org exists, false = needs onboarding
  const [orgReady, setOrgReady] = useState<boolean | null>(null);

  useEffect(() => {
    // 1. Obtener la sesión de forma segura
    supabase.auth.getSession()
      .then(async ({ data: { session }, error }) => {
        if (error) {
          console.error('[App:Auth] ❌ Error al obtener sesión inicial:', error);
          // Si el error indica sesión corrupta (ej: 500, oauth_client_id missing), limpiar
          if (error.message?.includes('500') || error.message?.includes('oauth_client_id')) {
            console.warn('[App:Auth] 🗑️ Sesión corrupta detectada al iniciar. Limpiando...');
            clearCorruptedSession();
          }
        }
        setSession(session);
        if (session) {
          let org = await orgService.getOrg().catch(() => null);
          // Reintento único si la primera carga falla (AbortError / timeout transitorio)
          if (!org) {
            await new Promise(r => setTimeout(r, 800));
            org = await orgService.getOrg().catch(() => null);
          }
          setOrgReady(!!org);
        }
      })
      .catch(err => {
        console.error('[App:Auth] 💥 Error fatal pidiendo sesión:', err);
        if (err.message?.includes('500') || err.message?.includes('oauth_client_id')) {
          clearCorruptedSession();
        }
      })
      .finally(() => {
        setLoading(false); // Siempre quitar cargando, pase lo que pase
      });

    // 2. Suscribirse a cambios
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, newSession) => {
      console.log(`[App:Auth] 🔑 Evento: ${event}`, newSession?.user?.email || 'Sin sesión');

      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION' || event === 'USER_UPDATED') {
        if (newSession) {
          setSession(newSession);
          if (event === 'SIGNED_IN') {
            orgService.invalidateCache();
            orgService.getOrg().then(org => setOrgReady(!!org)).catch(() => setOrgReady(false));
          }
        }
      } else if (event === 'SIGNED_OUT') {
        // Detectar si el logout es intencional o por sesión corrupta
        const token = localStorage.getItem('sb-rapilink-auth-token');
        if (!token) {
          // Token fue eliminado (sesión corrupta limpiada automáticamente o logout intencional)
          console.warn('[App:Auth] 🚪 Sesión cerrada. Redirigiendo al login.');
          setSession(null);
          setOrgReady(null);
        } else {
          // Token aún existe pero Supabase lo rechazó - probable sesión corrupta
          console.warn('[App:Auth] ⚠️ Sesión rechazada aunque token existe. Puede estar corrupta. Limpiando...');
          clearCorruptedSession();
          setSession(null);
          setOrgReady(null);
        }
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);


  if (loading) {
    return <div className="flex items-center justify-center h-screen bg-background text-foreground">Cargando...</div>;
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={!session ? <AuthPage /> : <Navigate to="/" />} />
        <Route path="/onboarding" element={
          !session ? <Navigate to="/login" /> :
          orgReady ? <Navigate to="/" /> :
          <Onboarding />
        } />

        <Route element={
          !session ? <Navigate to="/login" /> :
          orgReady === false ? <Navigate to="/onboarding" /> :
          <Layout />
        }>
          <Route path="/" element={<Dashboard />} />

          <Route path="/reportes/semanal" element={<WeeklyReport />} />

          {/* Historical Viewer Routes */}
          <Route path="/reportes/diario" element={<DailyReportsList />} />
          <Route path="/reportes/diario/view" element={<DailyReportGenerator />} />

          <Route path="/gestion" element={<InteractionLog />} />
          <Route path="/campanas" element={<CampaignManager />} />
          <Route path="/operaciones/hub" element={<OperationsHub />} />
          <Route path="/operaciones/despacho" element={<DispatchHub />} />
          <Route path="/operaciones/productividad" element={<OperationsProductivity />} />
          <Route path="/clientes" element={<Clients />} />
          <Route path="/clientes/hoja-de-vida/:id_servicio" element={<CustomerLifeCycle />} />
          <Route path="/operaciones/mis-tareas" element={<OperationsMyTasks />} />
          <Route path="/operaciones/supervision" element={<OperationsSupervision />} />
          <Route path="/operaciones/tecnicos" element={<TechnicianAnalytics />} />
          <Route path="/operaciones/trazabilidad" element={<OperationsDashboard />} />
          <Route path="/operaciones/inventario" element={<InventoryDashboard />} />
          <Route path="/operaciones/inventario/escaner" element={<AssetScanner />} />
          <Route path="/operaciones/inventario/catalogo" element={<InventoryCatalog />} />
          <Route path="/operaciones/inventario/stock" element={<InventoryStock />} />
          <Route path="/operaciones/inventario/asignaciones" element={<InventoryAssignment />} />
          <Route path="/operaciones/inventario/kits" element={<InventoryKits />} />
          <Route path="/operaciones/inventario/tecnicos" element={<TechnicianStock />} />
          <Route path="/operaciones/inventario/rma" element={<InventoryRMA />} />
          <Route path="/operaciones/inventario/auditoria" element={<InventoryAudit />} />
          <Route path="/operaciones/inventario/analiticas" element={<InventoryAnalytics />} />
          <Route path="/operaciones/inventario/actas" element={<InventorySlips />} />
          <Route path="/operaciones/inventario/movimientos" element={<InventoryMovements />} />
          <Route path="/voice-ai" element={<VoiceCampaigns />} />
          <Route path="/pipeline" element={<Pipeline />} />
          <Route path="/historial" element={<InteractionHistory />} />
          <Route path="/gestion/cerrar" element={<DailyReportGenerator />} />
          <Route path="/configuracion" element={<Configuration />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
