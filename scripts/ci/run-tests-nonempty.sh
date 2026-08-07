#!/usr/bin/env bash
set -uo pipefail

if (( $# == 0 )); then
  echo "Usage: $0 <test-command> [args...]" >&2
  exit 64
fi

test_output="$(mktemp -t casaclara-tests.XXXXXX)"
trap 'rm -f "${test_output}"' EXIT HUP INT TERM

set +e
"$@" 2>&1 | tee "${test_output}"
command_status=${PIPESTATUS[0]}
set -e

if (( command_status != 0 )); then
  echo "Test command failed with exit code ${command_status}." >&2
  exit "${command_status}"
fi

if grep -Eiq 'no tests (found|collected)|tests?[[:space:]]*[:=]?[[:space:]]*0([^0-9]|$)' "${test_output}"; then
  echo "Quality gate failed: the command reported zero tests." >&2
  exit 65
fi

if grep -Eiq '(^|[[:space:]#])tests?[[:space:]]+[1-9][0-9]*([[:space:]]|$)|(^|[[:space:]])[1-9][0-9]*[[:space:]]+passed([[:space:](]|$)|^1\.\.[1-9][0-9]*$' "${test_output}"; then
  exit 0
fi

echo "Quality gate failed: no positive test count was found in the command output." >&2
echo "Configure a TAP/spec/Playwright reporter or emit a JUnit report and validate it separately." >&2
exit 65
