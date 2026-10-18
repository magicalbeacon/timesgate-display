# Times Gate: stocks, weather and Pomodoro

A separate Docker source package for a Raspberry Pi 3B+ running **64-bit Raspberry Pi OS (arm64)**. It combines quotes, genuine completed daily candles, rendering and device updates. It is not a prebuilt image.

**Stock images target only human screens 1 and 2 (the leftmost two). Optional weather setup targets screen 5 only; optional Pomodoro setup targets screen 4 only. Screen 3 stays app-controlled and is never cleared, set up or sent images.** Both native setup commands are separate explicit opt-ins; automatic stock targeting still rejects other numbers. No global image-ID reset exists. Never run a second automatic image writer at the same time.

Release **0.5.4** adds optional screen-4 phase visuals to the automatic breaks from 0.5.3: each completed 25-minute focus starts a 5-minute break, or a 15-minute break after every fourth focus. The next focus always waits for a manual Start. The dashboard shows the current focus within the four-session cycle and total completed focuses since Reset. Read **UPGRADE-PHASE-DISPLAY.md** for backup, setup, verification and rollback. No new environment keys are required.

Animation is decorative and, if supported, keeps looping while idle or paused. Animated background plus native text and exact one-second timing remain unverified on this firmware. The explicit phase profile makes one screen-4 layout write at each focus/break transition; there are no continuous frame uploads. Only focus sessions start manually; breaks follow their actual focus deadline even if no browser is open. The progress ring remains browser-only. Reset and server restart clear the cycle and session count.

**Keep stocks stopped and weather setup on hold.** This update does not diagnose or fix a prior weather setup failure. Only scoped screen-4 phase writes after explicit setup are part of this update; no stock Loading fix, global reset or other-screen setup is included. UPGRADE-DIAGNOSTICS.md and UPGRADE-WEATHER.md remain earlier references, not instructions to retry weather now.

## What rotates

The blank configuration template uses the generic example `AAPL,MSFT`. Replace it with your own ordered list of 2–20 unique symbols. These examples do not describe anyone's holdings or watchlist.

At the default 15 seconds per pair, the two examples occupy screens 1–2. Larger lists rotate in order. Odd-length lists wrap continuously: A/B, C/D, E/A, B/C, D/E. There is no brokerage account or watchlist synchronization. `VWRA` normalizes to `VWRA.L`.

- US stocks and SPY: Finnhub quotes (approximately every 30 seconds, subject to rate limits), plus Yahoo completed daily OHLC cached six hours. Current exchange-local day is always excluded. A quote is never used to fabricate a candle.
- VWRA: Yahoo `VWRA.L`, USD, price-only.
- SPCX: verified Yahoo Space Exploration Technologies `SPCX`, USD, price-only in this release. No assumed Finnhub entitlement.
- USD/JPY: Yahoo `JPY=X`, price-only, **JPY per USD**, never dollars.
- Yahoo routes are always marked delayed and unofficial. Delay length is not promised for every instrument. London listings are reported by Yahoo with a 20-minute delay. Source timestamps are shown independently of fetch times.
- Missing/unsupported data remains NO DATA. Old or failed feeds show STALE. Market closure can make a valid last quote look stale; there is no exchange-calendar inference.

## Keep the working installation

Clone or extract this repository into a new `timesgate-combined` folder. If migrating an older installation, place it beside the existing `timesgate-stock-display`. Do not overwrite either old package or its `.env`. Keep the stock server running if you want to restore its native polling layouts later. Do not run the old all-five-screen setup command: manage any remaining screens separately in the Divoom app.

### 1. Build locally on the Pi

```sh
cd timesgate-combined
sudo docker build -t timesgate-combined:local .
```

The build runs tests sequentially, with a 128 MiB Node heap limit. Compose requests a 384 MiB container limit, but some Pi kernels do not enforce Docker memory limits; the 128 MiB Node heap limit still applies. These are conservative limits, not measured Raspberry Pi performance guarantees. The only runtime npm dependency is `jpeg-js` with a lockfile; there is no Python/browser renderer.

### 2. Create a separate configuration without displaying secrets

If the two project folders are siblings, this migration copies only DEVICE_IP, DEVICE_ENDPOINT, LOCAL_TOKEN and FINNHUB_API_KEY from the old local file. It refuses to overwrite a destination and leaves writes disabled.

```sh
sudo docker run --rm --user "$(id -u):$(id -g)" \
  --read-only --cap-drop ALL --security-opt no-new-privileges \
  --mount "type=bind,src=$(realpath ../timesgate-stock-display/.env),dst=/old.env,readonly" \
  --mount "type=bind,src=$(pwd),dst=/work" \
  timesgate-combined:local node src/migrate.ts --from /old.env --to /work/.env
```

