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
    ):
        self.cfg = cfg
        self.air, self.anemometer, self.rain, self.vane = air, anemometer, rain, vane
        self.air_quality = air_quality
        self.buffer = buffer
        self.uploaders = uploaders
        self._flush_wake = threading.Event()

    def run_forever(self) -> None:
        cal = self.cfg.calibration
        wind_dt = self.cfg.sampling.wind_sample_s
        archive_dt = self.cfg.sampling.archive_interval_s
        samples_per_archive = max(1, archive_dt // wind_dt)

        log.info("sampling: wind every %ss, archive every %ss", wind_dt, archive_dt)
        self._start_uploader_thread()
        # Pulses accrue continuously in the sensor's interrupt handler, so a sample
        # covers the real time since the previous read -- never the nominal wind_dt.
        # Deliberately carried across archive cycles: the first sample of a cycle
        # also covers whatever the previous one spent building and storing its
        # record, and dividing that by wind_dt is what produced 250 km/h gusts.
        last_read = time.monotonic()
        while True:
            wind_samples: list[float] = []
            dirs: list[float] = []
            rain_tips = 0
            for _ in range(samples_per_archive):
                time.sleep(wind_dt)
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
