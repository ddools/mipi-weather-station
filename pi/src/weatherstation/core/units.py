"""Unit conversions and derived quantities (SI internally)."""

import math


def c_to_f(c: float) -> float:
    return c * 9 / 5 + 32


def ms_to_mph(ms: float) -> float:
    return ms * 2.23694


def mm_to_in(mm: float) -> float:
    return mm / 25.4


def hpa_to_inhg(hpa: float) -> float:
    return hpa * 0.02953


def dewpoint_c(temp_c: float, rh: float) -> float:
    """Magnus formula."""
    a, b = 17.62, 243.12
    gamma = (a * temp_c / (b + temp_c)) + math.log(max(rh, 0.1) / 100.0)
    return (b * gamma) / (a - gamma)


def rh_from_dewpoint(temp_c: float, dewpoint_c: float) -> float:
    """Relative humidity (%) implied by an air temperature and dewpoint.

    Inverse of `dewpoint_c` (same Magnus constants). Used to re-express a
    humidity reading taken at one temperature (e.g. a self-heated sensor chip)
    at the true air temperature, holding dewpoint constant.
    """
    a, b = 17.62, 243.12
    gamma_dp = a * dewpoint_c / (b + dewpoint_c)
    gamma_t = a * temp_c / (b + temp_c)
    return max(0.0, min(100.0, 100.0 * math.exp(gamma_dp - gamma_t)))


def sea_level_pressure_hpa(station_hpa: float, elevation_m: float, temp_c: float) -> float:
    """Reduce station pressure to mean sea level."""
    return (
        station_hpa
        * (1 - (0.0065 * elevation_m) / (temp_c + 0.0065 * elevation_m + 273.15)) ** -5.257
    )
