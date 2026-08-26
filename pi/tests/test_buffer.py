from weatherstation.core.records import Record
from weatherstation.store import LocalBuffer


def test_store_and_forward(tmp_path):
    buf = LocalBuffer(tmp_path / "w.sqlite3")
    for _ in range(3):
        buf.append(Record(temp_c=10.0))

    pend = buf.pending("test")
    assert len(pend) == 3

    # send first two, fail the third -> two marked, one remains
    buf.mark_sent("test", pend[0][0])
    buf.mark_sent("test", pend[1][0])
    assert len(buf.pending("test")) == 1


def test_anemometer_maths():
    from weatherstation.sensors.anemometer import Anemometer

    # 10 pulses = 5 rotations in 5s over 9cm radius, adj 1.18
    v = Anemometer.speed_ms(10, 5.0, 9.0, 1.18)
    assert 0.6 < v < 0.7
