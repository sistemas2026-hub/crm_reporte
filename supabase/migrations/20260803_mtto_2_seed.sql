-- ============================================================
-- MÓDULO DE MANTENIMIENTO VEHICULAR (mtto_*)
-- Fase 2/3: datos semilla — checklist (97 ítems), catálogo de
-- arreglos (107) y flota (5 vehículos). Idempotente (ON CONFLICT).
--
-- Requiere haber corrido 20260803_mtto_1_schema.sql antes.
--
-- IMPORTANTE sobre la flota: los vehículos SÍ son datos operativos
-- de la organización (llevan org_id), y como este script corre en
-- el SQL Editor (sesión sin JWT de usuario), no puede resolver
-- org_id con get_my_org_id(). Se toma la PRIMERA organización que
-- exista en public.organizations. Si en su instancia ya hay más de
-- una organización, ajuste el WHERE de esa sección antes de correr.
--
-- No se inventan placas, motor, chasis, vencimientos ni precios de
-- referencia: quedan NULL a propósito para que el cliente los cargue.
-- ============================================================

-- ============================================================
-- A. SECCIONES DEL CHECKLIST (11)
-- ============================================================
INSERT INTO public.mtto_checklist_seccion (orden, nombre, aplica) VALUES
(1,  'Motor', NULL),
(2,  'Transmisión y relación', NULL),
(3,  'Sistema de combustible', NULL),
(4,  'Frenos', NULL),
(5,  'Dirección y suspensión', NULL),
(6,  'Llantas y rines', NULL),
(7,  'Sistema eléctrico', NULL),
(8,  'Carrocería y estructura', NULL),
(9,  'Tráiler y enganche', ARRAY['moto_trailer']::public.mtto_tipo_vehiculo[]),
(10, 'Equipo ISP — escalera y portaescalera', NULL),
(11, 'Seguridad y documentación', NULL)
ON CONFLICT (nombre) DO UPDATE SET orden = EXCLUDED.orden, aplica = EXCLUDED.aplica;

-- ============================================================
-- B. ÍTEMS DEL CHECKLIST (97) — * = crítico
-- ============================================================

-- 1. Motor (10)
INSERT INTO public.mtto_checklist_item (seccion_id, orden, nombre, critico)
SELECT s.id, v.orden, v.nombre, v.critico
FROM public.mtto_checklist_seccion s, (VALUES
    (1,  'Nivel y estado del aceite de motor', true),
    (2,  'Fugas de aceite en motor', false),
    (3,  'Funcionamiento del carburador (ralentí y aceleración)', false),
    (4,  'Arranque en frío y en caliente', false),
    (5,  'Filtro de aire', false),
    (6,  'Bujía (estado y calibración)', false),
    (7,  'Ruidos anormales del motor', true),
    (8,  'Humo del exosto (color y cantidad)', false),
    (9,  'Exosto / silenciador', false),
    (10, 'Soportes y tornillería del motor', true)
) AS v(orden, nombre, critico)
WHERE s.nombre = 'Motor'
ON CONFLICT (seccion_id, nombre) DO UPDATE SET orden = EXCLUDED.orden, critico = EXCLUDED.critico;

-- 2. Transmisión y relación (9)
INSERT INTO public.mtto_checklist_item (seccion_id, orden, nombre, critico)
SELECT s.id, v.orden, v.nombre, v.critico
FROM public.mtto_checklist_seccion s, (VALUES
    (1, 'Embrague (juego, patinaje, agarre)', true),
    (2, 'Cambios (entrada y salida de marchas)', false),
    (3, 'Cadena: tensión, lubricación y desgaste', true),
    (4, 'Piñón y sprocket (desgaste de dientes)', true),
    (5, 'Guardacadena y protectores', false),
    (6, 'Guaya de embrague', false),
    (7, 'Guaya de acelerador', true),
    (8, 'Diferencial / corona — ruido y fugas', false),
    (9, 'Nivel de aceite de transmisión', false)
) AS v(orden, nombre, critico)
WHERE s.nombre = 'Transmisión y relación'
ON CONFLICT (seccion_id, nombre) DO UPDATE SET orden = EXCLUDED.orden, critico = EXCLUDED.critico;

