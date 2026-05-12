# Memoria Técnica: Integración WispHub y SmartOLT

> [!IMPORTANT]
> Este documento registra hallazgos críticos y decisiones de implementación técnica. Consúltelo antes de modificar la lógica de integración.

## 1. Integración SmartOLT

### Autenticación y Proxy
*   **Header**: `X-Token`
*   **Proxy Vite**: Las peticiones a `/api/smartolt/*` se redirigen a `https://rapilinksas.smartolt.com/api/*`.
*   **Seguridad**: La API Key se inyecta desde `VITE_SMARTOLT_API_KEY` en el proxy, nunca se expone en el cliente.

### Detección de Hardware (SN Normalization)
> [!WARNING]
> Los escáneres de códigos de barras/QR de las ONUs a menudo leen el Serial Number en formato **Hexadecimal Crudo** (16 caracteres), mientras que SmartOLT utiliza el formato **Vendor ID** (4 letras + 8 hex).

**Problema Identificado:**
- Escaneado: `43445443AFB334D1` (ZTE en hex)
- Esperado por SmartOLT: `CDTCAFB334D1`

**Solución Implementada:**
Se creó el método `SmartOLTService.normalizeSerialNumber(sn)` que detecta automáticamente si el input es un string hexadecimal de 16 caracteres y convierte los primeros 8 (4 bytes) a ASCII.
*   `43445443` -> `CDTC` + Resto `AFB334D1` = `CDTCAFB334D1`

### Lectura de Potencia Óptica (Real-Time Signal)
> [!NOTE]
> La API de SmartOLT tiene endpoints con comportamientos distintos respecto a la "frescura" de los datos.

**Endpoint de Detalles (Cached/Static):**
*   `GET /api/onu/get_onus_details_by_sn/{sn}`
*   **Uso**: Para obtener datos generales (Modelo, Zona, OLT).
*   **Limitación**: El campo `signal` suele venir vacío (`""`), en `0`, o con el último valor histórico conocido. **No fuerza una lectura en vivo.**

**Endpoint de Señal (Real-Time):**
*   `GET /api/onu/get_onu_signal/{unique_external_id}`
*   **Uso**: Para diagnóstico en tiempo real durante la instalación.
*   **Requisito**: Requiere el `unique_external_id` (ID interno numérico de SmartOLT), **NO** el SN.

**Flujo de Implementación (`SmartOLTService.getOnuSignal`):**
1.  Llamar a `verifyAssetStatus(sn)` para obtener el `unique_external_id` del equipo.
2.  Llamar a `get_onu_signal(id)` usando ese ID.
3.  Parsear el string de respuesta (ej: `"-24.31 dBm"` -> `-24.31`).

## 2. Integración WispHub

### Tickets y Asignación
*   WispHub asigna tickets de manera asíncrona.
*   Para garantizar consistencia local, usamos una lógica de "limpieza inteligente" que marca como cerrados (`CO`) aquellos tickets locales que ya no aparecen en la respuesta de la API de WispHub para el técnico actual.

### Instalaciones
*   El registro de instalaciones utiliza el endpoint `/api/wisphub/solicitudes-instalacion`.

### Bugs y Comportamientos de la API (Hallazgos)
> [!CRITICAL]
> **Campo Oculto de Técnico (`email_tecnico`)**: 
> Se descubrió que en ciertos tickets (especialmente instalaciones asignadas automáticamente), WispHub devuelve `tecnico: null` en el JSON principal, pero almacena la asignación real en el campo `email_tecnico` (ej: `instalaciones@rapilink-sas`).
>
> **Solución**: El `WisphubService` fue parcheado para buscar recursivamente:
> 1. Objeto `tecnico` estándar.
> 2. Si es null, buscar en `email_tecnico`.
> 3. Si `email_tecnico` contiene "instalaciones", se mapea visualmente a "INSTALACIONES".

## 3. Gestión de Autenticación y Usuarios (Supabase Auth)

### El Fenómeno de los Usuarios "Zombies" 🧟
> [!WARNING]
> Se detectó un estado crítico donde registros en `public.profiles` existían sin un homólogo válido en `auth.users`, o con registros corruptos en `auth.users` (campos `created_at`, `instance_id` o metadatos en `NULL`).

