# WOW-BE upload

**WOW-BE** (<https://wow.meteo.be>) is the Royal Meteorological Institute of
Belgium's crowdsourced-observations site — the reboot of the WMO "Weather
Observations Website" concept after the UK Met Office and Met Éireann shut their
WOW instances down in late 2026. It takes stations from anywhere, not just
Belgium.

Uploader: [`pi/src/weatherstation/upload/wowbe.py`](../pi/src/weatherstation/upload/wowbe.py).

## How it works

Unlike the old WOW (a query-string `GET automaticreading?...`), WOW-BE v2 is a
JSON REST API:

```
POST https://wow.meteo.be/api/v2/send/wow
Content-Type: application/json

{
  "siteid": "<your site id>",
  "siteAuthenticationKey": "<your PIN>",
  "dateutc": "2026-08-30 22:00:00",
  "softwaretype": "mipi-weatherstation",
  "tempf": 68.0, "humidity": 72, "dewptf": 58.8,
  "baromin": 29.92, "absbaromin": 29.86,
  "windspeedmph": 11.2, "windgustmph": 17.9, "winddir": 180,
  "rainin": 0.0, "dailyrainin": 0.0
}
```

- **Field names and units are the Weather Underground protocol** — °F, inHg, mph,
  inches. `baromin` is sea-level pressure, `absbaromin` is station pressure.
- **`dateutc`** is `YYYY-MM-DD HH:MM:SS` in UTC (the API also tolerates ISO 8601;
  the space form is what every WOW-protocol uploader sends and is verified working).
- **`rainin`** = rain in the last 60 minutes, **`dailyrainin`** = rain since local
  midnight (`station.timezone`). Both are summed from the local SQLite buffer via
  a read-only connection ([`upload/_rain.py`](../pi/src/weatherstation/upload/_rain.py)),
  so they stay correct across a collector restart.
- **Rate limit: 20 requests/min per site** (HTTP 429). Our 60 s archive interval
  is nowhere near it, so there's no client-side throttle (unlike Windy/CWOP).
- Responses: `200` accepted, `403` bad credentials, `422` validation error,
  `429` rate limited. Anything but 200 returns `False` from `send()`, so the
  base `flush()` loop pauses the backlog and retries on the next tick.

The 200 response body is a GeoJSON `Feature` echoing back the stored observation —
handy for eyeballing what the backend actually parsed.

API reference (Stoplight): <https://wow.meteo.be/docs/api/>

## Setup

1. **Register** at <https://wow.meteo.be> — create an account, add a site (name,
   location, elevation). You choose a **6-digit Authentication Key (PIN)** for the
   site and get a **Site ID**.
2. **`pi/.env`**: `WOWBE_AUTH_KEY=<your PIN>`
3. **`pi/config.yaml`**:
   ```yaml
   station:
     timezone: "Europe/Dublin"
   uploaders:
     wowbe:
       enabled: true
       station_id: "<your Site ID>"   # exactly as shown on the site page
   ```
   The API accepts either the short Site ID or the full site UUID — use whichever
   the site page gives you, verbatim.
4. Restart the collector. Watch `journalctl -u weatherstation -f`; a rejection
   logs as `wowbe: HTTP 4xx, body=...` with the validation detail.
5. Check your site page on wow.meteo.be — observations should appear within a few
   minutes.

## Gotchas

- **`upload/base.py:flush()` only logs on an exception**, not on a `False` return.
  A WOW-BE rejection surfaces as the `wowbe: HTTP ...` warning from the uploader
  itself — grep `journalctl` for `wowbe:` and confirm against the site page, don't
  trust silence.
- `422` bodies are specific (`{"errors": {"tempf": ["..."]}}`) — read them; the
  fix is almost always a unit or a field-name issue, not credentials.
- WOW-BE also exposes Ecowitt and Weather Underground protocol endpoints
  (`/send/ecowitt`, `/send/weatherunderground`) hitting the same backend. We use
  `/send/wow` because its field set matches what we already compute for the WU
  uploader.
- No air-quality field — the TGS2600 index is not sent (same as WU/Windy/CWOP).
