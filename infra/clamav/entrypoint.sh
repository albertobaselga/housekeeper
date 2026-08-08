#!/bin/sh
# Arranca clamd (por el entrypoint oficial de la imagen, /init) y, en paralelo,
# la pasarela autenticada. Si cualquiera de los dos muere, muere el contenedor:
# un antivirus a medias es peor que ninguno, porque la web recibiría respuestas
# incoherentes en vez del 503 limpio que ya sabe traducir.
#
# El shell de la imagen es busybox ash, que NO tiene `wait -n`: la supervisión
# se hace sondeando con `kill -0`, que es POSIX y suficiente para dos procesos.
set -eu

: "${CLAMAV_GATEWAY_TOKEN:?CLAMAV_GATEWAY_TOKEN es obligatorio}"
: "${CLAMAV_GATEWAY_CERT:?CLAMAV_GATEWAY_CERT es obligatorio}"
: "${CLAMAV_GATEWAY_KEY:?CLAMAV_GATEWAY_KEY es obligatorio}"

# clamd solo en loopback: el único camino desde fuera es la pasarela.
cat >/etc/clamav/clamd.conf <<'CONF'
LogTime yes
LogFile /dev/stdout
DatabaseDirectory /var/lib/clamav
TCPSocket 3310
TCPAddr 127.0.0.1
MaxScanSize 64M
MaxFileSize 32M
StreamMaxLength 32M
Foreground yes
CONF

/init &
clamd_pid=$!

node /usr/local/lib/clamav-gateway.mjs &
gateway_pid=$!

stop() {
  kill -TERM "${clamd_pid}" "${gateway_pid}" 2>/dev/null || true
}
trap stop INT TERM

while kill -0 "${clamd_pid}" 2>/dev/null && kill -0 "${gateway_pid}" 2>/dev/null; do
  sleep 5
done

echo "[casaclara-clamav] uno de los procesos ha terminado; parando el contenedor" >&2
stop
exit 1