-- 3. Sistema de combustible (5)
INSERT INTO public.mtto_checklist_item (seccion_id, orden, nombre, critico)
SELECT s.id, v.orden, v.nombre, v.critico
FROM public.mtto_checklist_seccion s, (VALUES
    (1, 'Tanque de combustible (fugas, abolladuras)', true),
    (2, 'Tapa del tanque y respiradero', false),
    (3, 'Llave de paso de gasolina', false),
    (4, 'Mangueras y abrazaderas', true),
    (5, 'Filtro de gasolina', false)
) AS v(orden, nombre, critico)
WHERE s.nombre = 'Sistema de combustible'
ON CONFLICT (seccion_id, nombre) DO UPDATE SET orden = EXCLUDED.orden, critico = EXCLUDED.critico;

-- 4. Frenos (7)
INSERT INTO public.mtto_checklist_item (seccion_id, orden, nombre, critico)
SELECT s.id, v.orden, v.nombre, v.critico
FROM public.mtto_checklist_seccion s, (VALUES
    (1, 'Freno delantero (recorrido y respuesta)', true),
    (2, 'Freno trasero (recorrido y respuesta)', true),
    (3, 'Pastillas / bandas (espesor restante)', true),
    (4, 'Discos / campanas (desgaste, alabeo)', true),
    (5, 'Nivel y estado del líquido de frenos', true),
    (6, 'Mangueras y guayas de freno', true),
    (7, 'Freno de estacionamiento', false)
) AS v(orden, nombre, critico)
WHERE s.nombre = 'Frenos'
ON CONFLICT (seccion_id, nombre) DO UPDATE SET orden = EXCLUDED.orden, critico = EXCLUDED.critico;

-- 5. Dirección y suspensión (8)
INSERT INTO public.mtto_checklist_item (seccion_id, orden, nombre, critico)
SELECT s.id, v.orden, v.nombre, v.critico
FROM public.mtto_checklist_seccion s, (VALUES
    (1, 'Juego de dirección / rodamientos de tijera', true),
    (2, 'Manubrio (alineación, fijación, puños)', true),
    (3, 'Telescópicos delanteros (fugas)', false),
    (4, 'Amortiguadores traseros', false),
    (5, 'Ballestas / suspensión trasera', false),
    (6, 'Basculante y bujes', false),
    (7, 'Rodamientos de ruedas', true),
    (8, 'Alineación de ruedas', false)
) AS v(orden, nombre, critico)
WHERE s.nombre = 'Dirección y suspensión'
ON CONFLICT (seccion_id, nombre) DO UPDATE SET orden = EXCLUDED.orden, critico = EXCLUDED.critico;

-- 6. Llantas y rines (7)
INSERT INTO public.mtto_checklist_item (seccion_id, orden, nombre, critico)
SELECT s.id, v.orden, v.nombre, v.critico
FROM public.mtto_checklist_seccion s, (VALUES
    (1, 'Llanta delantera — labrado y presión', true),
    (2, 'Llanta trasera izquierda', true),
    (3, 'Llanta trasera derecha', true),
    (4, 'Llanta de repuesto', false),
    (5, 'Rines (fisuras, torceduras, rayos)', true),
    (6, 'Válvulas y tapaválvulas', false),
    (7, 'Tuercas y ejes de rueda (apriete)', true)
) AS v(orden, nombre, critico)
WHERE s.nombre = 'Llantas y rines'
ON CONFLICT (seccion_id, nombre) DO UPDATE SET orden = EXCLUDED.orden, critico = EXCLUDED.critico;

