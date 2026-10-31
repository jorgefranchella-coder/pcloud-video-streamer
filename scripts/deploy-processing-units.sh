#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo 'Ejecutá este script con sudo.' >&2
  exit 1
fi

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
timers=(pcloud-video-indexer.timer pcloud-video-visual.timer \
  pcloud-video-face-indexer.timer pcloud-video-refinement.timer)
active_timers=()
for timer in "${timers[@]}"; do
  if systemctl is-active --quiet "$timer"; then active_timers+=("$timer"); fi
done
restore_timers() {
  if [[ ${#active_timers[@]} -gt 0 ]]; then systemctl start "${active_timers[@]}" || true; fi
}
trap restore_timers ERR
systemctl stop pcloud-video-indexer.timer pcloud-video-visual.timer \
  pcloud-video-face-indexer.timer pcloud-video-refinement.timer 2>/dev/null || true
services=(pcloud-video-indexer.service pcloud-video-visual.service \
  pcloud-video-face-indexer.service pcloud-video-refinement.service)
for attempt in {1..360}; do
  busy=0
  for service in "${services[@]}"; do
    if systemctl is-active --quiet "$service"; then busy=1; fi
  done
  if [[ $busy -eq 0 ]]; then break; fi
  if [[ $attempt -eq 360 ]]; then
    echo 'Hay un lote activo después de 30 minutos. No se instaló nada; revisá systemctl status.' >&2
    restore_timers
    exit 1
  fi
  sleep 5
done
for unit in \
  pcloud-video-indexer.service pcloud-video-indexer.timer \
  pcloud-video-visual.service pcloud-video-visual.timer \
  pcloud-video-face-indexer.service pcloud-video-face-indexer.timer \
  pcloud-video-refinement.service pcloud-video-refinement.timer; do
  install -m 644 "$repo_dir/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl restart pcloud-video-streamer.service
systemctl enable --now pcloud-video-indexer.timer pcloud-video-visual.timer \
  pcloud-video-face-indexer.timer pcloud-video-refinement.timer
systemctl restart pcloud-video-indexer.timer
trap - ERR
systemctl list-timers --all --no-pager 'pcloud-video-*'
