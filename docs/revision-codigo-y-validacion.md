# Revisión de código y validación funcional

**Fecha:** 6 de agosto de 2026  
**Documento contrastado:** brief de producto y arquitectura, versión 2  
**Resultado:** prototipo navegable válido para demostración; no cumple todavía la especificación de producción.

## Veredicto ejecutivo

- **6 criterios cumplen**, **9 son parciales** y **11 no están implementados**.
- No se encontraron fallos P0/P1 reproducibles dentro del alcance declarado de la demo después de las correcciones de esta revisión.
- La aplicación **no debe recibir datos reales**: el bundle contiene todos los datos semilla y no existe API de dominio, Postgres ni RLS.
- El núcleo laboral sigue siendo una simulación: acuerdos, extras y saldos locales no generan las líneas de liquidación, que proceden de un snapshot fijo.

## Hallazgos abiertos

### Alta prioridad antes de producción

1. **Aislamiento de datos inexistente.** `data.js` se entrega y cachea completo. Las sesiones demo controlan la experiencia, no el acceso al dato. Se necesita API con filtrado previo, Postgres multi-tenant y RLS por hogar, rol y campo.
2. **Motor laboral desconectado.** `settlementLines` es fijo; no se deriva de versiones de acuerdo, eventos, anticipos y gastos. Los invariantes de no retroactividad e inmutabilidad no están garantizados por un libro.
3. **Sin sincronización real.** La outbox conserva operaciones, pero no tiene transporte, idempotencia, ACK parcial ni resolución de conflictos. Las fotos no se conservan.
4. **Seguridad alimentaria parcial.** El modal usa los alérgenos declarados en la receta; no cruza una asignación con los comensales concretos de la franja.
5. **Documentos e integraciones simulados.** PDFs, hash, OCR, ICS y notificaciones WhatsApp no tienen implementación de servidor.

### Deuda de calidad

- El snapshot crítico se guarda pero todavía no se usa para hidratar datos remotos con antigüedad máxima de 24 horas.
- Faltan pruebas automatizadas de service worker, IndexedDB, accesibilidad, rendimiento y flujos completos de navegador.
- La sesión offline conserva un perfil público local hasta su caducidad. Es útil para la demo, pero manipulable y no válida como autorización real.
- Solo hay interfaz en español; faltan i18n, traducción de contenido y pipeline de media.

## Correcciones realizadas durante la revisión

- Sustitución del selector libre de perfiles por login local y cookie `HttpOnly`.
- Cinco cuentas demo y permisos explícitos; los roles desconocidos quedan denegados por defecto.
- `family_member` puede leer empleo y editar contenido, pero no salario, pagos ni confirmaciones administrativas.
- `viewer` queda limitado a Hoy, calendario operativo, contactos y emergencias.
- `.env` ignorado por Git, `.env.example` reproducible y servidor con lista cerrada de recursos.
- Redondeo monetario simétrico corregido para casos como `±10,075`.
- Gastos locales visibles y escrituras conservadas en outbox también cuando hay red pero no backend.
- Ediciones locales de wiki incorporadas al buscador.
- Foco tras navegación, popovers con foco/teclado, pestañas laborales y de menú con semántica ARIA.
- Fallback offline de navegación corregido y autenticación demo offline con caducidad.
- Navegación móvil adaptable, contraste del contador y comportamiento en colores forzados mejorados.

## Matriz de los 26 criterios de aceptación

| # | Estado | Validación |
|---:|:---:|---|
| 1 | Parcial | Marzo permanece fijo al editar el acuerdo, pero no hay motor temporal general. |
| 2 | Parcial | La línea semilla 09/03 tiene tarifa y origen navegable; nuevas extras no alimentan la liquidación. |
| 3 adaptado | Parcial | Existe el ejemplo 0 €/+1 día permanente; el saldo aún no nace de un libro real en la demo heredada. |
| 4 | Parcial | La excepción pendiente no desaparece localmente; faltan aprobación y máquina de estados completas. |
| 5 | No | Hoy muestra una liquidación histórica, no devengo proyectado del mes en curso. |
| 6 | No | No hay cierre real, vencimiento generado, evento ni aviso D-3. |
| 7 | Parcial | Pagos parciales, fecha, importe y método funcionan; el justificante no se guarda. |
| 8 | Cumple | Ana solo puede confirmar tras cubrir el total y se registra sello temporal. |
| 9 | Parcial | La deuda sigue visible; no hay reloj ni escalado automático de avisos. |
| 10 | Parcial | La pantalla se recarga offline tras una visita; no se certificó el presupuesto de 500 ms. |
| 11 | No | El gasto se encola sin foto, pero no existe sincronización ni deduplicación de servidor. |
| 12 | No | `helper` se bloquea en sesión/router, pero no existen endpoints de dominio ni RLS. |
| 13 | No | El CSV y la impresión son parciales; no hay export completo PDF+CSV. |
| 14 | No | No existe importador Markdown con front-matter y jerarquía. |
| 15 | Parcial | Los slugs son estables, pero no hay flujo probado de renombrado con revisiones. |
| 16 | Cumple | `lavadra` devuelve la página de lavadora entre los primeros resultados. |
| 17 | Cumple | `vitro` encuentra la página oficial de placa de inducción. |
| 18 | No | No hay agrupación semántica de búsquedas fallidas ni medición de no-clic. |
| 19 | Cumple | Los contactos permiten llamar directamente desde el resultado. |
| 20 | No | Las lecturas son datos semilla, no agregado real de 30 días. |
| 21 | Parcial | Hay confirmación bloqueante al abrir receta; no se ejecuta al asignarla por comensal. |
| 22 | Cumple | El escalado 4→6 y las unidades no lineales están cubiertos por prueba. |
| 23 | No | Duplicar semana cambia un estado visual, no copia una entidad de semana. |
| 24 | No | La compra es semilla, no agregación calculada con añadidos manuales. |
| 25 | No | No hay rutina trimestral dirigida a familia ni notificación derivada. |
| 26 | Cumple | No se muestran porcentajes ni históricos de cumplimiento de rutinas. |

## Validación ejecutada

- 16/16 pruebas Node superadas.
- Sintaxis válida en todos los módulos JavaScript y JSON.
- Cinco cuentas autenticadas en Chrome con rol correcto y logout funcional.
- Guardas verificadas para administrador, familiar, empleada, apoyo y acceso puntual.
- Recarga offline comprobada con service worker `casa-clara-shell-v5`.
- `.env`, `server.mjs` y `.git/config` responden 404 desde el servidor público.

## Decisión de salida

La demo está lista para pruebas de producto con información ficticia. No está lista para piloto real ni para aceptar datos de una trabajadora o menores. El siguiente hito debe ser la Fase 1 de backend y seguridad, no ampliar más la simulación visual.
