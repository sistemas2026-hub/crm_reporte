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

## 2b. Personas que firman sin tener cuenta

Además de los usuarios con cuenta, el módulo admite **firmantes sin cuenta**:
personas registradas solo dentro del módulo (nombre, documento, cargo, rol y
un PIN), que **no pueden iniciar sesión** pero sí revisar y aprobar órdenes
desde el celular del mecánico.

Se administran en **Mantenimiento → Personal de Mantenimiento**
(`/mantenimiento/personal`), solo por un admin del módulo. El flujo es:

1. El admin registra a la persona y le asigna un **PIN inicial**.
2. Se lo entrega en persona.
3. La primera vez que firma, la persona usa **"Cambiar mi PIN"** en la
   pantalla de firma. Desde ese momento solo ella lo conoce.

**Por qué importa el paso 3:** mientras el PIN sea el que puso el admin,
quien lo creó podría firmar en nombre de esa persona. La pantalla de personal
marca en ámbar a quienes todavía tienen el PIN puesto por el admin, y en
verde a quienes ya lo cambiaron. Conviene revisarla periódicamente.

La firma queda igual de auditable que la de un usuario con cuenta: se guarda
el id del firmante y la hora del servidor en `mtto_orden_evento`
(append-only), y en la orden queda en `revisado_por_firmante` /
`aprobado_por_firmante`. La vista imprimible muestra el nombre y la cédula.

El PIN se guarda con bcrypt, nunca viaja al navegador (el `SELECT` sobre
`pin_hash` está revocado) y se bloquea 15 minutos tras 5 intentos fallidos.

## 2c. Firma por enlace (WhatsApp) — dos factores

Además de firmar en el celular del mecánico, se puede **mandar un enlace**
para que el encargado o el aprobador firmen desde su propio teléfono, cuando
puedan, sin cuenta y sin instalar nada.

En la pestaña *Revisión y aprobación* aparece **"Enviar enlace por WhatsApp"**:
se elige al destinatario, se genera el enlace y se abre WhatsApp con el
mensaje listo (o se copia). La persona lo abre, ve la orden completa —
hallazgos, fotos, cotización y total — y firma con su PIN.

**La seguridad son dos factores:**

| | Qué prueba |
|---|---|
| El enlace | *Algo que tiene*: llegó a su WhatsApp |
| El PIN | *Algo que sabe*: solo él lo conoce |

Si el enlace se reenvía por error, sin el PIN no sirve de nada.

Detalles de la implementación:

- El token tiene la forma `{uuid}.{secreto}`; en la base solo se guarda el
  **hash bcrypt del secreto**, así que ni con acceso a la tabla se pueden
  reconstruir enlaces válidos.
- **Un solo uso** y **caducidad de 48 h**. Generar un enlace nuevo anula el
  anterior de esa misma acción.
- El enlace solo funciona si la orden sigue en el estado que corresponde; si
  alguien ya firmó, deja de servir.
- Las fotos viven en un bucket privado. Como quien abre el enlace no tiene
  sesión, las **URLs firmadas se generan al crear el enlace** (cuando el
  mecánico sí está autenticado) y viajan dentro del token. El bucket nunca
  se abre al público.
- Las funciones `mtto_ver_orden_por_token` y `mtto_firmar_por_token` son las
  únicas otorgadas al rol `anon`, y todo su alcance lo acota el token.

## 2d. El flujo real (corto): dos enlaces

Caso de RAPILINK: el mecánico es externo y no tiene cuenta; el aprobador
tampoco. Solo el administrador y los supervisores tienen usuario.

1. **El administrador** crea la orden (vehículo, tipo de servicio, taller,
   motivo). Queda en `borrador`.
2. En la pestaña *Vehículo*, **"Enviar enlace de diagnóstico"** → se lo manda
   por WhatsApp al **supervisor**.
3. **El supervisor** va al taller, abre el enlace en su celular
   (`/diagnosticar/{token}`), le va preguntando al mecánico, marca los ítems
   en R/M/NA, escribe observaciones, **toma las fotos**, cotiza con el
   catálogo, y envía con su **PIN**.
4. **El administrador** manda el enlace de **aprobación** al aprobador.
5. **El aprobador** abre el enlace, revisa hallazgos, fotos y cotización,
   escribe observaciones y decide (aprobado / parcial / no aprobado) con su
   PIN.

