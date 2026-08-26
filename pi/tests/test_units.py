from weatherstation.core import units


def test_conversions():
    assert round(units.c_to_f(0), 1) == 32.0
    assert round(units.ms_to_mph(1), 3) == 2.237
    assert round(units.mm_to_in(25.4), 3) == 1.0
    assert round(units.hpa_to_inhg(1013.25), 2) == 29.92


def test_dewpoint_reasonable():
    dp = units.dewpoint_c(12.0, 80.0)
    assert 8.0 < dp < 10.0


def test_msl_pressure_increases_with_elevation():
    assert units.sea_level_pressure_hpa(1000.0, 100.0, 10.0) > 1000.0