**Impacto:**
- Los usuarios son invisibles en el Dashboard de Supabase.
- El login falla con `500 Internal Server Error` (Database error querying schema) debido a que el servidor de Go no puede escanear valores `NULL` en columnas de tokens.

### Estrategia de "Resurrección" y "Auto-Sanación"
Se implementaron dos funciones RPC con privilegios de `SECURITY DEFINER` para gestionar esto desde el frontend sin exponer llaves de servicio:

1.  **`create_new_user`**: Crea el usuario en ambas tablas (`auth` y `public`) en una sola transacción atómica, evitando huérfanos.
2.  **`update_user_credentials` (v4)**: 
    - **Sincronización Total**: Se llama en cada guardado de configuración.
    - **Resurrección**: Si el usuario no existe en `auth.users`, lo crea usando el email del perfil.
    - **Auto-Sanación**: Si el registro existe pero está corrupto (es un "Zombie"), repara automáticamente los campos `created_at`, `instance_id` y metadatos obligatorios.

### Configuración de Seguridad (RLS)
*   La tabla `public.profiles` está protegida por RLS.
*   Solo los administradores o el propio usuario pueden modificar el perfil.
*   Las funciones RPC actúan como bypass controlado para operaciones que requieren privilegios de `auth.users`.

## 4. Filtrado Correcto de Tickets: Mapeo de Técnicos

> [!CRITICAL]
> **Fecha**: 2026-01-30  
> **Contexto**: Implementación de Filtro "Instalaciones Confirmadas" en `OperationsDispatch.tsx`

### Problema Detectado

Al intentar crear un método para cargar tickets específicos desde la API de WispHub, se descubrió que:

1. **La API NO devuelve `nombre_tecnico` directamente**: Este campo es generado por la función `mapTicket()` en el cliente.
2. **`mapTicket()` es la fuente de verdad**: Transforma campos crudos (`email_tecnico`, `tecnico`, `tecnico_asignado`) en un nombre legible consultando el caché de staff (`GLOBAL_STAFF_CACHE`).
3. **Nuevas consultas sin `mapTicket` devuelven `undefined`**: Si se crea un método nuevo en `WisphubService` que NO usa `mapTicket`, el campo `nombre_tecnico` quedará indefinido.

**Ejemplo del error:**
```typescript
// ❌ INCORRECTO: Método que NO usa mapTicket
async getTicketsByTechnician(techName: string) {
    const response = await fetch(`/api/tickets/?search=${techName}`);
    const data = await response.json();
    return data.results; // ← nombre_tecnico: undefined
}
```

**Comportamiento observado:**
- Tickets cargados por SWR (usando `mapTicket`): `nombre_tecnico: "INSTALACIONES"`
- Tickets cargados por método nuevo: `nombre_tecnico: undefined`
- Filtros del frontend comparaban contra `undefined` → Fallaban silenciosamente

### Solución Implementada

**Estrategia**: Usar los datos **YA mapeados** que fueron cargados por SWR, en lugar de hacer llamadas adicionales a la API.

```typescript
// ✅ CORRECTO: Filtrar tickets locales ya mapeados
const loadInstallationsTickets = async () => {
    setLoadingInstallations(true);
    try {
        // Usar tickets YA cargados (tienen mapeo correcto)
        const filtered = tickets.filter(t => {
            const tech = (t.nombre_tecnico || '').toLowerCase().trim();
            return tech === 'instalaciones@rapilink-sas' || 
                   tech === 'instalaciones aprobadas';
        });
        
        console.log(`✅ Instalaciones encontradas: ${filtered.length} tickets`);
        setFilterPill('Instalaciones');
    } finally {
        setLoadingInstallations(false);
    }
};
```

### Lecciones Aprendidas

1. **Siempre usar `mapTicket`**: Si creas un método nuevo en `WisphubService` que devuelva tickets, DEBE llamar `this.mapTicket(ticket)` antes de retornar.
   
2. **Preferir datos locales ya procesados**: Si los datos ya fueron cargados y mapeados (ej: por SWR), es más eficiente filtrarlos localmente que hacer nuevas llamadas a la API.

3. **Verificar tipos en interfaces**: Si un componente usa un campo (ej: `nombre_tecnico`), asegurarse de que la interfaz TypeScript lo declare (ej: `interface DispatchTicket { nombre_tecnico?: string; }`).