-- 7. Sistema eléctrico (12)
INSERT INTO public.mtto_checklist_item (seccion_id, orden, nombre, critico)
SELECT s.id, v.orden, v.nombre, v.critico
FROM public.mtto_checklist_seccion s, (VALUES
    (1,  'Batería (carga, bornes, sujeción)', false),
    (2,  'Sistema de carga (regulador / estator)', false),
    (3,  'Arranque eléctrico y patada', false),
    (4,  'Luz alta y luz baja', true),
    (5,  'Luz de freno / stop', true),
    (6,  'Direccionales delanteras y traseras', true),
    (7,  'Luz de placa', false),
    (8,  'Pito / bocina', true),
    (9,  'Tablero, velocímetro e indicadores', false),
    (10, 'Arnés y cableado', true),
    (11, 'Switch de encendido y llaves', false),
    (12, 'Fusibles', false)
) AS v(orden, nombre, critico)
WHERE s.nombre = 'Sistema eléctrico'
ON CONFLICT (seccion_id, nombre) DO UPDATE SET orden = EXCLUDED.orden, critico = EXCLUDED.critico;

-- 8. Carrocería y estructura (10)
INSERT INTO public.mtto_checklist_item (seccion_id, orden, nombre, critico)
SELECT s.id, v.orden, v.nombre, v.critico
FROM public.mtto_checklist_seccion s, (VALUES
    (1,  'Chasis (fisuras, soldaduras, alineación)', true),
    (2,  'Platón / furgón / cajón de carga', false),
    (3,  'Compuertas, bisagras y seguros', false),
    (4,  'Piso y estructura de carga', false),
    (5,  'Espejos retrovisores', true),
    (6,  'Guardabarros y salpicaderas', false),
    (7,  'Sillín / asiento y espaldar', false),
    (8,  'Parabrisas, carpa o cabina', false),
    (9,  'Estriberas y pedales', false),
    (10, 'Pintura y logos de la empresa', false)
) AS v(orden, nombre, critico)
WHERE s.nombre = 'Carrocería y estructura'
ON CONFLICT (seccion_id, nombre) DO UPDATE SET orden = EXCLUDED.orden, critico = EXCLUDED.critico;

-- 9. Tráiler y enganche — solo aplica a moto_trailer (8)
INSERT INTO public.mtto_checklist_item (seccion_id, orden, nombre, critico, aplica)
SELECT s.id, v.orden, v.nombre, v.critico, ARRAY['moto_trailer']::public.mtto_tipo_vehiculo[]
FROM public.mtto_checklist_seccion s, (VALUES
    (1, 'Enganche / perno de tiro (juego y seguro)', true),
    (2, 'Cadena o guaya de seguridad', true),
    (3, 'Estructura y chasis del tráiler', true),
    (4, 'Eje y rodamientos del tráiler', true),
    (5, 'Suspensión del tráiler', false),
    (6, 'Llantas del tráiler', true),
    (7, 'Luces del tráiler y conector eléctrico', true),
    (8, 'Compuerta y amarres de carga', true)
) AS v(orden, nombre, critico)
WHERE s.nombre = 'Tráiler y enganche'
ON CONFLICT (seccion_id, nombre) DO UPDATE SET orden = EXCLUDED.orden, critico = EXCLUDED.critico, aplica = EXCLUDED.aplica;

-- 10. Equipo ISP — escalera y portaescalera (10)
INSERT INTO public.mtto_checklist_item (seccion_id, orden, nombre, critico)
SELECT s.id, v.orden, v.nombre, v.critico
FROM public.mtto_checklist_seccion s, (VALUES
    (1,  'Portaescalera: soportes y soldaduras', true),
    (2,  'Portaescalera: tornillería y apriete', true),
    (3,  'Portaescalera: gomas, topes y protección', false),
    (4,  'Amarres, correas o seguros de la escalera', true),
    (5,  'Escalera: peldaños (fisuras, deformación)', true),
    (6,  'Escalera: zapatas antideslizantes', true),
    (7,  'Escalera: seguros, pasadores y articulaciones', true),
    (8,  'Escalera: rieles y remaches', true),
    (9,  'Anclajes de herramienta y carrete de fibra', false),
    (10, 'Compartimiento de herramienta', false)
) AS v(orden, nombre, critico)
WHERE s.nombre = 'Equipo ISP — escalera y portaescalera'
ON CONFLICT (seccion_id, nombre) DO UPDATE SET orden = EXCLUDED.orden, critico = EXCLUDED.critico;

