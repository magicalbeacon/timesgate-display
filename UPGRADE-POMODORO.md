# Automatic Pomodoro breaks 0.5.3

A completed 25-minute focus now automatically starts a 5-minute break. After every fourth completed focus, the break is 15 minutes. The next focus always waits for **Start focus**. The dashboard shows the focus number (1–4) and total completed focuses since Reset. Pause/Resume works during focus or break; Reset clears the count and returns to idle focus. A server restart also clears the timer and count; sessions are not persisted.

Break time is measured from the actual focus deadline. If you return two minutes later, a short break shows three minutes left. If both focus and break have finished, the timer waits at zero for your next manual focus; it does not run unattended focus cycles.

**No screen-4 setup is needed if its current countdown already works.** This update changes the server timer only. Existing static/typing/sleeping art and 1-second/10-second profiles remain available. No additional .env key is required.

The selected animated GIF is decorative: if the firmware plays it, it continues while idle, paused, focusing, resting or complete. It does not prove that the timer or server is alive. The countdown can freeze when polling is lost; check the dashboard for phase, pause state and connectivity. Typing and sleeping backgrounds are selected explicitly; starting a break does not automatically change the picture. The browser ring remains browser-only. Focus starts manually, breaks start automatically, and a restart resets the timer and session count to idle.

