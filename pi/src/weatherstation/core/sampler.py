"""Sampling loop: high-frequency wind samples aggregated into archive records."""

from __future__ import annotations

import logging
import statistics
import threading
import time

from ..config import Config
from ..store import LocalBuffer
from . import units
from .records import Record

log = logging.getLogger(__name__)

# Highest wind speed worth publishing, m/s. Ireland's record gust is about
# 51 m/s (Foynes, 1945); anything past this from a suburban rooftop is a fault,
# not weather. Offending samples are dropped rather than clamped, so a bad one
# pollutes neither the interval mean nor the gust.
MAX_PLAUSIBLE_WIND_MS = 55.0

# Shortest sample window worth trusting, seconds. Sampling runs to absolute
# deadlines, so a slow sensor read can push the next deadline into the past; the
# sample it would produce covers almost no time and means nothing.
MIN_SAMPLE_S = 0.5


class Sampler:
    def __init__(
        self,
        cfg: Config,
        air,
        anemometer,
        rain,
        vane,
        buffer: LocalBuffer,
        uploaders,
        air_quality=None,
        heartbeat=None,
    ):
        self.cfg = cfg
        self.air, self.anemometer, self.rain, self.vane = air, anemometer, rain, vane
        self.air_quality = air_quality
        self.buffer = buffer
        self.uploaders = uploaders
        self.heartbeat = heartbeat
        self._flush_wake = threading.Event()

    def run_forever(self) -> None:
        cal = self.cfg.calibration
        wind_dt = self.cfg.sampling.wind_sample_s
        archive_dt = self.cfg.sampling.archive_interval_s
        samples_per_archive = max(1, archive_dt // wind_dt)

        # Sleeps are to an absolute deadline, not `sleep(wind_dt)`: reading the
        # sensors is not free (the MCP342X vane conversion alone is ~270 ms, and
        # the DS18B20 ~750 ms once per cycle), so sleeping a fixed wind_dt *adds*
        # that cost to every interval instead of absorbing it. On the real Pi that
        # ran the archive at 64.96 s against a configured 60 s -- 8.3% slow, ~110
        # records a day quietly missing. Deadlines make the work come out of the
        # interval, so the cadence holds as long as a cycle's I/O fits inside it.
        sample_dt = archive_dt / samples_per_archive
        log.info("sampling: wind every %ss, archive every %ss", sample_dt, archive_dt)
        self._start_uploader_thread()
        if self.heartbeat is not None:
            self.heartbeat.start()
        # Pulses accrue continuously in the sensor's interrupt handler, so a sample
        # covers the real time since the previous read -- never the nominal sample_dt.
        # Deliberately carried across archive cycles: the first sample of a cycle
        # also covers whatever the previous one spent building and storing its
        # record, and dividing that by sample_dt is what produced 250 km/h gusts.
        cycle_start = time.monotonic()
        last_read = cycle_start
        while True:
            wind_samples: list[float] = []
            dirs: list[float] = []
            rain_tips = 0
            for i in range(samples_per_archive):
                self._sleep_until(cycle_start + (i + 1) * sample_dt)
                if time.monotonic() - last_read < MIN_SAMPLE_S:
                    # This deadline blew past while the previous sample's I/O ran,
                    # so its window is ~0s. Skipping leaves the pulse counter
                    # unreset, so those pulses simply land in the next sample over
                    # its true elapsed time -- nothing is lost. Reading anyway
                    # would divide them by ~0, and `Anemometer.speed_ms` reports a
                    # non-positive window as 0.0 m/s, quietly dragging the
                    # interval mean toward zero.
                    continue
                pulses = self.anemometer.read_and_reset()
                now = time.monotonic()
                elapsed, last_read = now - last_read, now
                speed = self.anemometer.speed_ms(
                    pulses, elapsed, cal.anemometer_radius_cm, cal.anemometer_adjustment
                )
                if speed > MAX_PLAUSIBLE_WIND_MS:
                    log.warning(
                        "dropping implausible wind sample: %.1f m/s (%d pulses over %.1fs)",
                        speed,
                        pulses,
                        elapsed,
                    )
                else:
                    wind_samples.append(speed)
                d = self.vane.read_deg()
                if d is not None:
                    dirs.append(d)
                rain_tips += self.rain.read_and_reset()

            record = self._make_record(wind_samples, dirs, rain_tips)
            self.buffer.append(record)
            log.info("archived: %s", record.as_dict())
            self._flush_wake.set()
            # Beat on a stored record, not a successful upload: the buffer is the
            # source of truth, so this says "the station is still collecting".
            # A destination being unreachable is store-and-forward's problem and
            # must not raise an alarm that the station is down.
            if self.heartbeat is not None:
                self.heartbeat.beat()

            # Advance the anchor by exactly one interval rather than restarting
            # from now: that is what stops the per-cycle I/O cost accumulating
            # into drift. A small overshoot (the last sample's read finishing
            # after the boundary) is absorbed by the next cycle's first sleep.
            cycle_start += archive_dt
            behind = time.monotonic() - cycle_start
            if behind >= archive_dt:
                # A whole interval's worth of deadlines is already in the past --
                # sensor I/O is outrunning the configured cadence. Resync so the
                # debt cannot grow without bound; the loop still cannot spin,
                # because an expired deadline skips its sample rather than taking
                # a zero-length one.
                log.warning(
                    "sampling is %.1fs behind the %ss archive interval; resyncing",
                    behind,
                    archive_dt,
                )
                cycle_start = time.monotonic()

    @staticmethod
    def _sleep_until(deadline: float) -> None:
        """Sleep until `deadline` (a `time.monotonic()` value). No-op if already past."""
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(remaining)

    def _start_uploader_thread(self) -> None:
        """Run uploads off the sampling thread.

        Flushing used to happen inline at the end of each archive cycle, so a slow
        or timing-out POST stalled sampling -- and because pulses keep accruing
        while it is stalled, the next sample read as an enormous gust. Uploads are
        store-and-forward and already retry from the buffer, so nothing is lost by
        letting them run behind.
        """
        if not self.uploaders:
            return
        threading.Thread(target=self._flush_forever, name="uploader", daemon=True).start()

    def _flush_forever(self) -> None:
        while True:
            self._flush_wake.wait()
            self._flush_wake.clear()
            for up in self.uploaders:
                try:
                    up.flush(self.buffer)
                except Exception:
                    log.exception("%s: flush failed", up.name)

    def _make_record(self, wind_samples, dirs, rain_tips) -> Record:
        cal = self.cfg.calibration
        st = self.cfg.station
        rec = Record()
        try:
            t, h, p = self.air.read()
            rec.temp_c, rec.humidity, rec.pressure_hpa = round(t, 2), round(h, 1), round(p, 2)
            rec.dewpoint_c = round(units.dewpoint_c(t, h), 2)
            rec.pressure_msl_hpa = round(units.sea_level_pressure_hpa(p, st.elevation_m, t), 2)
        except Exception:
            log.exception("air sensor read failed")
        if self.air_quality is not None:
            try:
                aq = self.air_quality.read_index()
                if aq is not None:
                    rec.air_quality = round(aq, 1)
            except Exception:
                log.exception("air quality sensor read failed")
        if wind_samples:
            rec.wind_speed_ms = round(statistics.mean(wind_samples), 2)
            rec.wind_gust_ms = round(max(wind_samples), 2)
        if dirs:
            # simple mode of sampled directions (vane snaps to 16 values anyway)
            rec.wind_dir_deg = statistics.mode(dirs)
        rec.rain_mm = round(rain_tips * cal.rain_bucket_mm, 3)
        return rec