-- 11. Seguridad y documentación (11)
INSERT INTO public.mtto_checklist_item (seccion_id, orden, nombre, critico)
SELECT s.id, v.orden, v.nombre, v.critico
FROM public.mtto_checklist_seccion s, (VALUES
    (1,  'SOAT vigente', true),
    (2,  'Revisión técnico-mecánica vigente', true),
    (3,  'Tarjeta de propiedad en el vehículo', true),
    (4,  'Licencia de conducción del responsable', true),
    (5,  'Casco(s) en buen estado', true),
    (6,  'Chaleco reflectivo', true),
    (7,  'Cinta reflectiva del vehículo', false),
    (8,  'Kit de carretera y botiquín', false),
    (9,  'Extintor (carga y fecha)', true),
    (10, 'Conos y señalización vial', false),
    (11, 'Limpieza general', false)
) AS v(orden, nombre, critico)
WHERE s.nombre = 'Seguridad y documentación'
ON CONFLICT (seccion_id, nombre) DO UPDATE SET orden = EXCLUDED.orden, critico = EXCLUDED.critico;

-- ============================================================
-- C. SISTEMAS DEL CATÁLOGO DE ARREGLOS (11)
-- ============================================================
INSERT INTO public.mtto_catalogo_sistema (orden, nombre) VALUES
(1,  'Motor'),
(2,  'Transmisión y relación'),
(3,  'Sistema de combustible'),
(4,  'Frenos'),
(5,  'Dirección y suspensión'),
(6,  'Llantas y rines'),
(7,  'Sistema eléctrico'),
(8,  'Carrocería y estructura'),
(9,  'Tráiler y enganche'),
(10, 'Equipo ISP — escalera y portaescalera'),
(11, 'Preventivo y otros')
ON CONFLICT (nombre) DO UPDATE SET orden = EXCLUDED.orden;

-- ============================================================
-- D. CATÁLOGO DE ARREGLOS (107) — precios en NULL a propósito
-- ============================================================

INSERT INTO public.mtto_catalogo_arreglo (sistema_id, nombre)
SELECT s.id, v.nombre
FROM public.mtto_catalogo_sistema s, (VALUES
    ('Ajuste / sincronización de carburador'),
    ('Limpieza de carburador'),
    ('Cambio de kit de carburador'),
    ('Cambio de aceite de motor'),
    ('Cambio de filtro de aceite'),
    ('Cambio de filtro de aire'),
    ('Cambio de bujía'),
    ('Calibración de válvulas'),
    ('Reparación de culata'),
    ('Cambio de pistón y anillos'),
    ('Rectificación de cilindro'),
    ('Cambio de empaques de motor'),
    ('Cambio de retenedores de motor'),
    ('Reparación general de motor'),
    ('Cambio de cadenilla de distribución y tensor'),
    ('Cambio o reparación de exosto'),
    ('Cambio de soportes de motor')
) AS v(nombre)
WHERE s.nombre = 'Motor'
ON CONFLICT (sistema_id, nombre) DO NOTHING;

INSERT INTO public.mtto_catalogo_arreglo (sistema_id, nombre)
SELECT s.id, v.nombre
FROM public.mtto_catalogo_sistema s, (VALUES
    ('Cambio de kit de arrastre (piñón, cadena, sprocket)'),
    ('Ajuste y lubricación de cadena'),
    ('Cambio de kit de embrague'),
    ('Ajuste de embrague'),
    ('Cambio de guaya de embrague'),
    ('Reparación de caja de cambios'),
    ('Cambio de aceite de transmisión / diferencial'),
    ('Reparación de diferencial y corona'),
    ('Cambio de crucetas / cardán'),
    ('Cambio de guaya de acelerador')
) AS v(nombre)
WHERE s.nombre = 'Transmisión y relación'
ON CONFLICT (sistema_id, nombre) DO NOTHING;