**El paso intermedio de "revisión del encargado de flota" ya no es una parada
aparte.** El envío del supervisor cuenta como diagnóstico *y* como revisión:
la orden pasa de `borrador` directo a `en_aprobacion`. La trazabilidad no se
pierde — se registran los dos eventos firmados por el supervisor, y la orden
guarda `revisado_por` como siempre, así que el aprobador ve quién validó
antes que él. Ver `20260804_mtto_10_flujo_corto.sql`.

El enlace de diagnóstico puede ir a alguien **con cuenta** (el supervisor usa
el PIN que configuró en *Mi PIN*) o **sin cuenta** (registrado en Personal de
Mantenimiento). En ambos casos el PIN es lo que prueba la identidad.

Nadie instaló nada y nadie inició sesión, pero cada paso quedó firmado por
una persona concreta, con hora del servidor y trazabilidad append-only.

**Detalles del diagnóstico por enlace:**

- Todo el diagnóstico se guarda en **una sola llamada al enviar**: así el PIN
  se valida una vez, todo entra en una transacción y las validaciones duras
  (observación en R/M, foto en M, cotización si hay M) corren juntas — son
  exactamente las mismas de `mtto_enviar_a_revision`.
- Mientras llena, el borrador se guarda en el **localStorage del teléfono**,
  para que no se pierda si se cierra el navegador o falla la señal. Se borra
  al enviar con éxito.
- La pantalla le muestra por adelantado qué le falta corregir, en vez de
  dejarlo intentar y fallar.

**Compromiso de seguridad que conviene tener presente:** para que el mecánico
pueda subir fotos sin sesión, el rol `anon` tiene permiso de escritura en el
bucket, pero **solo** bajo la carpeta de una orden que en ese momento tenga un
enlace de diagnóstico vigente, sin usar y en borrador. Queda un riesgo
residual: quien adivinara el UUID de esa orden podría subir archivos durante
esa ventana. Se aceptó porque un UUID no es adivinable en la práctica y la
alternativa —un servicio intermedio con `service_role`— exige desplegar una
Edge Function. Si algún día se quiere cerrar del todo, ese es el camino.

## 2e. Vida útil de los repuestos

Cada arreglo del catálogo puede declarar cuánto dura lo que se instala, en
**kilómetros**, en **meses**, o en ambos (vence el que ocurra primero). Se
carga en *Catálogo de Precios*, junto a los precios de referencia:

| Arreglo | Km | Meses |
|---|---|---|
| Cambio de aceite de motor | 3.000 | 3 |
| Cambio de pastillas de freno delantero | 8.000 | — |
| Cambio de batería | — | 18 |
| Diagnóstico general | — | — |

Se deja vacío en lo que no es cambio de pieza: un diagnóstico o una soldadura
no vencen.

**Cuándo empieza a contar:** al **cerrar la orden**, que es cuando el trabajo
está hecho de verdad. En ese momento `mtto_cerrar_orden` registra en
`mtto_componente_instalado`, por cada reparación **autorizada** cuyo arreglo
tenga vida útil, qué se instaló, en qué vehículo, en qué fecha, con qué
kilometraje, y cuándo vence. También actualiza `mtto_vehiculo.km_actual`.

**Dónde se ve:** en *Historial por Vehículo* aparece el bloque "Vida útil de
los repuestos" con el último cambio de cada pieza y su estado — vigente, por
vencer o vencido. Si una pieza se vuelve a cambiar, el contador se reinicia:
la vista `mtto_v_componente_estado` solo considera la instalación más
reciente de cada arreglo por vehículo.

**LIMITACIÓN IMPORTANTE:** el sistema solo conoce el kilometraje **cuando
entra una orden**. Si un vehículo no vuelve al taller en meses, sigue
creyendo que tiene los km de la última visita, así que **las alertas por
kilometraje llegarán tarde**. Se aceptó a propósito para no imponerle a nadie
un registro periódico de odómetro. Las alertas **por tiempo sí son exactas
siempre**. Si más adelante se quiere precisión en las de km, hay que agregar
una pantalla donde el supervisor anote el kilometraje cada semana.

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
| `/mantenimiento/personal` | Personas que firman con PIN sin tener cuenta (solo admin del módulo) |
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
