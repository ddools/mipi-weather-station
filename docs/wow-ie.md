# WOW / WOW-IE upload (wow.met.ie)

**WOW-IE** (<https://wow.met.ie>) is Met Éireann's Irish view of the UK Met
Office's **Weather Observations Website** network. It is a *display* front-end:
Met Éireann publishes the map, but registration, site management and uploads all
happen on the Met Office side.

> "Registration and account management is handled by the UK Met Office WOW,
> Met Éireann is not the data processor or controller." — [wow.met.ie/sign-up-login](https://wow.met.ie/sign-up-login)

Uploader: [`pi/src/weatherstation/upload/wow.py`](../pi/src/weatherstation/upload/wow.py).

## ⚠️ Read this first: WOW is being switched off

From [wow.met.ie/about-wow](https://wow.met.ie/about-wow):

> "After over a decade of supporting crowd-sourced weather observations and
> citizen science, the UK Met Office will start retiring WOW in January, with
> full decommissioning planned for late 2026."
>
> Observations "will no longer be uploaded and displayed on WOW-IE, or on any
> WOW partner website."

So this uploader has a known end date — roughly the end of 2026. It is worth
running because it puts the station on the Irish map *now*, and because it costs
nothing to leave enabled until the endpoint stops answering. The successor is
**WOW-BE** (<https://wow.meteo.be>, RMI Belgium's reboot of the same idea) —
already implemented in [`upload/wowbe.py`](../pi/src/weatherstation/upload/wowbe.py),
see [docs/wowbe.md](wowbe.md). Run both; when WOW dies, set `enabled: false`
and nothing else changes.

## How it works

The old WOW protocol is a query-string `GET`, not the JSON POST that WOW-BE uses:

```
GET https://wow.metoffice.gov.uk/automaticreading
    ?siteid=<site id>
    &siteAuthenticationKey=<6-digit PIN>
    &dateutc=2026-09-06%2012%3A00%3A00
    &softwaretype=mipi-weatherstation
    &tempf=68.0&humidity=72&dewptf=58.8&baromin=29.92
    &windspeedmph=11.2&windgustmph=17.9&winddir=180
    &rainin=0.0&dailyrainin=0.0
```

- **There is no `wow.met.ie` upload endpoint.** `https://wow.met.ie/automaticreading`
  returns the site's HTML shell (HTTP 200) — point a station at it and you will
  silently upload nothing. The host is `wow.metoffice.gov.uk`.
- **Fields and units are the Weather Underground protocol** — °F, inHg, mph,
  inches — the same set as WOW-BE **minus `absbaromin`**, which is a WU field WOW
  does not document. `baromin` is sea-level pressure.
- **`dateutc`** is `YYYY-MM-DD HH:MM:SS` in UTC.
- **`rainin`** = rain in the last 60 minutes, **`dailyrainin`** = rain since local
  midnight (`station.timezone`). Both are summed from the local SQLite buffer via
  a read-only connection ([`upload/_rain.py`](../pi/src/weatherstation/upload/_rain.py)),
  shared with the CWOP and WOW-BE uploaders, so they survive a collector restart.
- **Site ID** is a GUID on newer sites and a plain number on older ones. The
  uploader passes whatever you configure through verbatim — copy it exactly as
  the site page shows it.
- **Authentication Key** is the 6-digit PIN you choose when creating the site.
  Older WOW documentation and Cumulus call it "PIN"; the dashboard now says
  "Authentication Key". Same thing.

### Rate limiting

WOW wants **at least 5 minutes between readings** and answers `429` if pushed
harder. Our archive interval is 60 s, so — exactly like the Windy uploader —
`send()` self-throttles: inside the 5-minute window it returns success *without
making a request*, so the record is marked delivered and the backlog keeps
draining.

The consequence is deliberate: **WOW gets one record in five, live, and no
backfill.** That suits a live observations map, and the local SQLite buffer plus
Supabase remain the complete history. `uploaders.wow.send_interval_s` tunes the
window if WOW's limit ever changes.

### Response handling

| Status | Meaning | `send()` |
| --- | --- | --- |
| `200` | accepted | `True` |
| `429` | sent too soon / duplicate reading — WOW already holds this window | `True`, and the throttle window restarts |
| `400` | **everything else**: unknown site, wrong PIN, bad field or unit | `False`, logged, retried next tick |

WOW returns a bare `400 Bad Request` with an empty body for anything it won't
accept — it does not distinguish "no such site" from "wrong PIN" from "bad
parameter", and it gives no validation detail (verified by probing the live
endpoint on 2026-09-06). If you see `wow: HTTP 400`, check the Site ID and PIN on
the site page before suspecting the payload.

## Setup

1. **Register at <https://wow.metoffice.gov.uk>** — *not* on wow.met.ie. Create an
   account (or sign in with Google/Facebook/X), then **Create a Site**: name,
   location, elevation. Put the marker on the real location — WOW-IE plots you
   there. You choose a **6-digit Authentication Key (PIN)**; the site page gives
   you the **Site ID**.
2. **`pi/.env`**: `WOW_AUTH_KEY=<your 6-digit PIN>`
3. **`pi/config.yaml`**:
   ```yaml
   station:
     timezone: "Europe/Dublin"   # used for "rain since local midnight"
   uploaders:
     wow:
       enabled: true
       station_id: "<your Site ID>"   # verbatim, GUID or number
       send_interval_s: 300
   ```
4. Restart the collector: `sudo systemctl restart weatherstation`.
5. Watch it: `journalctl -u weatherstation -f | grep -i wow`. Silence is the good
   case — a rejection logs as `wow: HTTP 400, body=...`.
6. **Verify on the site itself**, not from the logs: your site page on
   wow.metoffice.gov.uk, then the WOW-IE map at <https://wow.met.ie>. Met Éireann
   says observations take **about two hours** to appear on the WOW-IE map, so give
   it that long before concluding anything is wrong.

## Gotchas

- **Uploading to `wow.met.ie` does nothing.** It answers 200 with a web page. Only
  `wow.metoffice.gov.uk/automaticreading` accepts observations.
- **`upload/base.py:flush()` only logs on an exception**, not on a `False` return
  — a WOW rejection surfaces only as this uploader's own `wow: HTTP ...` warning.
  Grep `journalctl` for `wow:` and confirm against the site page; don't read
  silence as success.
- **A `400` is almost always credentials**, because that is the only signal WOW
  gives for them. Re-copy the Site ID and re-enter the PIN on the site page.
- **Don't confuse `wow` with `wowbe`.** They are separate networks, separate
  registrations, separate `.env` keys (`WOW_AUTH_KEY` vs `WOWBE_AUTH_KEY`) and
  separate `upload_state` cursors. Enabling both is fine and is the intended
  setup during the WOW wind-down.
- The Met Office API portal (`mowowprod.portal.azure-api.net`) that documented
  these parameters now returns **503** — the upload endpoint still works, but the
  reference docs are already going away. [pywws's Met Office
  module](https://pywws.readthedocs.io/en/21.4.0/_modules/pywws/service/metoffice.html)
  is a useful surviving reference for the field list.
