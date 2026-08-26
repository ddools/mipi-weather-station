# Contributing

Thanks for your interest! This is a hobby project, but PRs and issues are welcome.

## Ground rules
- Python code is formatted with **Ruff** (`ruff format`) and linted with `ruff check`.
- Keep sensor drivers hardware-optional: everything must run with `WS_MOCK_SENSORS=1`
  so contributors without a Pi can develop and test.
- Never commit secrets. `.env` and `config.yaml` are gitignored — update the
  `.example` files instead.
- Add/adjust tests under `pi/tests/` for any behaviour change.

## Dev setup
```bash
cd pi
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest
```

## Adding an uploader
Subclass `weatherstation.upload.base.Uploader`, implement `send(record) -> bool`,
and register it in `upload/__init__.py`. Uploaders must be idempotent-ish and
safe to retry — the store-and-forward loop will re-call `send` on failure.
