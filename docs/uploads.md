# Uploads: how a destination goes silent

Each destination keeps **its own cursor** into the collector's SQLite buffer
(`upload_state.last_sent_id`). That is what makes store-and-forward work — a
destination that is unreachable simply resumes where it left off — but it also
means the destinations fail *independently*.

`upload/base.py:flush()` stops at the first record a destination refuses, so
that readings arrive in order:

```python
for row_id, record in buffer.pending(self.name):
    ok = self.send(record)
    if not ok:
        break          # <- everything newer waits behind this one record
    buffer.mark_sent(self.name, row_id)
```

So a single permanently unacceptable record does not cost you one reading, it
costs you **every reading after it**, indefinitely. Meanwhile the other
destinations keep their own cursors moving, Supabase stays current, and the
website looks completely healthy. Nothing about the dashboard tells you one
destination has been dark for days.

## The two-day Windy outage (2026-09-01 → 09-03)

The worked example. The wind vane reports the 16 compass points as
`index * 22.5` (`sensors/wind_vane.py`), so the eight intercardinals are
fractional — and Windy requires an integer `winddir`:

```
windy: HTTP 400, body='{"message":["time must not be more than 2 hours in the
past or in the future...","winddir must be an integer number"],...}'
windy: rejected record 2455, will retry next tick
```

Record 2455 pinned the cursor. It then aged past Windy's 2-hour `time` limit,
so it could never be accepted again *even once the field bug was fixed* — the
block was self-sealing. 53 hours, ~2,900 records, invisible everywhere except
one warning line a minute in journald.

## Finding it

```
weatherstation-doctor --uploads
```

```
uploads

  buffer  : /home/ddools/mipi-weather-station/pi/data/weather.sqlite3
  latest  : record 3000 (63s ago)

  destination     cursor   behind   oldest unsent
  supabase          3000        0               —
  windy               40     2960            2.1d

  windy is stuck 2.1d behind at record 41.
    it refused that record with: HTTP 400: {"message":["winddir must be an integer number"]}
```

`last_error` is stored on rejection and **cleared by the next successful send**,
so it always answers "why is this destination stuck *right now*", never "what
once went wrong". A short backlog is normal — uploads run behind on purpose
(`core/sampler.py` moved them off the sampling thread), and rate-limited
destinations skip whole windows. Only a backlog whose *oldest unsent record*
keeps aging is a stall.

## Writing an uploader that cannot wedge

Every destination needs an escape hatch for a record it will never accept:

| Uploader | Max age | Why |
|---|---|---|
| `cwop` | 10 min | realtime-only network, backfill is meaningless |
| `windy` | 1h55m | tracks Windy's documented 2h `time` limit |
| `wowbe` | 24h | accepts backfill; purely a wedge backstop |
| `wunderground` | — | none yet |
| `supabase` | — | none needed; it is the archive, backfill is the point |

The rule: **if a destination can reject a record permanently, dropping it must
be possible.** Return `True` (marked sent, cursor advances) rather than `False`
(retry forever) for anything past the bound, and log it, so the drop is visible:

```python
if _age_s(record["recorded_at"]) > _MAX_AGE_S:
    log.warning("...: dropping record older than %ds (%s)", _MAX_AGE_S, record["recorded_at"])
    return True
```

Validate fields against what the API actually accepts, too — `winddir` must be
`round()`ed for every WU-protocol destination. That is the bug that started all
of this.
