"""Dead man's switch heartbeat: ping an external watcher after every archive.

The collector cannot raise the alarm about its own death -- if the Pi loses power
or its uplink, anything running on the Pi dies with it. So the alarm is inverted:
the Pi pings a URL on every archive record, and an external service emails when
the pings *stop*. Silence is the signal, which is exactly what makes it survive
the Pi being the thing that broke.

Provider-agnostic: healthchecks.io, Cronitor, Better Stack and UptimeRobot all
expose the same "GET this URL on a schedule" contract, so the ping URL goes in
`.env` as `HEARTBEAT_URL` and nothing here knows which service answers it. The
period and grace -- how much silence counts as down -- are configured on that
service, not here, so tuning the alert needs no deploy.

Pings run on their own thread. `beat()` only sets an Event, so the sampling loop
is never blocked by network I/O: a stalled HTTP request on the sampling thread is
what published a 70.6 m/s gust on 2026-09-01 (see core/sampler.py).
"""

from __future__ import annotations

import logging
import threading

log = logging.getLogger(__name__)

_TIMEOUT_S = 10


class Heartbeat:
    """Pings `url` whenever `beat()` is called, from a background thread."""

    def __init__(self, url: str, timeout: float = _TIMEOUT_S) -> None:
        self.url = url
        self.timeout = timeout
        self._wake = threading.Event()
        self._started = False

    def start(self) -> None:
        """Begin serving beats. Idempotent; a no-op when no URL is configured."""
        if self._started or not self.url:
            return
        self._started = True
        threading.Thread(target=self._serve_forever, name="heartbeat", daemon=True).start()
        log.info("heartbeat: enabled")

    def beat(self) -> None:
        """Signal that a record was archived. Never blocks, never raises."""
        self._wake.set()

    def _serve_forever(self) -> None:
        while True:
            self._wake.wait()
            self._wake.clear()
            self._ping()

    def _ping(self) -> bool:
        """Send one ping. Returns success; a failure is logged, never raised.

        A missed ping is not worth escalating on its own -- the watcher's grace
        period already decides how much silence matters, and raising here would
        only take down the thread that sends the next one.
        """
        import requests

        try:
            r = requests.get(self.url, timeout=self.timeout)
        except requests.RequestException as e:
            log.warning("heartbeat: ping failed: %s", e)
            return False
        if not r.ok:
            log.warning("heartbeat: ping returned HTTP %d", r.status_code)
            return False
        return True


def build_heartbeat(cfg) -> Heartbeat | None:
    """A Heartbeat if `HEARTBEAT_URL` is set in the environment, else None."""
    url = cfg.env.get("heartbeat_url", "")
    return Heartbeat(url) if url else None
