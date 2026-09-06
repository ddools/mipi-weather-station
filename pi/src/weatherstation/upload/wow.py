"""WOW upload -- UK Met Office Weather Observations Website, shown on WOW-IE.

wow.met.ie (WOW-IE) is Met Eireann's Irish front-end onto the UK Met Office WOW
network: registration, site management and *uploads* all happen on
wow.metoffice.gov.uk, and Irish sites are then drawn on the WOW-IE map. There is
no wow.met.ie upload endpoint -- `https://wow.met.ie/automaticreading` just
serves the site's HTML shell.

    GET https://wow.metoffice.gov.uk/automaticreading
        ?siteid=...&siteAuthenticationKey=...&dateutc=...&<weather>

Auth is a Site ID (a GUID on newer sites, a plain number on older ones -- passed
through verbatim) plus a 6-digit Authentication Key (PIN) chosen at registration,
both as query parameters. Fields and units are the Weather
Underground protocol (degF, inHg, mph, inches) -- the same set as `wowbe.py`,
minus `absbaromin`, which is not in WOW's parameter list.

WOW wants **at least 5 minutes between readings** and answers 429 when pushed
harder, so -- like Windy -- this uploader skips (reports success without a
request) between windows rather than collecting 429s. That means WOW gets one
record in five rather than a backfilled history, which suits a live observations
map; the local SQLite buffer remains the complete record.

WOW answers a bare `400 Bad Request` for anything it won't accept -- unknown
site, wrong PIN, bad field, and quite possibly an over-age reading -- with no
detail in the body, so a rejection here means "check the Site ID and PIN on the
site page first".

That opacity is why records older than `_MAX_AGE_S` are dropped rather than
retried. `upload/base.py:flush()` stops at the first failure to preserve
ordering, so a record WOW will never accept blocks every fresher one behind it
forever -- the head-of-line block that took the station offline on Windy
(#18). WOW does not document an age limit and its 400 would not tell us we had
hit one, so the cap is a guarantee of progress rather than a mirror of a known
server rule.

Caveat: the Met Office began retiring WOW in January 2026 and plans full
decommissioning in late 2026, after which WOW-IE stops displaying uploads. See
docs/wow-ie.md; `wowbe.py` (wow.meteo.be) is the successor network.
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timedelta, timezone

import requests

from ..core import units
from ._rain import local_midnight_utc, sum_rain_since
from .base import Uploader

log = logging.getLogger(__name__)

_URL = "https://wow.metoffice.gov.uk/automaticreading"
_MIN_INTERVAL_S = 300  # WOW asks for >= 5 min between readings; 429 past that
# Bound on how stale a reading may be when we send it. Generous enough that a
# short outage still backfills its most recent hour, tight enough that a record
# WOW refuses cannot wedge the cursor for longer than that. With the 5-minute
# throttle WOW only ever gets one record in five anyway, so dropping the rest of
# a backlog costs nothing the SQLite buffer and Supabase do not already hold.
_MAX_AGE_S = 3600


class WowUploader(Uploader):
    name = "wow"

    def __init__(self, cfg) -> None:
        c = cfg.uploaders.wow
        self._site_id = str(c.station_id)
        self._auth_key = str(cfg.env.wow_auth_key)
        self._url = c.get("url", _URL)
        self._interval_s = float(c.get("send_interval_s", _MIN_INTERVAL_S))
        self._tz = cfg.station.get("timezone", "UTC")
        self._sqlite_path = str(cfg.storage.sqlite_path)
        # -inf, not 0.0: time.monotonic() counts from boot, so 0.0 would make
        # every record in the first 5 minutes after a reboot look like it fell
        # inside the rate-limit window and get skipped.
        self._last_sent_at = float("-inf")
        self._dropping = False  # mid-run of stale records; keeps the log readable

    def send(self, record: dict) -> bool:
        now = time.monotonic()
        if now - self._last_sent_at < self._interval_s:
            return True  # inside WOW's 5-minute window — skip, not a failure

        dt = datetime.fromisoformat(record["recorded_at"].replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        dt = dt.astimezone(timezone.utc)
        now_utc = datetime.now(timezone.utc)

        if (now_utc - dt).total_seconds() > _MAX_AGE_S:
            # Too stale to be worth a slot on a live observations map, and a
            # candidate for the 400 that would block everything behind it. Drop
            # it and let the cursor advance. Only the first of a run is a
            # warning: replaying a long outage would otherwise bury the
            # `wow: HTTP ...` lines that do need attention.
            log.log(
                logging.DEBUG if self._dropping else logging.WARNING,
                "wow: dropping record older than %ds (%s)",
                _MAX_AGE_S,
                record["recorded_at"],
            )
            self._dropping = True
            return True
        self._dropping = False

        rain_1h_mm, rain_today_mm = sum_rain_since(
            self._sqlite_path,
            (now_utc - timedelta(hours=1)).isoformat(),
            local_midnight_utc(self._tz, now_utc).isoformat(),
        )

        params = {
            "siteid": self._site_id,
            "siteAuthenticationKey": self._auth_key,
            "dateutc": dt.strftime("%Y-%m-%d %H:%M:%S"),
            "softwaretype": "mipi-weatherstation",
        }
        if record.get("temp_c") is not None:
            params["tempf"] = round(units.c_to_f(record["temp_c"]), 1)
        if record.get("humidity") is not None:
            params["humidity"] = round(record["humidity"])
        if record.get("dewpoint_c") is not None:
            params["dewptf"] = round(units.c_to_f(record["dewpoint_c"]), 1)
        if record.get("pressure_msl_hpa") is not None:
            params["baromin"] = round(units.hpa_to_inhg(record["pressure_msl_hpa"]), 3)
        if record.get("wind_speed_ms") is not None:
            params["windspeedmph"] = round(units.ms_to_mph(record["wind_speed_ms"]), 1)
        if record.get("wind_gust_ms") is not None:
            params["windgustmph"] = round(units.ms_to_mph(record["wind_gust_ms"]), 1)
        if record.get("wind_dir_deg") is not None:
            params["winddir"] = round(record["wind_dir_deg"])
        params["rainin"] = round(units.mm_to_in(rain_1h_mm), 3)
        params["dailyrainin"] = round(units.mm_to_in(rain_today_mm), 3)

        try:
            r = requests.get(self._url, params=params, timeout=15)
        except requests.RequestException as e:
            log.warning("wow: request failed: %s", e)
            return False

        # 429 = sent too soon / duplicate reading. WOW already holds an observation
        # for this window, so it counts as delivered — but back off before the next.
        if r.status_code in (200, 429):
            self._last_sent_at = now
            return True
        log.warning("wow: HTTP %d, body=%r", r.status_code, r.text[:300])
        return False
