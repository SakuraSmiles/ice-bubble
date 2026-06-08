#!/bin/bash
# rebuild.sh - Rebuild images and recreate containers
set -e
cd "$(dirname "$0")"

echo "=== Building images ==="
docker compose build "$@"

echo "=== Recreating containers ==="
docker compose up -d --force-recreate "$@"

echo "=== Done ==="
docker compose ps