INSERT INTO public.mtto_catalogo_arreglo (sistema_id, nombre)
SELECT s.id, v.nombre
FROM public.mtto_catalogo_sistema s, (VALUES
    ('Limpieza de tanque de combustible'),
    ('Cambio de llave de paso de gasolina'),
    ('Cambio de mangueras de combustible'),
    ('Cambio de filtro de gasolina'),
    ('Reparación o cambio de bomba de gasolina'),
    ('Reparación de fuga en tanque')
) AS v(nombre)
WHERE s.nombre = 'Sistema de combustible'
ON CONFLICT (sistema_id, nombre) DO NOTHING;

INSERT INTO public.mtto_catalogo_arreglo (sistema_id, nombre)
SELECT s.id, v.nombre
FROM public.mtto_catalogo_sistema s, (VALUES
    ('Cambio de pastillas de freno delantero'),
    ('Cambio de bandas / zapatas traseras'),
    ('Rectificación de disco o campana'),
    ('Cambio de disco de freno'),
    ('Cambio de bomba de freno'),
    ('Purga y cambio de líquido de frenos'),
    ('Cambio de mangueras o guayas de freno'),
    ('Ajuste general de frenos'),
    ('Reparación de freno de parqueo')
) AS v(nombre)
WHERE s.nombre = 'Frenos'
ON CONFLICT (sistema_id, nombre) DO NOTHING;

INSERT INTO public.mtto_catalogo_arreglo (sistema_id, nombre)
SELECT s.id, v.nombre
FROM public.mtto_catalogo_sistema s, (VALUES
    ('Cambio de rodamientos de dirección'),
    ('Ajuste de dirección'),
    ('Cambio de retenedores de telescópicos'),
    ('Cambio de aceite de telescópicos'),
    ('Cambio o enderezada de barras'),
    ('Cambio de amortiguadores traseros'),
    ('Cambio de bujes de basculante'),
    ('Cambio de ballestas'),
    ('Alineación de ruedas'),
    ('Cambio de rodamientos de rueda'),
    ('Enderezada de chasis')
) AS v(nombre)
WHERE s.nombre = 'Dirección y suspensión'
ON CONFLICT (sistema_id, nombre) DO NOTHING;

INSERT INTO public.mtto_catalogo_arreglo (sistema_id, nombre)
SELECT s.id, v.nombre
FROM public.mtto_catalogo_sistema s, (VALUES
    ('Cambio de llanta'),
    ('Cambio de neumático (tripa)'),
    ('Despinche / parche'),
    ('Cambio de rin'),
    ('Centrado de rin y rayos'),
    ('Calibración de presión'),
    ('Cambio de válvula de aire')
) AS v(nombre)
WHERE s.nombre = 'Llantas y rines'
ON CONFLICT (sistema_id, nombre) DO NOTHING;

INSERT INTO public.mtto_catalogo_arreglo (sistema_id, nombre)
SELECT s.id, v.nombre
FROM public.mtto_catalogo_sistema s, (VALUES
    ('Cambio de batería'),
    ('Carga de batería y limpieza de bornes'),
    ('Cambio de regulador de voltaje'),
    ('Reparación o cambio de estator'),
    ('Cambio de motor de arranque'),
    ('Reparación o cambio de switch de encendido'),
    ('Cambio de bombillos'),
    ('Cambio de farola'),
    ('Cambio de direccionales'),
    ('Cambio de pito / bocina'),
    ('Reparación de tablero y velocímetro'),
    ('Reparación de arnés / cableado'),
    ('Cambio de CDI o bobina de alta'),
    ('Cambio de fusibles y portafusibles')
) AS v(nombre)
WHERE s.nombre = 'Sistema eléctrico'
ON CONFLICT (sistema_id, nombre) DO NOTHING;

