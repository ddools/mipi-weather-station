# CWOP upload

The **Citizen Weather Observer Program** feeds NOAA MADIS, which National Weather
Service models and many public sites (aprs.fi, findu, Weather Underground's PWS
network) draw from. It is free and has real scientific value — worth doing even
though almost nobody looks at CWOP directly.

Uploader: [`pi/src/weatherstation/upload/cwop.py`](../pi/src/weatherstation/upload/cwop.py).

## How it works

CWOP has **no HTTP API**. Observations are APRS weather packets pushed over a
plain TCP socket to an APRS-IS server. Each upload is:

1. `socket.create_connection(("cwop.aprs.net", 14580))`
2. send a login line: `user <ID> pass <passcode> vers mipi-weatherstation <version>\r\n`
3. send one APRS "complete weather report" packet, `\r\n`-terminated
4. close

APRS-IS never acknowledges the observation itself, so "success" means the socket
round-trip completed and the login response did not contain `invalid`. Confirm
data is actually landing at <https://aprs.fi/#!call=a%2F<ID>> or
`http://www.findu.com/cgi-bin/wx.cgi?call=<ID>` after the first send.

### The packet

```
CW0000>APRS,TCPIP*:@300923z5321.00N/00615.60W_180/011g018t068r000p000P000h72b10132mipiWX
```

| field | meaning | notes |
| --- | --- | --- |
| `@300923z` | day/hour/minute UTC | from the record's `recorded_at` |
| `5321.00N/00615.60W` | position | `DDMM.mm` / `DDDMM.mm`; `/` is the symbol table, `_` the weather-station symbol |
| `180/011` | wind bearing° / sustained mph | `.../...` when unknown |
| `g018` | gust, mph | |
| `t068` | temperature, °F | sub-zero as `t-04` (3 chars) |
| `r000` / `p000` / `P000` | rain, hundredths of an inch | last hour / last 24 h / since local midnight |
| `h72` | humidity % | `h00` means 100% |
| `b10132` | sea-level pressure, tenths of hPa | `b10132` = 1013.2 hPa |
| `mipiWX` | software tag | so the station is identifiable while debugging |

Rain totals are summed directly from the local SQLite buffer (`readings` table,
`json_extract(payload, '$.rain_mm')`) over each window, using a throwaway
read-only connection. This means the figures are correct even straight after an
uploader restart — no in-memory accumulators to lose. "Since local midnight" uses
`station.timezone` (falls back to UTC midnight if the zone name is unknown).

### Cadence and backlog

CWOP wants **one report per ~5 minutes, no more**. The uploader self-throttles to
`send_interval_s` (default 300 s) exactly like the Windy uploader — inside the
window `send()` returns `True` without transmitting.

CWOP is a **realtime** network: a backlog replayed after an outage is stale
weather MADIS would reject. Records older than 10 minutes (`_MAX_AGE_S`) are
dropped (marked sent, not transmitted), so after an outage the uploader silently
catches up and only ever sends fresh observations.

## Setup

1. **Register** for a station id at <http://www.wxqa.com/SIGN-UP.html>. CWOP
   processes new accounts **weekly on Wednesday** and emails the `CW####` /
   `DW####` / `EW####` id then. There is a **90-day deadline** to finish (send
   data + verify the map location) or the site is removed. If you hold an amateur
   radio licence, skip the form — email cwop-support@noaa.gov with your callsign,
   town, zip and elevation-in-metres and use the callsign as the id instead.
   (Ours: registration submitted 2026-08-30, id pending.)
2. **`pi/.env`** — leave `CWOP_PASSCODE=-1` for a CW/DW/EW id. Only set a real
   [APRS-IS passcode](http://www.aprs-is.net/SendOnlyPorts.aspx) if `station_id`
   is a ham callsign.
3. **`pi/config.yaml`**:
   ```yaml
   station:
     timezone: "Europe/Dublin"
   uploaders:
     cwop:
       enabled: true
       station_id: "CW0000"   # your id
   ```
4. Restart the collector. Watch `journalctl -u weatherstation -f` for
   `cwop: sent CW0000>APRS,...` lines (one per ~5 min).
5. Check <https://aprs.fi> a few minutes later.

## Gotchas

- **`upload/base.py:flush()` only logs on an exception**, not on a `False` return.
  A silent CWOP failure (socket refused, login rejected) shows up as a
  `cwop: ...` warning from the uploader itself — grep `journalctl` for `cwop:`,
  and verify against aprs.fi rather than trusting the absence of errors.
- A brand-new CWOP id can take a while to propagate to MADIS quality control even
  after aprs.fi shows the packets — that is normal, not a formatting bug.
- APRS is strict ASCII and the weather fields must appear in the order above.
  `format_packet()` is a pure function with unit tests
  ([`tests/test_cwop.py`](../pi/tests/test_cwop.py)) — change it there.
- CWOP does **not** take an air-quality or any non-standard field; the TGS2600
  index is not sent (same as WU/Windy).