One-second type-23 polling has [prior Times Gate implementation evidence](https://github.com/Firemoon777/divoom-timegate-bg3/blob/master/server/__main__.py), but exact timing on this firmware is unverified. Animated GIF background plus native text is experimental. The device may ignore animation, retain one frame, or show Loading; an acknowledgement alone does not prove rendering. No per-frame uploads, automatic setup, phase-driven background changes or automatic retries were added.

**Keep stocks stopped and weather setup on hold.** A prior weather failure, if present, is not resolved by this update. Screen 3 remains app-controlled; these experiments send only a single targeted LCD3 (human screen 4) item-list request. Do not use whole-device themes, resets or all-screen setup commands.

## 1. Back up and extract

Save the new attachment as ~/timesgate-pixel-cat-0.5.3.zip. The commands assume the current project is ~/timesgate-combined. Adjust paths before running if different. Keep the previous ZIP and backup folder; do not remove the Compose state volume.

Run this block only once, in the same terminal. Stop if any command fails; do not continue with a failed extraction or missing .env.

```sh
cd ~/timesgate-combined
sudo docker compose exec timesgate node src/cli.ts stop
sudo docker compose down
cd ~
backup="timesgate-combined-backup-$(date +%Y%m%d-%H%M%S)"
mv timesgate-combined "$backup"
unzip timesgate-pixel-cat-0.5.3.zip
cp "$backup/.env" timesgate-combined/.env
chmod 600 timesgate-combined/.env
cd timesgate-combined
```

Keep the working .env. Do not overwrite it with .env.example or share its contents. Existing POMODORO_ENABLED=true and SERVER_BASE_URL=http://YOUR_PI_LAN_IP:8081 remain valid. SERVER_BASE_URL must use the Pi's private LAN IPv4 address, not the Divoom address, localhost or a Docker address. Keep TARGET_SCREENS=1,2, PORT=8081 and the existing weather/write flags. This release changes no credentials.

## 2. Build and verify the stopped service

```sh
sudo docker compose up -d --build
sudo docker compose exec timesgate node -p "JSON.parse(require('fs').readFileSync('package.json')).version"
sudo docker compose exec timesgate node src/cli.ts status
sudo docker compose exec timesgate node src/cli.ts probe
```

Version must be 0.5.3, stock control stopped/unarmed, and the read-only probe successful. An existing halted flag is deliberately retained; do not clear it by arming stocks. Rebuilding alone changes no installed layout. If build, startup or probe fails, stop here and retain the bounded error. Never share broad printenv, docker compose config or credentials.

Open http://YOUR_PI_LAN_IP:8081 on the same trusted LAN. Confirm the existing cat URL /pomodoro/cat-v2.gif and the new /pomodoro/cat-loop-v1.gif and /pomodoro/cat-sleep-v1.gif load in a browser, and /pomodoro/4/countdown returns a string DispData. Browser GIF playback is a preview, not evidence of device support. The native device must reach these URLs too.

The dashboard has no login; keep port 8081 off the internet and untrusted networks. Browser controls have Host/Origin, CSRF and POST protections, but do not provide user authentication. Start/Pause/Resume/Reset affect only the local timer and never send device commands.

## 3. Use the updated timer

Refresh http://YOUR_PI_LAN_IP:8081 after the version and read-only checks. It should show Focus 1/4 and 0 completed. Choose Start focus when ready. After 25 minutes, the countdown changes to a five-minute break without another button press or a device write. The fourth completed focus gets 15 minutes. When a break reaches zero, Start focus becomes available again.

If screen 4 already polls the countdown, keep its working layout. The following setup commands are **optional, separate experiments**, retained for first-time setup or a deliberate profile change. Do not run them simply to enable automatic breaks. Stock and weather holds remain in place.

## Optional: test faster text first, keeping the static cat

Only after the checks above pass, install this one screen-4 profile. Stock rotation must remain stopped.

```sh
sudo docker compose exec timesgate node src/cli.ts pomodoro setup --apply --poll-seconds 1 --background static
sleep 3
sudo docker compose exec timesgate node src/cli.ts status
```

Check lastPomodoroSetup for the acknowledgement and lastPomodoroSetupProfile for static / 1. Start the timer on the dashboard and visually check screen 4 for roughly one-second changes without repeated Loading. Network timing may skip a displayed second. Reset when finished. No physical response or a failed request is not permission to retry blindly.

## Optional: test animation separately, keeping 10-second text polling

After the static test is understood, this changes only the background experiment relative to the known fallback:

```sh
sudo docker compose exec timesgate node src/cli.ts pomodoro setup --apply --poll-seconds 10 --background animated
sleep 3
sudo docker compose exec timesgate node src/cli.ts status
```

Look for the blink/paw-tap loop and intact countdown on screen 4. A brief one-time setup transition is possible; no recurring setup or frame pushing occurs. Observe idle/paused too: movement remains decorative. The other screens should remain unchanged. Stop and report unexpected behavior; do not reset the whole device.

## Optional: combine only after both separate tests work

```sh
sudo docker compose exec timesgate node src/cli.ts pomodoro setup --apply --poll-seconds 1 --background animated
sleep 3
sudo docker compose exec timesgate node src/cli.ts status
```

The profile in status records only the last acknowledged setup during this process. It is not device read-back and becomes null on restart; the device may retain its old layout. None of these commands arms stocks or retries weather.

## Optional sleeping/break loop

For the resting cat with gentle breathing and an ear twitch, select the sleeping background explicitly. This is a separate screen-4 setup; an automatic break does not select it automatically. You can choose --poll-seconds 10 instead to test its animation independently first.

```sh
sudo docker compose exec timesgate node src/cli.ts pomodoro setup --apply --poll-seconds 1 --background sleeping
sleep 3
sudo docker compose exec timesgate node src/cli.ts status
```

The sleeping loop also keeps playing during focus, pause or idle if it remains selected. To return to typing, deliberately select --background animated with the desired polling interval. Do not repeatedly reinstall backgrounds to simulate animation; the GIF itself should loop on the device. If a setup fails or its result is uncertain, inspect the screen and error before another write.

## Static, 10-second fallback

If the device is responsive and a deliberate fallback is appropriate, use the original profile:

```sh
sudo docker compose exec timesgate node src/cli.ts pomodoro setup --apply --poll-seconds 10 --background static
sleep 3
sudo docker compose exec timesgate node src/cli.ts status
```

The unqualified pomodoro setup --apply command also selects this fallback. If any setup times out, is rejected, or has uncertain results, inspect the panel and sanitized status before attempting another write. Stock stop does not remove a previously installed native poller. Selecting another face for screen 4 only in the Divoom app is a separate manual alternative; avoid all-screen/theme changes.
