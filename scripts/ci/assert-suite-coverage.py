#!/usr/bin/env python3
"""Fail unless every spec file that exists on disk actually ran in CI.

Motivación: la auditoría de despliegue encontró 18 de 27 specs de Playwright que
nunca se ejecutaban en ningún workflow y suites de integración inertes (todas sus
pruebas saltadas porque el job no tenía Postgres). Las guardas previas
—``run-tests-nonempty.sh`` y ``assert-junit-nonempty.py``— no lo detectan: basta
con que *alguna* prueba corra para que den verde.

Esta guarda compara el inventario de ficheros de spec en el árbol con el
inventario de ficheros que aparecen en los informes JUnit **con al menos un caso
ejecutado** (los ``<testcase>`` con hijo ``<skipped/>`` no cuentan). Si alguien
añade una batería que ningún job invoca, o si una suite de integración se queda
sin base de datos y se salta entera, el gate falla.

Uso:

    assert-suite-coverage.py \
      --specs 'apps/web/e2e::*.e2e.ts' \
      --specs 'apps/web::tests/*.integration.test.ts' \
      --junit 'artifacts/e2e/*.xml' --junit 'artifacts/unit/*.xml'

Cada ``--specs`` es ``BASE::GLOB``: ``GLOB`` se resuelve dentro de ``BASE`` y las
claves esperadas son las rutas relativas a ``BASE``, que es exactamente como los
reporters JUnit de Playwright (relativo a ``testDir``) y de Vitest (relativo a la
raíz del workspace) nombran sus ``testsuite``.
"""

from __future__ import annotations

import argparse
import glob
import os
import sys
import xml.etree.ElementTree as ET


def normalise(path: str) -> str:
    return os.path.normpath(path).replace(os.sep, "/")


def expected_specs(spec_args: list[str]) -> dict[str, str]:
    """Devuelve {clave relativa a BASE: ruta desde la raíz del repo}."""
    expected: dict[str, str] = {}
    for raw in spec_args:
        if "::" not in raw:
            raise SystemExit(f"--specs debe ser 'BASE::GLOB', recibido: {raw!r}")
        base, pattern = raw.split("::", 1)
        base = normalise(base)
        matches = sorted(glob.glob(f"{base}/{pattern}", recursive=True))
        if not matches:
            raise SystemExit(f"Gate mal configurado: ningún fichero casa con {raw!r}")
        for match in matches:
            key = normalise(os.path.relpath(match, base))
            expected[key] = normalise(match)
    return expected


def executed_suites(junit_args: list[str]) -> dict[str, int]:
    """Devuelve {nombre de testsuite: casos NO saltados}."""
    paths: list[str] = []
    for pattern in junit_args:
        paths.extend(glob.glob(pattern, recursive=True))
    unique = sorted(set(paths))
    if not unique:
        raise SystemExit("Gate fallido: ningún informe JUnit casó con los patrones dados.")

    executed: dict[str, int] = {}
    for path in unique:
        try:
            root = ET.parse(path).getroot()
        except (OSError, ET.ParseError) as exc:
            raise SystemExit(f"Gate fallido: informe JUnit ilegible {path}: {exc}") from exc
        for suite in root.iter("testsuite"):
            name = suite.get("name")
            if not name:
                continue
            ran = sum(1 for case in suite.iter("testcase") if case.find("skipped") is None)
            key = normalise(name)
            executed[key] = executed.get(key, 0) + ran
    return executed


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--specs", action="append", default=[], metavar="BASE::GLOB")
    parser.add_argument("--junit", action="append", default=[], metavar="GLOB")
    parser.add_argument(
        "--label", default="suites", help="Nombre humano del inventario, sólo para el informe"
    )
    args = parser.parse_args()

    if not args.specs or not args.junit:
        parser.print_usage(sys.stderr)
        return 64

    expected = expected_specs(args.specs)
    executed = executed_suites(args.junit)

    missing: list[str] = []
    inert: list[str] = []
    for key in sorted(expected):
        ran = executed.get(key)
        if ran is None:
            missing.append(expected[key])
        elif ran == 0:
            inert.append(expected[key])

    covered = len(expected) - len(missing) - len(inert)
    print(f"Cobertura de {args.label}: {covered}/{len(expected)} ficheros con casos ejecutados.")

    if missing:
        print(
            "\nGate fallido: estos ficheros de spec EXISTEN pero ningún job los ejecutó\n"
            "(no aparecen en ningún informe JUnit recogido):",
            file=sys.stderr,
        )
        for path in missing:
            print(f"  - {path}", file=sys.stderr)

    if inert:
        print(
            "\nGate fallido: estos ficheros de spec se recogieron pero TODOS sus casos\n"
            "quedaron saltados (suite inerte: falta base de datos o condición previa):",
            file=sys.stderr,
        )
        for path in inert:
            print(f"  - {path}", file=sys.stderr)

    if missing or inert:
        print(
            "\nAñade el fichero a un job del workflow o dale el entorno que necesita.\n"
            "Nunca lo silencies relajando este gate.",
            file=sys.stderr,
        )
        return 65

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
