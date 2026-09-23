"""Heartbeat: the dead man's switch that survives the Pi being what broke."""

from __future__ import annotations

import requests

from weatherstation.config import Config
from weatherstation.core.heartbeat import Heartbeat, build_heartbeat


class FakeResponse:
    def __init__(self, status_code=200):
        self.status_code = status_code

    @property
    def ok(self):
        return 200 <= self.status_code < 400


def _cfg(url):
    return Config({"env": {"heartbeat_url": url}})


def test_disabled_when_no_url_is_configured():
    assert build_heartbeat(_cfg("")) is None


def test_enabled_when_a_url_is_configured():
    hb = build_heartbeat(_cfg("https://hc-ping.com/abc"))
    assert isinstance(hb, Heartbeat)
    assert hb.url == "https://hc-ping.com/abc"


def test_ping_gets_the_configured_url(monkeypatch):
    sent = {}

    def fake_get(url, timeout=None):
        sent.update(url=url, timeout=timeout)
        return FakeResponse(200)

    monkeypatch.setattr(requests, "get", fake_get)
    assert Heartbeat("https://hc-ping.com/abc")._ping() is True
    assert sent["url"] == "https://hc-ping.com/abc"
    assert sent["timeout"] == 10


def test_network_error_is_swallowed_not_raised(monkeypatch):
    """A failed ping must not take down the thread that sends the next one --
    the watcher's grace period already decides how much silence matters."""

    def boom(url, timeout=None):
        raise requests.ConnectionError("no route to host")

    monkeypatch.setattr(requests, "get", boom)
    assert Heartbeat("https://hc-ping.com/abc")._ping() is False


def test_http_error_is_reported_as_failure(monkeypatch):
    monkeypatch.setattr(requests, "get", lambda url, timeout=None: FakeResponse(500))
    assert Heartbeat("https://hc-ping.com/abc")._ping() is False


def test_beat_never_blocks_on_the_network(monkeypatch):
    """beat() runs on the sampling thread. A stalled HTTP request there is what
    published a 70.6 m/s gust on 2026-09-01, so it must only set a flag."""

    def must_not_be_called(*a, **kw):
        raise AssertionError("beat() performed network I/O on the calling thread")

    monkeypatch.setattr(requests, "get", must_not_be_called)
    hb = Heartbeat("https://hc-ping.com/abc")
    hb.beat()  # no thread started, so nothing may be sent
    assert hb._wake.is_set()


def test_start_is_a_noop_without_a_url():
    hb = Heartbeat("")
    hb.start()
    assert hb._started is False
