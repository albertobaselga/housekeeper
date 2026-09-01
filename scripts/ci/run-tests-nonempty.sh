#!/usr/bin/env bash
set -uo pipefail

if (( $# == 0 )); then
  echo "Usage: $0 <test-command> [args...]" >&2
  exit 64
fi

test_output="$(mktemp -t housekeeper-tests.XXXXXX)"
plain_output="$(mktemp -t housekeeper-tests-plain.XXXXXX)"
trap 'rm -f "${test_output}" "${plain_output}"' EXIT HUP INT TERM

set +e
"$@" 2>&1 | tee "${test_output}"
command_status=${PIPESTATUS[0]}
set -e

if (( command_status != 0 )); then
  echo "Test command failed with exit code ${command_status}." >&2
  exit "${command_status}"
fi

# Los recuentos se buscan sobre una copia SIN secuencias ANSI. Vitest colorea su
# resumen precisamente cuando CI=true (tinyrainbow activa color si detecta CI),
# de modo que "23 passed" llega como "\e[1m\e[32m23 passed\e[39m" y los anclajes
# de espacio en blanco de los patrones de abajo no casaban: la guarda daba
# «no positive test count» sobre una suite perfectamente verde.
sed -E $'s/\033\\[[0-9;?]*[ -\/]*[@-~]//g' "${test_output}" > "${plain_output}"

if grep -Eiq 'no tests (found|collected)|tests?[[:space:]]*[:=]?[[:space:]]*0([^0-9]|$)' "${plain_output}"; then
  echo "Quality gate failed: the command reported zero tests." >&2
  exit 65
fi

if grep -Eiq '(^|[[:space:]#])tests?[[:space:]]+[1-9][0-9]*([[:space:]]|$)|(^|[[:space:]])[1-9][0-9]*[[:space:]]+passed([[:space:](]|$)|^1\.\.[1-9][0-9]*$' "${plain_output}"; then
  exit 0
fi

echo "Quality gate failed: no positive test count was found in the command output." >&2
echo "Configure a TAP/spec/Playwright reporter or emit a JUnit report and validate it separately." >&2
exit 65
