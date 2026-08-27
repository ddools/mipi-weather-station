"""Entry point: `weatherstation` console script."""

from __future__ import annotations

import logging

from . import config
from .core.sampler import Sampler
from .sensors import build_sensors
from .store import LocalBuffer
from .upload import build_uploaders


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    cfg = config.load()
    air, anemometer, rain, vane, air_quality = build_sensors(cfg)
    buffer = LocalBuffer(cfg.storage.sqlite_path)
    uploaders = build_uploaders(cfg)
    logging.info(
        "station '%s' starting (mock=%s, uploaders=%s)",
        cfg.station.name,
        config.mock_sensors(),
        [u.name for u in uploaders] or "none",
    )
    Sampler(
        cfg, air, anemometer, rain, vane, buffer, uploaders, air_quality=air_quality
    ).run_forever()


if __name__ == "__main__":
    main()
