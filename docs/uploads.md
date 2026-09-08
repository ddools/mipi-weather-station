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
| `wow` | 1h | opaque 400s; the 5-min throttle means backfill is thin anyway |
| `wowbe` | 24h | accepts backfill; purely a wedge backstop |
| `wunderground` | 24h | accepts backfill; purely a wedge backstop |
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

## Rain is an accumulation, and never the record's own field

A silent wrongness of a different shape: the upload never fails, the cursor
never sticks, the doctor stays green — the numbers are just quietly too small.

Every destination asks for rain as a **total over a window**:

| Field | Destination | Window |
|---|---|---|
| `rainin` | WU, Windy (`precip`), WOW, WOW-BE | last 60 minutes |
| `dailyrainin` | WU, WOW, WOW-BE | since local midnight |
| `r` / `p` / `P` | CWOP | last hour / last 24 h / since local midnight |

But an archive record's `rain_mm` is only the rain that fell during its own
60-second interval. Sending it as `rainin` reports roughly **a sixtieth** of the
real hourly total: a bucket tip shows up as 0.011 in for the one minute it
happened and 0.000 for the other fifty-nine. The Weather Underground and Windy
uploaders did exactly that until 2026-09-08, and WU was never sent `dailyrainin`
at all, so it had no daily accumulation to plot.

The totals come from `upload/_rain.py`, which sums `rain_mm` straight out of the
SQLite buffer — the source of truth, so the figures survive an uploader restart
with no in-memory accumulator to lose:

```python
rain_1h_mm, rain_today_mm = rain_hour_and_day(self._sqlite_path, self._tz, dt)
```

Two rules that are easy to get wrong:

- **Anchor the window on the record, not on `now`.** `dt`, not
  `datetime.now()`. For a live reading they are the same, but a backlog
  replayed after an outage would otherwise stamp *this* hour's rain onto an
  hours-old observation — which matters for the destinations that accept
  backfill (`wunderground`, `wowbe`).
- **Bound the window at both ends.** `sum_rain_since` takes `until_iso` as a
  required keyword for that reason: anchored at an old record, an open-ended
  `recorded_at >= ?` would sweep in every drop that fell *after* it.

Always send the rain fields, including zeros. A dry hour is a real 0.0, and it
is what tells the destination the gauge is alive rather than absent.