Alternatively, `cp .env.example .env` and enter your existing device address and Finnhub key locally. Keep the file private (`chmod 600 .env`). Never send API keys or LocalToken in chat. Do not use `docker compose config` or broad `printenv` diagnostics where their output could expose secrets.

Check/edit `.env` locally:

- `TARGET_SCREENS=1,2` must stay exactly this value.
- `TICKERS` contains the ordered list above (2–20 unique entries).
- `DEVICE_IP` is the Divoom's private LAN IPv4 address, not the Pi or Docker localhost.
- `DEVICE_ENDPOINT=post` is the default endpoint; verify compatibility with your firmware.
- `LOCAL_TOKEN` is optional; numeric zero is valid.
- `FINNHUB_API_KEY` stays server-side in request headers, never device payloads or URLs.
- `DEVICE_WRITES_ENABLED=false` initially.
- `ROTATION_SECONDS=15`, `QUOTE_REFRESH_SECONDS=30`, `HISTORY_REFRESH_HOURS=6`.
- Leave `PORT=8081` with the provided Compose port mapping.

### 3. Start data and previews, with no device writes

```sh
sudo docker compose up -d
sudo docker compose exec timesgate node src/cli.ts status
```

Open `http://YOUR_PI_LAN_IP:8081`. Images are software previews, not photos of your Divoom. Wait for data; initial requests and rate limits may take a minute. Stock image pushes do not need `SERVER_BASE_URL`. Optional native weather and Pomodoro do require it: use the Pi's private-LAN HTTP origin on port 8081. Do not expose port 8081 to the internet; the LAN dashboard is unauthenticated. Optional Pomodoro controls can be used by anyone on your trusted LAN; use the exact configured IP/port. Other dashboard routes remain read-only.

### 4. Optional: save the existing stock layout for selected-screen restoration

This exports the stock app's proposed polling layouts without tokens. It is **not a backup of custom app content**. It is useful only if those stock layouts are what you want restored on screens 1–2.

From the original stock folder:

```sh
sudo docker compose exec -T timesgate node src/cli.ts layout > ../timesgate-combined/stock-layout.json
cd ../timesgate-combined
sudo docker compose cp stock-layout.json timesgate:/app/state/stock-layout.json
```

The original stock server and its configured Pi LAN callback address must remain reachable for restored native polling text to update. No other screen is restored; weather on screen 5 is also unaffected by stock restoration.

### 5. Enable automatic writes explicitly

Set `DEVICE_WRITES_ENABLED=true` in this new `.env`, then recreate the container:

```sh
sudo docker compose up -d --force-recreate
sudo docker compose exec timesgate node src/cli.ts probe
sudo docker compose exec timesgate node src/cli.ts arm --apply
sudo docker compose exec timesgate node src/cli.ts status
```

Probe is read-only. Arming is processed by the service and probes again before changing anything. It begins with the first pair. Check physical screens 1–2 and confirm your other panels remain as intended. Weather setup, if desired, is separate. API success alone does not prove the image is visible.

Every service restart starts stopped and requires a new `arm --apply`. This prevents an uncertain interrupted device write from silently resuming. The automatic rotation continues once armed until stopped, restarted or halted by an error.

## Stop and recover

Stop upcoming writes immediately:

```sh
sudo docker compose exec timesgate node src/cli.ts stop
sudo docker compose exec timesgate node src/cli.ts status
```

A request already sent to the device may finish. The last image remains displayed; stopping does not restore another app. If you want the entire service off afterward: `sudo docker compose stop`.

After stopping, restore **only screens 1–2** to the saved native stock layouts:

```sh
sudo docker compose exec timesgate node src/cli.ts restore --layout /app/state/stock-layout.json --apply
sudo docker compose exec timesgate node src/cli.ts status
```

Keep `DEVICE_WRITES_ENABLED=true` for an explicitly requested restore. Restore does not arm rotation or clear a HALTED condition. Custom apps are not backed up or restored by this tool; use the Divoom app to choose those manually if desired.

Device failures halt all subsequent writes, including the second screen of a partially completed pair. Clear and image upload are not atomic, so one selected panel may be blank or changed. Inspect it, restore if needed, then explicitly arm again when ready. The tool never retries an uncertain mutation automatically and never resets global image IDs. Unsupported/exhausted ID responses halt safely.

## Display and reliability limits

