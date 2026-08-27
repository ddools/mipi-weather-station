"""Sampling loop: high-frequency wind samples aggregated into archive records."""

from __future__ import annotations

import logging
import statistics
import time

from ..config import Config
from ..store import LocalBuffer
from . import units
from .records import Record

log = logging.getLogger(__name__)


class Sampler:
    def __init__(self, cfg: Config, air, anemometer, rain, vane, buffer: LocalBuffer, uploaders):
        self.cfg = cfg
        self.air, self.anemometer, self.rain, self.vane = air, anemometer, rain, vane
        self.buffer = buffer
        self.uploaders = uploaders

    def run_forever(self) -> None:
        cal = self.cfg.calibration
        wind_dt = self.cfg.sampling.wind_sample_s
        archive_dt = self.cfg.sampling.archive_interval_s
        samples_per_archive = max(1, archive_dt // wind_dt)

        log.info("sampling: wind every %ss, archive every %ss", wind_dt, archive_dt)
        while True:
            wind_samples: list[float] = []
            dirs: list[float] = []
            rain_tips = 0
            for _ in range(samples_per_archive):
                time.sleep(wind_dt)
                pulses = self.anemometer.read_and_reset()
                wind_samples.append(
                    self.anemometer.speed_ms(
                        pulses, wind_dt, cal.anemometer_radius_cm, cal.anemometer_adjustment
                    )
                )
                d = self.vane.read_deg()
                if d is not None:
                    dirs.append(d)
                rain_tips += self.rain.read_and_reset()

            record = self._make_record(wind_samples, dirs, rain_tips)
            self.buffer.append(record)
            log.info("archived: %s", record.as_dict())
            for up in self.uploaders:
                up.flush(self.buffer)

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
        if wind_samples:
            rec.wind_speed_ms = round(statistics.mean(wind_samples), 2)
            rec.wind_gust_ms = round(max(wind_samples), 2)
        if dirs:
            # simple mode of sampled directions (vane snaps to 16 values anyway)
            rec.wind_dir_deg = statistics.mode(dirs)
        rec.rain_mm = round(rain_tips * cal.rain_bucket_mm, 3)
        return rec
