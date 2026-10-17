# Upgrade the running combined app: illustrated screen 5 weather (0.4.3)

The optional weather panel is a fixed Singapore demo (Yishun forecast and Sembawang observations), not automatic location detection or an environment-configurable region.

This simplifies the weather into three colour-coded blocks with visible dividers, larger numbers and genuinely sourced hourly rain probability, using native text polling on **screen 5 only**. These steps work whether or not you installed the earlier 0.2 or 0.3 weather release. Stock screens 1–2 image behavior is unchanged, including the Loading issue being diagnosed. Screens 3–4 remain outside all software writes; screen 3's photo album stays managed in the Divoom app.

**If a previous setup failed, stop here and follow UPGRADE-DIAGNOSTICS.md before attempting another setup.**

Keep your existing `.env`. Do not run the first-install migration again and do not replace it with `.env.example`.

## 1. Stop stock writes and preserve the existing version

From the working `timesgate-combined` directory on the Pi:

```sh
sudo docker compose exec timesgate node src/cli.ts stop
umask 077
cp -n .env .env.before-weather-0.4.3
```

Keep the existing ZIP or make a separate source-folder backup before extracting the updated ZIP. Extract the new `timesgate-combined` files over the same source folder; the package contains **no `.env`**, no state volume, and no credentials. Check that your existing `.env` still exists. Do not run `docker compose down -v`; that would remove local control/restore state.

## 2. Add only the weather settings locally

Open your existing `.env` in your local editor and add/update only if these settings are missing or different:

```dotenv
WEATHER_ENABLED=true
SERVER_BASE_URL=http://YOUR_PI_LAN_IP:8081
```

Use the Pi's private LAN IPv4 address, not the Divoom address, Docker's container address, or localhost. The Divoom must reach that HTTP address directly. Keep your existing ticker list, TARGET_SCREENS=1,2, DEVICE_IP, Finnhub key and LocalToken unchanged. DEVICE_WRITES_ENABLED must remain true for the explicit setup command.

## 3. Rebuild and check weather before changing screen 5

```sh
sudo docker compose up -d --build --force-recreate
sudo docker compose exec timesgate node src/cli.ts status
```

Open `http://YOUR_PI_LAN_IP:8081/api/weather` or the dashboard. Allow the initial four public data requests to finish (three NEA feeds and one Open-Meteo feed). Missing or delayed observations remain honestly labelled; there is no fallback weather. Starting the container does not install or re-install any device layout. Stock rotation starts stopped after every restart.

## 4. Apply to screen 5, then resume stocks

```sh
sudo docker compose exec timesgate node src/cli.ts weather setup --apply
sudo docker compose exec timesgate node src/cli.ts status
```

Wait until `lastWeatherSetup` reports that screen 5's native setup was acknowledged, then inspect screen 5. Acknowledgement is not proof of visible rendering. This sends exactly one native item-list command to internal LCD index 4. It sends no JPEG, image-ID reset, text clear or channel switch.

When ready to resume the existing stock rotation:

```sh
sudo docker compose exec timesgate node src/cli.ts arm --apply
```

The native weather panel polls cached text once per minute. The Pi fetches NEA/data.gov.sg at most once per five-minute cycle and Open-Meteo once per 15 minutes, shared across all rows. Polling does not repeatedly upload the panel. Reapply setup once even if an earlier weather layout is already installed so the new artwork, field positions and fonts are loaded.

## What the weather panel means

- YISHUN / NEA: the NEA two-hour area forecast. Full issue/validity timestamps are in the browser/API.
- S80 SEMBAWANG: nearby station temperature and relative humidity, not a sensor physically in Yishun.
- Semb. caption: the older of the temperature and humidity source timestamps, with day and Singapore time. The two feeds can be hours apart; full individual timestamps and forecast issue time are available at `/api/weather`.
- Rain-drop row: probability of precipitation greater than 0.1 mm in the labelled hour, for example 52% for 23–00 SGT. The percentage is an Open-Meteo model estimate, separate from NEA, not the next rolling 60 minutes. Open-Meteo.com is credited immediately below it. Missing probability shows only its % unit with N/A, never a fabricated 0%.
- Warnings are local to each block. Stale forecast says STALE; stale observations show .../STALE and keep their dated Semb. caption; stale rain shows %/STALE. A successful HTTP fetch does not make an old measurement current.

The setup uses seven polling fields, IDs 33–39, and an original 128×128 illustrated GIF with two divider lines. Temperature retains its decimal font and fixed degree-C label. Rain uses catalog-listed font492 so the entire number and % sign centre together at any supported value. Humidity centres beneath its icon. Font492 is documented but not yet verified on this physical unit. The umbrella, thermometer and drop icons are fixed decorations; forecast words and numbers update. Native fonts and long-line scrolling are firmware-controlled. Changing condition illustrations are not pushed, avoiding a new recurring image-update path. No photo-library access is added.

## Stop / remove

`node src/cli.ts stop` stops stock image pushes and cancels pending setup requests; it does not stop a weather panel that the Divoom already polls autonomously. To remove that weather face, select a different layout on **screen 5 only** in the Divoom app. Avoid all-screen themes. Turning off the server or weather feed can leave the last text frozen; its printed source time remains important.

A failed/uncertain weather setup halts future stock writes and is not retried automatically. Inspect screen 5 before retrying explicitly. No automatic recovery changes any other panel.