4. **Logging para debugging**: Logs como `[Service] nombre_tecnico: undefined` fueron clave para detectar el problema. Mantener logs descriptivos en métodos críticos.

5. **Variantes específicas para instalaciones**: El filtro de instalaciones usa solo **dos variantes** validadas en producción:
   - `'instalaciones@rapilink-sas'` (Usuario inmutable)
   
   El sistema implementa **Normalización Automática en Servicio**: Si WispHub envía un ticket sin `tecnico_usuario`, el mapeador (`mapTicket`) consulta el espejo del staff y restaura el usuario inmutable basándose en el nombre o correo del técnico.

### Referencias de Código

- **Función de mapeo**: [`wisphub.ts:mapTicket`](file:///d:/desarrollo%20antgra/isp-reports-app/src/lib/wisphub.ts#L661-L835)
- **Filtro de instalaciones**: [`OperationsDispatch.tsx:Filtro Instalaciones Confirmadas`](file:///d:/desarrollo%20antgra/isp-reports-app/src/pages/OperationsDispatch.tsx#L319-L327)
- **Interfaz actualizada**: [`OperationsDispatch.tsx:DispatchTicket`](file:///d:/desarrollo%20antgra/isp-reports-app/src/pages/OperationsDispatch.tsx#L26-L50)

## 5. Consistencia de Datos Filtrados en Múltiples Vistas

> [!CRITICAL]
> **Fecha**: 2026-02-02  
> - [x] Analizar el código del filtro de instalaciones en `OperationsDispatch.tsx` y explicar la lógica.
> - [x] Diagnosticar por qué el ticket #68247 no pasa el filtro (CAMPO `tecnico_usuario` ES `undefined` EN LA API).
> - [x] Implementar **Mapeo Inmutable Automático** en `wisphub.ts`.
- [x] Refactorizar `mapTicket` para restaurar el `tecnico_usuario` usando el espejo del staff (Zero-Trust API).
- [x] Revertir lógica de interfaz en `OperationsDispatch.tsx` a chequeo estricto del usuario inmutable.
- [x] Documentar solución definitiva en memoria técnica y walkthrough.

geográfico, se descubrió una **inconsistencia crítica en el origen de datos**:

1. **Pool de tickets** usaba `filteredTickets` (datos post-filtrado)
2. **Mapa (`ticketsByNeighborhood`)** usaba `tickets` (datos sin filtrar)
3. **Resultado**: El usuario filtraba por técnico "Juan", el pool mostraba solo tickets de Juan, pero **el mapa seguía mostrando TODOS los markers**

**Código problemático:**
```typescript
// ❌ INCORRECTO: Usaba tickets sin filtrar
const ticketsByNeighborhood = useMemo(() => {
    const grouped: Record<string, DispatchTicket[]> = {};
    
    tickets.forEach(ticket => { // ← Bug: tickets en lugar de filteredTickets
        // ...
    });
    
    return grouped;
}, [tickets, neighborhoods]);
```

**Síntoma observable:**
- Usuario selecciona técnico en dropdown → Pool actualiza correctamente
- Mapa **NO reacciona** → Muestra todos los barrios/markers
- UX confusa: Información inconsistente entre vistas

### Solución Implementada

**Principio**: Todas las vistas derivadas (pool, mapa, contadores) DEBEN usar la **misma fuente de datos filtrados**.

```typescript
// ✅ CORRECTO: Usa datos filtrados
const ticketsByNeighborhood = useMemo(() => {
    const grouped: Record<string, DispatchTicket[]> = {};
    
    filteredTickets.forEach(ticket => { // ← Fix: filteredTickets
        // ...
    });
    
    return grouped;
}, [filteredTickets, neighborhoods]); // ← Dependency correcta
```

**Impacto del fix:**
- Pool → usa `filteredTickets`
- Mapa → usa `ticketsByNeighborhood` (derivado de `filteredTickets`)
- Contadores → calculados desde `filteredTickets`
- **Resultado**: Todas las vistas sincronizadas ✅

### Cadena de Dependencias Correcta

```
filterTechId / showInstallations / searchQuery
              ↓
        filteredTickets (useMemo)
         ↓             ↓
    Pool de      ticketsByNeighborhood (useMemo)
    Tickets              ↓
                   Markers del Mapa
```

**Regla de oro**: Si una vista muestra un **subconjunto** de datos, debe derivarse de `filteredTickets`, NO de `tickets`.

### Bug Relacionado: Drag & Drop con Filtros

El mismo patrón de inconsistencia se manifestó en la funcionalidad de drag & drop:

**Problema:**
- `onDragEnd` usaba **índice del array** sobre `tickets` (sin filtrar)
- La UI mostraba `filteredTickets` (post-filtrado)
- Al arrastrar un ticket con filtro activo, se asignaba el ticket en `tickets[index]` en lugar del correcto en `filteredTickets[index]`

**Síntoma:** Usuario arrastra "Cliente A" → Sistema asigna "Cliente B" (ticket incorrecto).

**Solución:** Usar `draggableId` (que es `ticket.id`) para identificar el ticket, no el índice:

```typescript
// ❌ INCORRECTO: Usa índice
const [movedItem] = tickets.splice(source.index, 1);

// ✅ CORRECTO: Usa ID
const movedItem = filteredTickets.find(t => t.id === draggableId);
```

**Patrón general:** En drag & drop con datos filtrados, **siempre identificar items por ID único**, nunca por índice de array.

### Lecciones Aprendidas

1. **Verificar origen de datos en múltiples vistas**: Cuando tienes filtros, asegurarse de que TODAS las vistas (listas, mapas, gráficos) usen los datos filtrados.

2. **Dependencias de useMemo**: Al cambiar la fuente de datos en un `useMemo`, actualizar también el array de dependencias.

3. **Testing visual**: Los bugs de inconsistencia de datos son más evidentes cuando se usan **filtros restrictivos** (ej: filtrar por un técnico con pocos tickets).

4. **Logging para validación**: 
   ```typescript
   console.log(`📍 Mapa: ${totalMapped}/${filteredTickets.length} tickets`);
   ```
   Este tipo de logging ayuda a detectar discrepancias (ej: "Mapa: 50/10 tickets" sería una red flag).

### Referencias de Código

- **Fix aplicado**: [`OperationsDispatch.tsx:ticketsByNeighborhood`](file:///d:/desarrollo%20antgra/isp-reports-app/src/pages/OperationsDispatch.tsx#L331-L354)
- **Filtros que alimentan**: [`OperationsDispatch.tsx:filteredTickets`](file:///d:/desarrollo%20antgra/isp-reports-app/src/pages/OperationsDispatch.tsx#L284-L328)
## 6. Arquitectura del Centro de Despacho (Premium UI)

> [!IMPORTANT]
> **Fecha**: 2026-02-02  
> **Contexto**: Consolidación estética y funcional del Dashboard de Operaciones.

### Componentes de Interfaz "Bento"
La vista de despacho (`OperationsDispatch.tsx`) utiliza una arquitectura de capas:
1.  **Capa 0 (Mapa)**: Pantalla completa, tiles optimizados (`light_all`).
2.  **Capa 1 (Markers)**: `L.divIcon` personalizados con conteo de tickets y animación `animate-ping`.
3.  **Capa 2 (Widgets)**: Encabezado "CENTRO DE DESPACHO" con indicador "Live" pulsante y widgets de estadísticas con `backdrop-blur-3xl`.

### Solución de Visibilidad: Patrón de Portales
**Problema**: Los tickets desaparecían al salir de la barra lateral (clipping) debido a `overflow: hidden` en los padres.
**Solución**: Se implementó el componente `Portal` (usando `createPortal` de `react-dom`).
*   Cuando `snapshot.isDragging` es `true`, el ticket se despsrende de su contenedor y se renderiza en el `document.body`.
*   Se eliminan las transiciones (`transition-all`) durante el arrastre para evitar "lag" visual.
*   Z-index forzado a `9999` para visibilidad total.

### Blindaje de Diseño (Estética Premium)
- **Fuentes**: Uso agresivo de `font-[1000]` para títulos.
- **Identificación**: La C.C. del cliente siempre está en la cabecera del panel de detalles (`text-[10px] uppercase`).
- **Filtrado Dinámico**: El mapa DEBE reaccionar al filtro de técnico instantáneamente.
## 7. Normalización Horaria y Resiliencia de Fechas

> [!CRITICAL]
> **Fecha**: 2026-02-08  
> **Contexto**: Resolución de desaparición de tickets nocturnos y errores en métricas de tiempo (43201m).

### Desfase Horario de la API (UTC+5)
Se identificó que la API de WispHub (especialmente en los campos de cierre como `fecha_fin` o `fecha_final`) a menudo devuelve timestamps con un desfase de **+5 horas** respecto a la hora local de Colombia/Ecuador (UTC-5).
- **Problema**: Un ticket cerrado a las 7:00 PM aparece en la API como cerrado a las 00:00 AM del día siguiente.
- **Impacto**: Los tickets cerrados al final de la jornada "desaparecían" del Timeline de hoy porque la App pensaba que pertenecían al mañana.
- **Solución**: Implementación de una resta constante de 5 horas (`- 5 * 60 * 60 * 1000`) en los métodos de filtrado y cálculo de métricas para normalizar los datos a hora local.

### Conflictos de Formato: MM/DD vs DD/MM (El bug de los 43201m)
WispHub utiliza inconsistencia de formatos en sus respuestas de API:
- **Formato US (MM/DD/YYYY)**: Frecuente en respuestas de tickets individuales y en el campo `fecha_fin`.
- **Formato Latam (DD/MM/YYYY)**: Usado en otras partes de la interfaz y reportes.

**El Error de los 43201m:**
Al interpretar `02/09/2026` (9 de febrero) como `02 de Septiembre`, la App calculaba una duración de 30 días (+43,000 minutos) en lugar de unos pocos minutos.

**Solución (Heurística de Parseo):**
Se implementó una lógica de autodetcción en `isTodayResilient` y `parseWH`:
1.  Si el primer número es `> 12`, se asume **DD/MM**.
2.  Si el segundo número es `> 12`, se asume **MM/DD**.
3.  Si ambos son `<= 12`, se asume por defecto **MM/DD** (estándar interno de la API de WispHub).

### Estrategia de Sincronización Fallback
Para evitar que un ticket "parpadee" o desaparezca mientras WispHub actualiza sus índices globales, se creó un estado de **"Sincronizando estado"**:
-   Si un ticket ya no aparece en la lista de "Abiertos" pero aún no ha sido reportado en la lista de "Terminados" de la API, la App mantiene el ticket visible con un indicador de carga hasta que la confirmación oficial llega vía SWR.

## 8. Optimizaciones en Centro de Despacho (Premium UX)

> [!IMPORTANT]
> **Fecha**: 2026-02-11  
> **Contexto**: Refinamiento estético y corrección de lógica de reordenamiento.

### Interfaz Ultra-Compacta
Para maximizar el espacio útil del mapa sin perder información crítica, se implementó un diseño de alta densidad:
-   **Header Central**: Reducción de paddings (`py-2.5`) y escalado de fuentes (`text-xl`). El indicador "Vivo" se simplificó para evitar distracciones.
-   **Tarjetas de Tickets**: Reducción drástica de márgenes y paddings. Los IDs y el tiempo de apertura se alinearon para permitir ver hasta un 40% más de tickets en el mismo espacio vertical.

### Lógica de Reordenamiento Bidireccional
**Problema**: El sistema de `React-Beautiful-DND` fallaba al intentar mover tickets hacia arriba ("Up") dentro de la lista de un técnico porque la lógica original solo concatenaba al final.

**Solución Implementada**:
-   Uso de `splice` en lugar de `Array.filter` + `concat`.
-   **Identificación por ID**: Se abandonó el uso de índices del array para identificar el item movido, utilizando siempre el `draggableId` para garantizar que la mutación de estado sea atómica e independiente del orden visual previo.
-   **Feedback Visual**: Las dropzones ahora tienen un estado `bg-slate-100/40` permanente y reaccionan con un "glow" de color primario (`bg-primary/10`) al detectar un ticket encima (`isDraggingOver`).

### Persistencia y Consistencia
-   **Local Manifest**: El despacho utiliza un manifiesto local (`dispatch_manifest_YYYY-MM-DD`) para recordar qué técnicos tienen tickets asignados antes de la publicación final a WispHub.
-   **Sincronización Atómica**: El botón "Publicar" ejecuta una secuencia de cambios de técnico en la API de WispHub y limpia el manifiesto local solo tras el éxito de la operación.

## 9. Lógica de Despacho Manual Estricto (Visual vs Data)

> [!CRITICAL]
> **Fecha**: 2026-02-12
> **Contexto**: Resolución del conflicto entre "Sincronización de Datos" y "Limpieza Visual del Tablero".

### El Dilema de la Auto-Asignación
El sistema WispHub asigna tickets automáticamente a los técnicos. Originalmente, la App reflejaba esto inmediatamente en el tablero de despacho.
**Problema:** Los despachadores sentían que el tablero se "ensuciaba" con tickets que ellos no habían gestionado personalmente ese día, perdiendo la sensación de control sobre la jornada de despacho.

### Solución: Desacoplamiento Visual
Se implementó una **separación estricta** entre la asignación de datos y la visualización en el tablero de despacho (`OperationsDispatch.tsx`).

1. **Backend (Datos) = Sincronización Total**
   - La base de datos y la App de los técnicos **SÍ** reflejan la asignación real de WispHub.
   - Si WispHub dice que el ticket es de "Juan", "Juan" lo verá en su celular.

2. **Frontend (Despacho) = Manual Only**
   - Al cargar el tablero de despacho, **SE IGNORA** la asignación que viene de la base de datos para las columnas de los técnicos.
   - Las columnas de los técnicos ("Juan", "Pedro") inician **VACÍAS** (o solo con lo que esté en el borrador local `dispatch_manual_strict_v1`).
   - Todos los tickets, incluso los ya asignados en BD, aparecen en el **Pool de Pendientes** (Izquierda).

### Reglas de Implementación
Para mantener este comportamiento, el `useEffect` de carga inicial en `OperationsDispatch.tsx` **NO DEBE** mezclar los resultados de `WorkflowService.getTodayAssignments()`.

```typescript
// ✅ CORRECTO (Manual Strict):![alt text](image.png)
if (technicians.length > 0) {
    setAssignedRoutes(prev => {
        // Solo carga lo que está en localStorage (draftRoutes)
        const next = { ...prev, ...draftRoutes }; 
        return next;
    });
}

// ❌ PROHIBIDO (Causa "ensuciamiento" visual):
// WorkflowService.getTodayAssignments().then(...) -> NO HACER MERGE
```

### Cache Key Strategy
Si alguna vez se requiere "resetear" la vista de despacho debido a un cambio de lógica, se debe rotar la clave de `localStorage`:
- `dispatch_draft_schedule_v1` (Obsoleto - Mezclaba BD)
- `dispatch_manual_strict_v1` (Actual - Solo Manual)

## 10. Resiliencia API y Seguridad de Inventario

> [!IMPORTANT]
> **Fecha**: 2026-02-19
> **Contexto**: Endurecimiento de la seguridad RLS y corrección de "falsos positivos" en errores de API.

### 10.1. El Caso del 404 en `/asuntos-tickets`
**Problema**: La consola mostraba errores 404 intermitentes al cargar la lista de asuntos.
**Hallazgo**: La API de WispHub (basada en Django REST Framework) es inconsistente con el manejo de `TRAILING_SLASH`.
- Algunos endpoints requieren barra final: `/asuntos-tickets/`
- Otros fallan si la tienen: `/clientes`

**Solución**: Se implementó una lógica de "Retry-with-slash" en `WisphubService.getTicketSubjects`.
1.  Intenta `GET /asuntos-tickets` (sin barra).
2.  Si recibe 404, reintenta automáticamente con `GET /asuntos-tickets/`.
3.  Si ambos fallan, usa una lista estática de fallback (`TICKET_SUBJECTS`) para no bloquear la UI.

### 10.2. Burbujas de Respuesta "Silenciosas"
**Objetivo**: Registrar acciones en el historial del ticket (ej: "Técnico en camino") sin enviar correos molestos al cliente final.
**Implementación**:
El endpoint `/api/tickets/comentarios/` acepta un flag no documentado oficialmente pero funcional:
```json
{
  "do_not_notify_client": true
}
```
Esto permite crear "System Notes" o trazas de auditoría visibles para el staff pero invisibles/silenciosas para el usuario final.

### 10.3. Seguridad RLS: Actas de Entrega
Se implementó un modelo de seguridad estricto para el módulo de inventario (`inventory_delivery_slips`):

1.  **Base de Datos (Postgres RLS)**:
    -   `SELECT`: Permitido a usuarios autenticados (`auth.role() = 'authenticated'`).
    -   `INSERT`: Permitido a usuarios autenticados.
    -   **Restricción**: Un usuario estándar no puede borrar ni editar actas de otros, garantizando inmutabilidad legal.

2.  **Storage (Supabase Storage)**:
    -   Bucket: `delivery-acts`
    -   Política `Give technicans access to own folder 1ok0g1_0`:
        -   Permite `SELECT`, `INSERT` (Upload).
        -   Path forzado: `(storage.foldername(name))[1] = 'delivery-acts'`.
    -   Esto asegura que las firmas y fotos de evidencia sean accesibles para generar los PDFs pero protegidas de escritura pública.
    -   Esto asegura que las firmas y fotos de evidencia sean accesibles para generar los PDFs pero protegidas de escritura pública.

## 11. Optimización de Supervisión (Resolución QuotaExceededError)

> [!CRITICAL]
> **Fecha**: 2026-02-19
> **Contexto**: Error crítico de almacenamiento ("QuotaExceededError") al intentar cachear 60 días de procesos operativos.

### El Problema del Caché Local
Inicialmente se implementó una estrategia `stale-while-revalidate` usando `localStorage` para dar una vista instantánea.
*   **Fallo**: Un solo objeto JSON con 60 días de datos de `workflow_processes` (incluyendo actividades y workitems) excedía el límite de 5MB del navegador.
*   **Síntoma**: Pantalla roja de error y fallo total de la aplicación al intentar guardar.

### Solución: Carga Progresiva (Waterfall)
Se eliminó por completo el caché persistente (`localStorage`) en favor de una estrategia de carga escalonada en `OperationsSupervision.tsx`:

1.  **Carga Inicial Rápida**:
    *   Se solicitan solo los **primeros 50 registros** (`.range(0, 49)`).
    *   Esto garantiza un "First Contentful Paint" casi instantáneo sin saturar la memoria.

2.  **Sincronización de Fondo**:
    *   Inmediatamente después (`setTimeout`), se dispara una segunda consulta que trae el resto de los datos del rango de fechas seleccionado.
    *   La UI se actualiza silenciosamente cuando llegan los datos completos.

### Limpieza de Emergencia
Para remediar los navegadores de usuarios que ya tenían el error atrapado, se implementó una rutina de **sanitización al montaje**:
```typescript
// OperationsSupervision.tsx
useEffect(() => {
    // Purga proactiva de claves corruptas o gigantes
    Object.keys(localStorage).forEach(key => {
        if (key.startsWith('supervision_cache_')) {
            localStorage.removeItem(key);
        }
    });
    // ...
}, []);
```

## 12. Normalización de Asuntos de Tickets (WispHub API vs BD Local)

> [!CRITICAL]
> **Fecha**: 2026-02-20
> **Contexto**: Corrección de categorización estricta de tickets para métricas y reportes.

### Formato Híbrido en `workflow_processes.title`
Se descubrió que la sincronización de tickets desde WispHub almacena el Asunto del ticket concatenado con el Nombre del Cliente en el campo `title` de la base de datos local.
- **Formato WispHub (Visual)**: `Instalacion Nueva`
- **Formato Guardado (DB Local)**: `Instalacion Nueva - MARIO SABANAGRANDE`

**Impacto Cero-Tolerancia en Categorización**:
Al intentar aplicar reglas de macheo estricto (`subject === 'INSTALACION NUEVA'`) para agrupar analíticas de inventario y consumo, las comparaciones fallaban y los tickets caían por defecto en la categoría "ADMINISTRATIVO", ya que la cadena traía basura de texto al final.

### Solución: Aislamiento del Asunto
Para mantener la robustez sin caer en falsos positivos (usando un `.includes()` que podría clasificar erróneamente variaciones de texto), se pre-procesa la cadena cortando en el separador literal ` - ` antes de la evaluación estricta:

```typescript
// src/lib/inventoryAnalytics.ts
export const categorizeTicket = (subject: string): TicketCategory => {
    if (!subject) return 'ADMINISTRATIVO';
    
    // WispHub a menudo guarda "Asunto - Cliente". Cortamos aquí para obtener el asunto puro
    const isolatedSubject = subject.includes(' - ') ? subject.split(' - ')[0] : subject;
    
    // Removemos acentos y pasamos a mayúsculas para una comparación estricta
    const normalizedSubject = isolatedSubject.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase().trim();

    if (SUBJECTS_INSTALACION.includes(normalizedSubject)) return 'INSTALACION';
    // ...resto de validaciones
};
```

### Notas sobre Errores Tipográficos del Catálogo Origen
Adicionalmente, se confirmó que el catálogo original de WispHub del ISP contiene y envía errores de tipeo en las opciones por defecto (ej. `"INSTATALACION NUEVA"` en lugar de Instalación). **Regla de oro**: El código local debe mapear y empatar exactamente esos errores de tipeo en los arrays de constantes si desea capturar correctamente los tickets históricos y presentes hasta que se corrija en el origen.

## 13. Arquitectura del Proxy: Dev vs Producción

> [!CRITICAL]
> **Fecha**: 2026-05-12
> **Contexto**: Resolución de error 404 HTML al sincronizar tickets desde Mis Tareas en entorno local.

### El Problema: BASE_URL apuntaba al Edge Function en local

Al migrar de Vite proxy a Edge Function SaaS, el `BASE_URL` de `wisphub.ts` quedó hardcodeado al Edge Function remoto:

```typescript
// ❌ ANTES: Solo Edge Function (rompe el dev local)
const BASE_URL = orgService.getWispHubProxyUrl();
// → https://supabase.rapilinksas.co/functions/v1/proxy-wisphub
```

**Síntoma**: En local, las llamadas a WispHub llegaban al Edge Function remoto, que construía la URL `https://api.wisphub.io/api/tickets/` desde la base de datos. Sin embargo, la respuesta era HTML (página web de WispHub) en vez de JSON — señal de que la URL almacenada en `organization_settings` no era correcta o el dominio estaba redireccionando.

### URL Correcta de la API WispHub

> [!WARNING]
> WispHub NO usa subdominios por empresa para su API REST. Usa un servidor compartido.
>
> - **Sitio web** (no usar para API): `www.wisphub.io` → nginx, devuelve 403 en `/api/`
> - **API REST** (usar este): `api.wisphub.io` → Django DRF, acepta `Api-Key`
> - **Documentación**: `wisphub.net` (solo docs, no producción)

Lo que debe guardarse en `organization_settings.wisphub_url`:
```
https://api.wisphub.io
```
Sin trailing slash, sin `/api/`, sin subdominio de empresa.

Si se guarda `https://wisphub.io` (sin `api.`), el proxy obtiene el HTML de la página de marketing en vez de JSON — fácil de detectar por el `<!DOCTYPE html>` y el GTM tag en la respuesta.

### Solución Implementada: Split Dev/Prod

```typescript
// ✅ AHORA: Vite proxy en dev, Edge Function en producción
const BASE_URL = import.meta.env.DEV
    ? '/api/wisphub'          // Vite proxy (vite.config.ts → api.wisphub.io)
    : orgService.getWispHubProxyUrl(); // Edge Function SaaS
```

Lo mismo aplica para SmartOLT en `smartolt.ts`:
```typescript
const baseUrl = import.meta.env.DEV ? '/api/smartolt' : orgService.getSmartOLTProxyUrl();
```

### Cómo funciona cada ruta

**En desarrollo (`npm run dev`)**:
```
Browser → Vite Dev Server (/api/wisphub/tickets/)
        → proxy rewrite → https://api.wisphub.io/api/tickets/
        → Api-Key inyectada desde VITE_WISPHUB_API_KEY en .env
```

**En producción (Dokploy/VPS)**:
```
Browser → supabase.rapilinksas.co/functions/v1/proxy-wisphub/tickets/
        → Edge Function lee organization_settings (wisphub_url + wisphub_token)
        → https://api.wisphub.io/api/tickets/
        → Api-Key inyectada desde la BD del tenant
```

### Diagnóstico Rápido de Proxy Roto

| Síntoma en consola | Causa probable |
|---|---|
| `500` desde `supabase.../proxy-wisphub` | Edge Function no desplegada o error interno |
| `400` desde `supabase.../proxy-wisphub` | `org_id` sin configurar o credenciales vacías en BD |
| `404` + body HTML con GTM | `wisphub_url` apunta a `wisphub.io` (sin `api.`) |
| `404` + body JSON `{"detail":"..."}` | Endpoint incorrecto, pero el proxy y URL están OK |
| `401` desde `supabase.../proxy-wisphub` | JWT vencido o ausente en el header Authorization |
