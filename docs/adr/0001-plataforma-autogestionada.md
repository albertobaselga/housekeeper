# ADR 0001: plataforma autogestionada y contratos de seguridad

## Estado

Aceptado el 7 de agosto de 2026.

## Decisión

Casa Clara se implementa como PWA SvelteKit y TypeScript, con PostgreSQL 18,
Better Auth y un worker Node. Local y staging se ejecutan mediante Docker
Compose. El primer piloto presenta un solo hogar, pero todas las entidades de
dominio y políticas RLS están aisladas por `household_id`.

El navegador nunca es una frontera de autorización. La API fija el contexto de
usuario y membresía dentro de cada transacción; PostgreSQL aplica RLS forzada y
la aplicación recibe solo campos autorizados. Los datos críticos offline viajan
en un snapshot firmado con una concesión máxima de 24 horas.

## Consecuencias

- La demo vanilla queda preservada en el tag `demo-v0.1.0`; su estado local no
  se migra.
- Los contratos versionados viven en `@casa-clara/contracts` y usan cadenas de
  céntimos para no perder precisión al serializar `bigint`.
- El estado laboral cerrado y los libros se corrigen con nuevos asientos, no
  mediante actualizaciones destructivas.
- El entorno de producción queda bloqueado hasta disponer de revisión legal,
  política de retención, host UE, dominio, SMTP y secretos.