- Prices and daily candles are distinct data: Q UTC shows the quote time; C1D THRU shows the last completed candle date. A six-hour-old chart cache gets a visible warning. A freshly fetched history can still end on an older date; that date is always visible.
- US source quotes are stale after 180 seconds by default; delayed Yahoo source quotes after at least 30 minutes, with retrieval staleness still 180 seconds. No claim of guaranteed live prices.
- Stale/error data is retained with warnings, never replaced with zeros or mock prices. On network loss, existing images can freeze, including their last status label. Always read the printed quote date/time.
- Two panels update sequentially. A brief mixed pair is possible; an error can leave only the first updated. Stock writes never address the other three. The optional weather command explicitly addresses only screen 5; screen 3 is outside all application writes. Undocumented firmware-wide behavior cannot be ruled out.
- Yahoo's unofficial endpoint can change, rate-limit or stop working. This is a personal-use experiment; no paid API purchase or new account is required. Check provider terms for your own use.
- No private portfolio positions, account data or trading actions are used. Symbols only are sent to market-data providers.
- This release has **not** been tested on physical hardware in this build environment. Docker was unavailable in the build workspace, so actual image build/arm64 runtime remain for your Pi to verify.

## Tests and sources

`npm test` on Node 24.12+; `npm ci --ignore-scripts` for local dependencies. Tests use mocked network/device calls and synthetic fixtures. No tests contact your device or require a key. See VERIFICATION.md.

