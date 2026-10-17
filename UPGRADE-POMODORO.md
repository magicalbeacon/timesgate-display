# Add screen4 Pomodoro (0.5.0)

The dashboard gets Start, Pause, Resume and Reset, a smooth progress ring, and a server-owned 25-minute focus / 5-minute break timer. Each phase starts manually. Screen4 uses native text polling every **10 seconds**, so its countdown changes in roughly ten-second steps. The physical panel has static artwork and a completion percentage; the animated, colour-changing ring is browser-only. Font400 and native alignment are documented upstream but not hardware-verified here.

No timer starts at boot. Refreshing the browser does not reset it; restarting the container resets it to an idle 25-minute focus session. An outage can leave the physical panel frozen: its bottom SGT update time is a freshness cue, not a guaranteed warning. There are no sounds or automatic phase advances.

## 1. Put the new ZIP beside the current project

Save the source package as `~/timesgate-combined.zip` on the Pi. These commands assume the existing working installation is `~/timesgate-combined`. If yours is elsewhere, change those paths first. Do not copy the example over your existing `.env`.

```sh
cd ~/timesgate-combined
sudo docker compose exec timesgate node src/cli.ts stop
sudo docker compose down
cd ~
backup="timesgate-combined-backup-$(date +%Y%m%d-%H%M%S)"
mv timesgate-combined "$backup"
unzip timesgate-combined.zip
cp "$backup/.env" timesgate-combined/.env
chmod 600 timesgate-combined/.env
cd timesgate-combined
nano .env
```

Add or edit these two lines locally, leaving the API key, token, ticker list and other working settings intact:

```dotenv
POMODORO_ENABLED=true
SERVER_BASE_URL=http://YOUR_PI_LAN_IP:8081
```

Use the Pi's private LAN IPv4 address, not the Divoom's address, localhost or a Docker address. Keep `PORT=8081` and `TARGET_SCREENS=1,2`. Existing optional `WEATHER_ENABLED` stays as it was. No new credential is needed. `DEVICE_WRITES_ENABLED=true` is required only for the deliberate setup/stock writes below; the browser timer itself works with device writes disabled.

## 2. Build and start, still stopped

```sh
sudo docker compose up -d --build
sudo docker compose exec timesgate node -p "JSON.parse(require('fs').readFileSync('package.json')).version"
sudo docker compose exec timesgate node src/cli.ts status
```

The version must be `0.5.0`. Open `http://YOUR_PI_LAN_IP:8081` using **the same IP and port configured above**. A hostname or another origin is rejected by the timer controls. Test Start/Pause/Resume/Reset in the browser first. These buttons change only local timer state and never install layouts, arm stocks or send device commands.

## 3. Install only screen4, explicitly

Do not run this if another device operation is still unresolved. First run the read-only probe and check it succeeds:

```sh
sudo docker compose exec timesgate node src/cli.ts probe
```

Only after the probe succeeds and you are ready to replace screen4:

```sh
sudo docker compose exec timesgate node src/cli.ts pomodoro setup --apply
sudo docker compose exec timesgate node src/cli.ts status
```

The command queues one native `Draw/SendHttpItemList` setup for internal LCD3 (human screen4). The service must be running and stock rotation stopped. Check `runtime.lastPomodoroSetup` after a second or two, and check the physical screen. An acknowledgement is not proof that the firmware rendered it. Failed/uncertain writes halt; **do not repeatedly retry**. Share only the sanitized reason, never `.env`, broad `printenv` or `docker compose config` output.

This release does not claim to fix weather setup failures. Do not rerun weather setup as part of adding Pomodoro.

After screen4 is confirmed and any halt has been understood, stock rotation can be explicitly resumed:

```sh
sudo docker compose exec timesgate node src/cli.ts arm --apply
sudo docker compose exec timesgate node src/cli.ts status
```

## Stop and restore

Pause or Reset on the dashboard stops/clears the timer without changing a layout. To stop stock pushes, use `node src/cli.ts stop` through Compose as above. Disabling Pomodoro requires setting `POMODORO_ENABLED=false` locally and recreating the container; the last physical display can remain frozen. To restore screen4's previous app face, select **screen4 only** in the Divoom app. There is no automatic backup/restore of custom app content. Never apply an all-screen theme for this step.

## Local control security

The LAN service has no user login. Anyone on your trusted LAN who can open the configured dashboard can operate the timer. Keep port8081 off the internet and off untrusted networks. Control is POST-only, with exact Host/Origin checks, a per-process CSRF nonce, strict bounded JSON, stale-revision rejection, framing protection and no CORS. These checks mitigate cross-site browser requests; they do not replace authentication for an exposed server. Tokens/API keys remain server-side. Native polling GETs are read-only.