INSERT INTO public.mtto_catalogo_arreglo (sistema_id, nombre)
SELECT s.id, v.nombre
FROM public.mtto_catalogo_sistema s, (VALUES
    ('Soldadura / reparación de chasis'),
    ('Reparación de platón, furgón o cajón'),
    ('Cambio o reparación de compuerta'),
    ('Latonería y pintura'),
    ('Cambio de guardabarros'),
    ('Cambio de espejos retrovisores'),
    ('Cambio o tapizado de sillín'),
    ('Reparación de parabrisas o carpa'),
    ('Cambio de manubrio, manijas o puños'),
    ('Cambio de estriberas y pedales'),
    ('Cambio de cerraduras y candados')
) AS v(nombre)
WHERE s.nombre = 'Carrocería y estructura'
ON CONFLICT (sistema_id, nombre) DO NOTHING;

INSERT INTO public.mtto_catalogo_arreglo (sistema_id, nombre)
SELECT s.id, v.nombre
FROM public.mtto_catalogo_sistema s, (VALUES
    ('Reparación de enganche / perno de tiro'),
    ('Cambio de cadena de seguridad'),
    ('Reparación o cambio de eje'),
    ('Cambio de rodamientos del tráiler'),
    ('Reparación de luces y conector'),
    ('Soldadura de estructura del tráiler'),
    ('Cambio de suspensión del tráiler')
) AS v(nombre)
WHERE s.nombre = 'Tráiler y enganche'
ON CONFLICT (sistema_id, nombre) DO NOTHING;

INSERT INTO public.mtto_catalogo_arreglo (sistema_id, nombre)
SELECT s.id, v.nombre
FROM public.mtto_catalogo_sistema s, (VALUES
    ('Soldadura / refuerzo de portaescalera'),
    ('Cambio de tornillería y amarres'),
    ('Cambio de gomas y topes'),
    ('Reparación de escalera (peldaños, zapatas)'),
    ('Cambio de articulaciones o pasadores'),
    ('Instalación de anclajes de herramienta'),
    ('Reparación de compartimiento de herramienta')
) AS v(nombre)
WHERE s.nombre = 'Equipo ISP — escalera y portaescalera'
ON CONFLICT (sistema_id, nombre) DO NOTHING;

INSERT INTO public.mtto_catalogo_arreglo (sistema_id, nombre)
SELECT s.id, v.nombre
FROM public.mtto_catalogo_sistema s, (VALUES
    ('Mantenimiento preventivo general'),
    ('Lavado y engrase general'),
    ('Diagnóstico general (sin reparación)'),
    ('Cambio de cinta reflectiva'),
    ('Recarga o cambio de extintor'),
    ('Reposición de kit de carretera / botiquín'),
    ('Grúa / traslado del vehículo'),
    ('Otro (describir en observaciones)')
) AS v(nombre)
WHERE s.nombre = 'Preventivo y otros'
ON CONFLICT (sistema_id, nombre) DO NOTHING;

-- ============================================================
-- E. FLOTA (5 vehículos) — placa, motor, chasis y vencimientos
-- quedan NULL; el cliente los carga después.
-- ============================================================
INSERT INTO public.mtto_vehiculo (org_id, codigo, tipo)
SELECT (SELECT id FROM public.organizations ORDER BY created_at LIMIT 1), v.codigo, v.tipo::public.mtto_tipo_vehiculo
FROM (VALUES
    ('MC-01', 'motocarro'),
    ('MC-02', 'motocarro'),
    ('MC-03', 'motocarro'),
    ('MT-01', 'moto_trailer'),
    ('MT-02', 'moto_trailer')
) AS v(codigo, tipo)
WHERE EXISTS (SELECT 1 FROM public.organizations)
ON CONFLICT (org_id, codigo) DO NOTHING;
