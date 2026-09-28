#!/usr/bin/env bash
# Network watchdog for the weather station Pi: notices when the Wi-Fi link has
# died and repairs it, escalating step by step. Run every 2 minutes by
# network-watchdog.timer, as root. See docs/network.md.
#
# Why it exists: the Pi lives in a shed at the edge of the house Wi-Fi (~-85 dBm).
# On 2026-09-27 the link dropped at 22:51 and NetworkManager never brought it
# back — the collector kept recording, but nothing uploaded for 10 hours until
# someone power-cycled the Pi. Nothing is lost while offline (SQLite buffers
# every record), so the only job here is to get the link back without a human.
#
# "Dead" means the router itself doesn't answer — not a slow link (1 Mbit/s and
# seconds of latency are normal out there), and not the internet being down
# (restarting our Wi-Fi can't fix the ISP, so that case is left alone).
#
# Escalation, counted in consecutive failed checks (2 min apart):
#   2 failures  (~4 min)   re-activate the Wi-Fi connection
#   4 failures  (~8 min)   toggle the Wi-Fi radio off and on
#   6 failures  (~12 min)  restart NetworkManager
#   8 failures  (~16 min)  reload the Wi-Fi driver (brcmfmac)
#   15 failures (~30 min)  reboot — at most once every REBOOT_MIN_GAP_H hours,
#                          and never within the first hour after a boot, so a
#                          router that's simply switched off can't cause a loop
# Between steps, and after the last one, it keeps re-running the cheapest fix
# every 5th failure. Any successful check resets the count.
#
# Settings (environment, e.g. from the .service file):
#   WATCHDOG_TARGET      host to probe; default = the default gateway
#   WATCHDOG_DRY_RUN=1   log what it would do, change nothing
#   REBOOT_MIN_GAP_H     minimum hours between watchdog reboots (default 6)
#   WATCHDOG_STATE_DIR, WATCHDOG_REBOOT_STAMP, WATCHDOG_UPTIME_S
#                        test hooks only (paths and uptime), see docs/network.md

set -u

# tmpfs, so the failure count resets on every boot:
STATE_DIR=${WATCHDOG_STATE_DIR:-/run/network-watchdog}
# survives reboots, so the reboot rate limit does too:
REBOOT_STAMP=${WATCHDOG_REBOOT_STAMP:-/var/lib/network-watchdog/last-reboot}
REBOOT_MIN_GAP_H=${REBOOT_MIN_GAP_H:-6}
DRY_RUN=${WATCHDOG_DRY_RUN:-0}

log() { logger -t network-watchdog -- "$*"; echo "$*"; }

run() {
  if [ "$DRY_RUN" = 1 ]; then
    log "dry run: would run: $*"
  else
    log "running: $*"
    "$@" || log "command failed ($?): $*"
  fi
}

mkdir -p "$STATE_DIR" "$(dirname "$REBOOT_STAMP")"
fails_file=$STATE_DIR/fails
fails=$(cat "$fails_file" 2>/dev/null || echo 0)

target=${WATCHDOG_TARGET:-$(ip route show default 2>/dev/null | awk '/default/ {print $3; exit}')}

# Three pings, up to 5 s each: the shed link can take seconds to answer, and one
# reply is enough to call the link alive.
if [ -n "$target" ] && ping -c 3 -W 5 -q "$target" >/dev/null 2>&1; then
  if [ "$fails" -gt 0 ]; then
    log "link back: $target answers after $fails failed check(s)"
  fi
  echo 0 >"$fails_file"
  exit 0
fi

fails=$((fails + 1))
echo "$fails" >"$fails_file"
log "check $fails failed: ${target:-no default route} not reachable"

conn=$(nmcli -t -f NAME,TYPE connection show 2>/dev/null |
  awk -F: '$2 == "802-11-wireless" {print $1; exit}')

wifi_reconnect() {
  if [ -n "$conn" ]; then
    run nmcli connection up "$conn"
  else
    run nmcli device connect wlan0
  fi
}

uptime_s=${WATCHDOG_UPTIME_S:-$(cut -d. -f1 /proc/uptime)}

may_reboot() {
  [ "$uptime_s" -ge 3600 ] || { log "not rebooting: up only ${uptime_s}s"; return 1; }
  if [ -f "$REBOOT_STAMP" ]; then
    local last now
    last=$(cat "$REBOOT_STAMP")
    now=$(date +%s)
    if [ $((now - last)) -lt $((REBOOT_MIN_GAP_H * 3600)) ]; then
      log "not rebooting: last watchdog reboot was under ${REBOOT_MIN_GAP_H}h ago"
      return 1
    fi
  fi
  return 0
}

case "$fails" in
  2) wifi_reconnect ;;
  4) run nmcli radio wifi off; [ "$DRY_RUN" = 1 ] || sleep 5; run nmcli radio wifi on ;;
  6) run systemctl restart NetworkManager ;;
  8)
    run modprobe -r brcmfmac
    [ "$DRY_RUN" = 1 ] || sleep 3
    run modprobe brcmfmac
    ;;
  *)
    if [ "$fails" -ge 15 ] && may_reboot; then
      log "rebooting: link down for $fails checks"
      if [ "$DRY_RUN" = 1 ]; then
        log "dry run: would reboot"
      else
        date +%s >"$REBOOT_STAMP"
        systemctl reboot
      fi
    elif [ "$fails" -gt 8 ] && [ $((fails % 5)) -eq 0 ]; then
      wifi_reconnect
    fi
    ;;
esac
exit 0
