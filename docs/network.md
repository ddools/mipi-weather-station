# Network: keeping the shed Pi online

The Pi lives in the shed; the router is in the house. Its Wi-Fi link is marginal
and always will be — measured 2026-09-28:

| | |
|---|---|
| Signal | **−84 to −85 dBm** (reliable Wi-Fi wants better than about −70) |
| Rate | **1–6.5 Mbit/s** (the slowest rates Wi-Fi has) |
| Band | 2.4 GHz, SSID `PhilFiber` |

A slow link is fine: the station uploads a few hundred bytes a minute. A *dead*
link is the problem. On 2026-09-27 the connection dropped at 22:51 and never came
back on its own. The collector kept recording all night — SQLite buffered every
record, nothing was lost — but nothing uploaded for 10.5 hours until the Pi was
power-cycled, and the backlog then took a long time to drain over the weak link.

Two fixes are in place, plus one hardware option.

## 1. Wi-Fi power saving off (done 2026-09-28)

The Pi's Broadcom Wi-Fi chip (`brcmfmac`) is known to drop connections with
power saving on, and it was on. Turned off permanently in NetworkManager:

```bash
sudo nmcli connection modify PhilFiber 802-11-wireless.powersave 2
sudo nmcli connection up PhilFiber
/usr/sbin/iw wlan0 get power_save      # → Power save: off
```

Packet loss to the Pi went from 40% to 0% straight after.

## 2. Network watchdog — the Pi repairs its own connection

`pi/systemd/network-watchdog.sh`, run every 2 minutes by a systemd timer, pings
the router and escalates only while it gets **no answer at all** (a slow reply
counts as alive; an internet outage beyond the router is left alone, since
restarting our Wi-Fi can't fix it):

| Consecutive failed checks | Action |
|---|---|
| 2 (~4 min) | re-activate the Wi-Fi connection (`nmcli connection up`) |
| 4 (~8 min) | Wi-Fi radio off and on |
| 6 (~12 min) | restart NetworkManager |
| 8 (~16 min) | reload the Wi-Fi driver (`brcmfmac`) |
| every 5th after that | re-activate the connection again |
| 15 (~30 min) | reboot — never within an hour of booting, and at most once every 6 h |

The reboot limits mean a router that's simply switched off (a power cut in the
house) can't send the Pi into a reboot loop. The failure count lives in `/run`,
so it resets on every boot; the time of the last watchdog reboot lives in
`/var/lib/network-watchdog/`, so the 6-hour limit survives the reboot.

### Install (once, on the Pi)

```bash
cd ~/mipi-weather-station && git pull
sudo install -m 755 pi/systemd/network-watchdog.sh /usr/local/sbin/
sudo cp pi/systemd/network-watchdog.service pi/systemd/network-watchdog.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now network-watchdog.timer
```

Check it:

```bash
systemctl list-timers network-watchdog.timer    # next run within 2 min
sudo systemctl start network-watchdog.service   # one check now
journalctl -t network-watchdog                  # silent while the link is fine
```

It logs only when a check fails or the link comes back, so an empty log means
all is well. To see what it *would* do without it touching anything, uncomment
`Environment=WATCHDOG_DRY_RUN=1` in the `.service` file (then
`daemon-reload`). After changing the script, re-run the `install` line.

Remove it: `sudo systemctl disable --now network-watchdog.timer`.

The escalation was tested with stubbed commands (`WATCHDOG_STATE_DIR`,
`WATCHDOG_REBOOT_STAMP` and `WATCHDOG_UPTIME_S` exist for that): a 20-check
outage produces exactly the actions in the table, a successful ping resets the
count, and the reboot guards hold.

## 3. Better signal (hardware, optional)

The watchdog shortens outages; it can't make −85 dBm reliable. If drops stay
frequent, in rough order of cost:

- **A USB Wi-Fi adapter with an external antenna**, pointed at the house (~€15–30).
  The Pi's built-in antenna is tiny and sits inside whatever case it's in.
- **A mesh node or extender** in the room of the house nearest the shed.
- **Powerline adapters** — Ethernet over the mains, if the shed shares the
  house's circuit; often the easiest wired option for an outbuilding.
- **A cable** (Ethernet, or PoE to power the Pi too) if one can be run.

## When the station goes quiet

The heartbeat (healthchecks.io) emails within minutes if the Pi stops pinging —
**provided the check's period/grace are set to minutes, not the 1-day default**
(the 2026-09-27 outage sent no email for exactly that reason). See
[alerting.md](alerting.md). If the watchdog doesn't bring it back within ~30 min,
the Pi reboots itself; if even that fails, it needs a hands-on power cycle.