Protocol: [Times Gate JPEG](https://docin.divoom-gz.com/web/#/5/133), [next image ID](https://docin.divoom-gz.com/web/#/5/55), [selected text clear](https://docin.divoom-gz.com/web/#/5/141), [native polling constraints](https://github.com/averhaegen/hacs-divoom-times-gate-dev/blob/main/docs/DISPDATA.md).

Data: [Finnhub quote](https://finnhub.io/docs/api/quote), [Finnhub official schema](https://github.com/Finnhub-Stock-API/finnhub-go/blob/master/api/openapi.yaml), [Yahoo VWRA](https://finance.yahoo.com/quote/VWRA.L/), [Yahoo SPCX](https://finance.yahoo.com/quote/SPCX/), [Yahoo USD/JPY](https://finance.yahoo.com/quote/JPY=X/).

## Optional fixed Singapore weather demo on screen 5

See **UPGRADE-WEATHER.md** for exact safe steps. Enable WEATHER_ENABLED=true and set SERVER_BASE_URL to the Pi private-LAN HTTP origin, then explicitly run `weather setup --apply` while stock rotation is stopped. This sends one native polling layout only to internal LCD index 4. It never sends all-five commands, clears another panel, or changes a channel. Native weather rows poll cached text once per minute. NEA/data.gov.sg is fetched once per five-minute cycle; Open-Meteo hourly probability once per 15-minute cycle. No recurring weather image uploads are added.

This optional demo has a fixed public example region: Yishun, Singapore, with nearby Sembawang station S80. It is not device-location detection and is not configurable through `.env`; supporting another region requires coordinated source, validation and test changes. It does not identify the repository owner's location. The panel shows the region's two-hour NEA forecast, nearby Sembawang station S80 temperature/humidity, and a separately sourced Open-Meteo precipitation probability. Source timestamps are preserved independently; the short Semb. caption shows the older sensor day/time in SGT. Display humidity is rounded; full precision is retained in the API. Stale humidity is not made fresh by a current temperature or a successful fetch. Full forecast validity/issue/update times and both sensor timestamps use Singapore time or explicit UTC ISO timestamps and are on `/api/weather`. Missing or invalid readings are never invented.

Seven polling fields use IDs 33–39, arranged into three separated blocks instead of uniform text rows. Fixed headings, source/unit labels, umbrella/thermometer/drop illustrations and two divider lines live in an opaque GIF background. The icons are decorative, not a claim of current conditions. Forecast words, readings, rain probability and status change through native polling. Native fonts/scrolling remain firmware-controlled. Temperature uses decimal-only font246 with a fixed degree-C unit and supported dots when unavailable. Rain uses catalog-listed font492 (12×26, digits and %) so the full value, including its percent sign, centres as one field for 0% through 100%. Missing rain retains only the % unit and a separate N/A or STALE warning, never a false zero or an unverified empty-text clear. Humidity centres beneath its icon. Native centre alignment (align3) is [documented](https://github.com/averhaegen/hacs-divoom-times-gate-dev/blob/main/docs/API.md); font492 is [catalog-supported](https://github.com/averhaegen/hacs-divoom-times-gate-dev/blob/main/docs/FONTS_CATALOG.md) but has not been tested on physical hardware here. Gold forecast, coral temperature, violet humidity and blue rain colours are fixed per polling row; warning text inherits its row colour, with an amber rain window/status. The GIF is opaque and reserves unused palette index 0 because TimesGate treats that index as transparent. `assets/weather-thermometer.gif` and the authoring-only Pillow script are included; the runtime uses embedded bytes and adds no dependency.

The rain row, for example `52% 23-00 SGT`, means the model's chance of precipitation greater than 0.1 mm during that named hour. Open-Meteo timestamps describe the **preceding** hour, so at 23:40 the 00:00 value is selected for 23:00–00:00. This is not the next rolling 60 minutes, not a NEA percentage, and not an observed-rain measurement. The ensemble estimate is coarser (about 27 km) than a local sensor and can differ from the NEA area forecast. The current-hour selection advances locally without another API call. Missing large values show the numeric font’s supported `...` placeholder, with N/A or a block-local warning; they never become 0%. Probability retrieval age ≥30 minutes or fetch errors mark OM stale. Old-hour percentages are never relabelled as a new hour.

Open-Meteo.com is credited on the physical panel, independently of NEA. Fresh blocks need no repeated OK label. A stale forecast becomes STALE; stale observations show `...`/STALE while preserving the dated Semb. caption; stale rain shows `...`/STALE. Missing rain says N/A. Unsupported signed temperature formatting shows `...`/RANGE without stripping the sign from the API data. Rain and observations remain independently labelled. `/api/weather` retains the named interval, retrieval time and source definition; `generationtime_ms` is not treated as forecast issue time. Open-Meteo free use is for personal/non-commercial use; data attribution is under [CC BY 4.0](https://open-meteo.com/en/licence), with [API terms](https://open-meteo.com/en/terms) and [parameter definitions](https://open-meteo.com/en/docs). The forecast-issue field remains available through the read-only API. A stopped stock writer does not undo already-installed native weather polling; select a replacement on screen 5 only in the Divoom app to remove it. Disabling the server/weather endpoints can leave the last display frozen.

Official data: [Singapore two-hour forecast dataset](https://data.gov.sg/datasets/d_3f9e064e25005b0e42969944ccaf2e7a/view), [air temperature dataset](https://data.gov.sg/datasets/d_66b77726bbae1b33f218db60ff5861f0/view), [relative humidity dataset](https://data.gov.sg/datasets/d_2d3b0c4da128a9a59efca806441e1429/view), [public API rate limits](https://guide.data.gov.sg/developer-guide/api-overview/api-rate-limits).

## Optional Pomodoro

Use **UPGRADE-PHASE-DISPLAY.md** for 0.5.4; **UPGRADE-POMODORO.md** documents the earlier timer release. Existing POMODORO_ENABLED and SERVER_BASE_URL settings are preserved. Browser Start/Pause/Resume/Reset control only the server-owned timer. A completed 25-minute focus automatically starts a 5-minute break, or a 15-minute break every fourth focus. The next focus is manual. Pause/Resume works in either phase; Reset and restarting return to idle focus with zero completed sessions. Late polling shows the elapsed break, or a completed break if its deadline already passed; it never starts another focus. Existing screen-4 polling continues working. Explicit `pomodoro setup --apply --poll-seconds 1 --background phase` adds phase labels and four progress marks, with one screen-4 layout command when focus changes to a break or back. Existing static, animated, and sleeping profiles remain manual.

Explicit setup accepts independent --poll-seconds 1|10 and --background static|animated|sleeping|phase options. Omit both for the original static / 10-second fallback. Legacy profiles use one countdown item on human screen 4, TextId 26, type 23, centred font 188. The phase profile adds two polled rows in the clear top band. Setup remains stopped-only and opt-in. Separate background URLs serve embedded typing and sleeping loops; previous static URLs and all legacy text endpoints keep their original behavior. The original curled-up concept remains available as design art, and a new sleeping loop is separately selectable. Only the phase profile switches between typing and sleeping cat at phase changes.

The legacy minimal panel has no phase, pause or freshness label. The phase profile adds a phase label and four progress marks, but no connectivity indicator. Lost polling can leave a countdown frozen; decorative animation can keep moving through a lost connection. Check the dashboard for actual state and connectivity. lastPomodoroSetupProfile reports the last acknowledged request in this process, not device read-back.

[One-second polling precedent](https://github.com/Firemoon777/divoom-timegate-bg3/blob/master/server/__main__.py) supports a cautious experiment, not a universal hardware guarantee. [Native polling guidance](https://github.com/averhaegen/hacs-divoom-times-gate-dev/blob/main/docs/DISPDATA.md) documents text retrieval after setup. Animated BackgroudGif with the text overlay still needs a physical test. The short loop's frame and byte limits are our engineering choices, not claimed firmware limits.

Timer controls are available to anyone who can open the configured dashboard on the trusted LAN. Exact Host/Origin checks, CSRF tokens and strict POST payloads mitigate cross-site requests; they are not a login or protection for an internet-exposed service.
