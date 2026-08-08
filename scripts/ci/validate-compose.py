#!/usr/bin/env python3
"""Structural checks used when Docker Compose is unavailable."""

from __future__ import annotations

import pathlib
import sys

import yaml


SELF_HOSTED = {"caddy", "postgres", "web", "worker", "minio", "mailpit", "clamav"}
# infra/compose.worker.yml despliega SOLO las dos piezas que no caben en una
# función serverless; su base de datos es Supabase y su almacén, Supabase
# Storage, así que no puede traer postgres, minio, caddy ni web.
WORKER_HOST = {"worker", "clamav"}
ONE_SHOT = {"minio-init", "db-backup", "object-backup"}


def fail(message: str) -> None:
    raise ValueError(message)


def expected_services(path: pathlib.Path) -> set[str]:
    return WORKER_HOST if path.name == "compose.worker.yml" else SELF_HOSTED


def validate(path: pathlib.Path) -> None:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("services"), dict):
        fail(f"{path}: missing services mapping")

    services = data["services"]
    missing = expected_services(path) - services.keys()
    if missing:
        fail(f"{path}: missing required services: {', '.join(sorted(missing))}")

    if "postgres" in services:
        postgres_image = str(services["postgres"].get("image", ""))
        if not postgres_image.startswith("postgres:18."):
            fail(f"{path}: PostgreSQL must be pinned to major 18 and a minor tag")

        profiles = {
            profile
            for service in services.values()
            for profile in service.get("profiles", [])
        }
        if not {"observability", "backup"}.issubset(profiles):
            fail(f"{path}: observability and backup profiles are required")

    for name, service in services.items():
        image = str(service.get("image", ""))
        if image and (image.endswith(":latest") or ":" not in image.rsplit("/", 1)[-1]):
            fail(f"{path}: service {name} has an unversioned image: {image}")
        if name not in ONE_SHOT and "healthcheck" not in service:
            fail(f"{path}: long-running service {name} has no healthcheck")

    print(f"Compose structure valid: {path}")


def main() -> int:
    try:
        for raw_path in sys.argv[1:]:
            validate(pathlib.Path(raw_path))
    except (OSError, yaml.YAMLError, ValueError) as exc:
        print(f"Compose validation failed: {exc}", file=sys.stderr)
        return 65
    return 0


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <compose.yml> [...]", file=sys.stderr)
        raise SystemExit(64)
    raise SystemExit(main())
