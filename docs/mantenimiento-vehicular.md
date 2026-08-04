# Módulo de Mantenimiento Vehicular

Formaliza el flujo de reparaciones de la flota (3 motocarros + 2 motos con
tráiler): el mecánico inspecciona y cotiza, el encargado de flota revisa, y el
responsable de mantenimiento vehicular aprueba, aprueba parcialmente o
rechaza. Sin su firma (aprobación) no se inicia ningún trabajo.

Todas las tablas usan el prefijo `mtto_`. Reutiliza el sistema de auth y de
organizaciones (multi-tenant) que ya existe en la plataforma — no crea
autenticación nueva.

## 1. Correr las migraciones

En el **SQL Editor de Supabase**, pegue y ejecute estos archivos **en este
orden**, cada uno en su propia ejecución:

1. `supabase/migrations/20260803_mtto_1_schema.sql` — enums, tablas,
   triggers de numeración (`OT-2026-00001`) e inmutabilidad, vistas, RLS y el
   bucket privado `mtto-fotos`.
2. `supabase/migrations/20260803_mtto_2_seed.sql` — los 97 ítems del
   checklist (11 secciones), los 107 arreglos del catálogo (11 sistemas) y
   los 5 vehículos (`MC-01`..`MC-03`, `MT-01`, `MT-02`).
3. `supabase/migrations/20260803_mtto_3_rpc.sql` — las 6 funciones RPC de la
   máquina de estados.
4. *(Opcional, recomendado)* `supabase/migrations/20260803_mtto_4_tests.sql`
   — verifica las 3 validaciones críticas (sin foto en M, edición fuera de
   borrador, mecánico intentando aprobar). Termina en `ROLLBACK`: no deja
   nada escrito. Lea los mensajes `NOTICE`/`WARNING` en la pestaña de logs
   del SQL Editor, no en "Results".

Los cuatro archivos son idempotentes: se pueden volver a correr sin duplicar
datos ni romper nada.

### Aviso sobre el seed de vehículos

El paso 2 corre sin sesión de usuario, así que no puede resolver la
organización actual automáticamente: toma la **primera fila** de
`organizations`. Si su instancia ya tiene más de una organización, edite el
`WHERE`/subconsulta de la sección **E. FLOTA** en
`20260803_mtto_2_seed.sql` antes de correrlo.

### Datos que quedaron en `NULL` a propósito

No se inventó ningún dato de la empresa. Cárguelos cuando los tenga:

- **Vehículos** (`mtto_vehiculo`): placa, número de motor, número de
  chasis, vencimiento de SOAT y de tecnomecánica, responsable. Se cargan
  desde **Mantenimiento → Flota de Vehículos** (`/mantenimiento/vehiculos`),
  donde también se crean vehículos nuevos. Solo visible/editable para el
  rol admin del módulo.
- **Precios de referencia** (`mtto_catalogo_arreglo`): se cargan desde la
  pantalla **Mantenimiento → Catálogo de Precios (Mtto)** en la app
  (`/mantenimiento/catalogo`), solo visible/editable para el rol admin del
  módulo.

## 2. Asignar roles a usuarios existentes

El módulo tiene su propia tabla de roles, `mtto_usuario_rol`, separada de
`profiles.role` (que sigue siendo el rol general de la plataforma). Un
usuario con `profiles.role = 'admin'` ya es admin del módulo automáticamente
(puede hacer todo) sin necesitar una fila aquí.

Para los demás roles (`mecanico`, `encargado`, `aprobador`), asígnelos desde
el SQL Editor:

```sql
-- Buscar el id del usuario por su correo
select id, email from auth.users where email = 'tecnico1@rapilink.com';

-- Asignar rol de mecánico
insert into public.mtto_usuario_rol (usuario_id, rol, nombre, cargo)
values ('<uuid-del-usuario>', 'mecanico', 'Nombre Apellido', 'Técnico de taller')
on conflict (usuario_id) do update set rol = excluded.rol, activo = true;
```

Roles válidos: `mecanico`, `encargado` (encargado de flota), `aprobador`
(responsable de mantenimiento vehicular), `admin` (admin del módulo). Cada
usuario tiene **un solo rol** en el módulo (la tabla usa `usuario_id` como
llave primaria).

## 3. Dar acceso al menú

El menú lateral ya trae el grupo **"Mantenimiento"** con tres ítems:
`Mantenimiento Vehicular`, `Historial por Vehículo` y `Catálogo de Precios
(Mtto)`. Como con el resto de la app, un usuario que no sea admin de
plataforma solo ve los grupos/ítems que estén en su
`profiles.allowed_menus` — agréguelos desde **Configuración → Usuarios**,
igual que con cualquier otro módulo.

## 4. Rutas de la app

| Ruta | Pantalla |
|---|---|
| `/mantenimiento` | A — Bandeja de órdenes |
| `/mantenimiento/:id` | B — Orden de trabajo (4 pasos) |
| `/mantenimiento/:id/imprimir` | C — Vista imprimible (sin sidebar, `Ctrl+P` → Guardar como PDF) |
| `/mantenimiento/historial` | D — Historial de costos y recurrencias por vehículo |
| `/mantenimiento/vehiculos` | Alta y edición de la ficha de vehículos (solo admin del módulo) |
| `/mantenimiento/catalogo` | Administración de precios del catálogo (solo admin del módulo) |

## 5. Notas de diseño

- **Llenado por excepción**: todo ítem sin fila en `mtto_orden_hallazgo` se
  interpreta como "Bueno". Solo se guardan filas para R, M o N/A.
- **Validaciones duras** (frontend + base de datos): ítem en R/M sin
  observación — bloqueado por un `CHECK` de tabla, siempre, no solo al
  enviar. Ítem en M sin foto — validado dentro de la función
  `mtto_enviar_a_revision`, porque depende de una tabla hija (fotos) que no
  se puede expresar como `CHECK`.
- **Inmutabilidad fuera de borrador**: aplicada con triggers
  (`mtto_bloquear_edicion_*`), no solo con RLS — se mantiene incluso si
  algo llega a bypassear las políticas de RLS.
- **Firma = usuario autenticado**: no hay campos de firma ni imágenes; cada
  transición de estado queda en `mtto_orden_evento` (append-only, solo
  escriben las funciones `SECURITY DEFINER`) con `usuario_id` + timestamp
  del servidor.
- **Multi-tenant**: `mtto_vehiculo`, `mtto_orden` y `mtto_usuario_rol`
  llevan `org_id` y quedan aisladas por organización (reutiliza
  `get_my_org_id()` / `is_org_admin()`). El checklist y el catálogo de
  arreglos son maestros **globales** (no llevan `org_id`), tal como se
  definieron sus columnas.
- **Fotos**: bucket privado `mtto-fotos`, subida directa desde el cliente,
  comprimidas en el navegador (máx. 1600px, calidad 0.7) con la utilidad
  `compressImage` que ya existía en el proyecto. Se sirven por URL firmada
  (`MttoService.getFotoUrl`), nunca públicas.
