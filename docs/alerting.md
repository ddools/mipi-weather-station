# Alerting: knowing the station went down

Two independent alarms, because they fail in different ways.

| | Heartbeat (`HEARTBEAT_URL`) | Station watchdog (GitHub Actions) |
|---|---|---|
| Runs on | an external watcher | GitHub's runners |
| Watches | pings from the Pi | the newest row in Supabase |
| Detects in | ~2 min | ~15–45 min |
| Tells you by | email | a GitHub issue (`station-down`) |
| Catches | Pi dead, uplink dead, sampling stopped | the same, plus a Pi that samples but cannot reach Supabase |

The heartbeat is the fast one. The watchdog is the backstop that still works if
the heartbeat service itself is what broke, and it is the one that notices data
reaching SQLite but never reaching the cloud.

## Why the alarm is inverted

The collector cannot report its own death. If the Pi loses power or its uplink,
anything running on the Pi dies with it — a Pi-side "send me an email when
something is wrong" job is exactly the thing that cannot fire when it matters.

So the Pi asserts life instead: it pings a URL on every archive record, and an
external service emails when the pings *stop*. Silence is the signal. That is a
dead man's switch, and it is the only shape of alarm that survives the monitored
thing being what failed.

## Setup

1. Make an account at [healthchecks.io](https://healthchecks.io) (free tier is
   ample — this needs one check). Cronitor, Better Stack and UptimeRobot expose
   the same "GET this URL on a schedule" contract and work identically.
2. Create a check:
   - **Period** `1 minute` — how often we promise to ping (the archive interval).
   - **Grace** `1 minute` — extra silence tolerated before it alarms.
   - Period + grace is the real threshold, so this alerts at **~2 minutes**.
3. Copy its ping URL into `pi/.env` on the Pi:
   ```
   HEARTBEAT_URL=https://hc-ping.com/<your-uuid>
   ```
4. `sudo systemctl restart weatherstation`, then check the log says
   `heartbeat: enabled` and the check goes green within a minute.

Nothing in the collector knows the threshold — period and grace live on the
service, so retuning the alert needs no deploy.

## Tuning: 2 minutes will page you for a reboot

The archive interval is 60 s, so a 2-minute threshold means **one missed cycle
alerts**. A `systemctl restart` takes the station out for ~60–90 s, and a reboot
longer — both will email you. Deploying anything will page you.

If that gets annoying, raise **grace** to 3–5 minutes. Detection gets slower;
what you lose is only the difference between "down for 2 minutes" and "down for
5", and the station has never had an outage that short that mattered. Nothing
is lost by finding out at 5 minutes — store-and-forward means a brief outage
costs no data at all (see [uploads.md](uploads.md)).

## What a beat actually means

`core/heartbeat.py` beats on a **stored record**, not a successful upload:

```python
self.buffer.append(record)
...
self.heartbeat.beat()
```

The SQLite buffer is the source of truth, so a beat asserts "the station is
still collecting". A destination being unreachable is store-and-forward's
problem and must not raise an alarm that the station is down — that is the
watchdog's job, at its slower cadence, because it is the one failure where data
really is not arriving anywhere.

`beat()` only sets an `Event`; the HTTP request happens on a dedicated thread.
Network I/O on the sampling thread is what published a 70.6 m/s gust on
2026-09-01 (see `core/sampler.py`), and it must never happen again.

A failed ping is logged and swallowed. Escalating would only kill the thread
that sends the next one, and the watcher's grace period already decides how
much silence counts.
