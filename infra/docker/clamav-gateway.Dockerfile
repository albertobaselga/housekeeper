# syntax=docker/dockerfile:1.17.1
#
# clamd + la pasarela autenticada, en una sola imagen para el host del worker.
# La imagen oficial de ClamAV arranca freshclam y clamd por su propio
# entrypoint; aquí se añade Node solo para la pasarela (unas 130 líneas sin
# dependencias) y se lanzan los dos procesos: clamd escuchando ÚNICAMENTE en
# 127.0.0.1:3310 y la pasarela en 0.0.0.0:3311 con TLS y token.

ARG CLAMAV_IMAGE=clamav/clamav:1.4.5

FROM ${CLAMAV_IMAGE}

USER root
# Node 22 desde el repositorio de Alpine: la pasarela no usa dependencias
# externas, así que basta con el runtime del sistema.
RUN apk add --no-cache nodejs=~22

COPY infra/clamav/gateway.mjs /usr/local/lib/clamav-gateway.mjs
COPY infra/clamav/entrypoint.sh /usr/local/bin/casaclara-clamav
RUN chmod +x /usr/local/bin/casaclara-clamav

ENV CLAMAV_GATEWAY_PORT=3311 \
    CLAMAV_UPSTREAM_HOST=127.0.0.1 \
    CLAMAV_UPSTREAM_PORT=3310

EXPOSE 3311
ENTRYPOINT ["/usr/local/bin/casaclara-clamav"]
