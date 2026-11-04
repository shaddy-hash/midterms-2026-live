# Midterms 2026 Live

Mobile-first live tracker for the 2026 U.S. midterms. Compares live Kalshi market odds, market-implied race calls and headlines with the final pre-election forecasts (Decision Desk HQ, On Point Politics, Kalshi, polling averages).

- Site: GitHub Pages from `main`.
- Data: `.github/workflows/update-data.yml` runs `scripts/fetch_data.py` about every 90 seconds and commits `data.json` / `history.json` to the `data` branch. The page reads them from raw.githubusercontent.com.
- Pre-election baselines live in `predictions.json`.
