# Diagnose a failed weather setup (0.4.3)

This release improves failure reporting. It does not claim to fix an unknown device failure. The screen-5 artwork and layout are unchanged from 0.4.2. Rebuilding makes no device writes and leaves stock rotation stopped. Do not retry weather setup or arm stocks until the read-only checks and the uncertain screen state have been reviewed.

## Install while preserving configuration

The commands below assume the existing project is `~/timesgate-combined` and the newly downloaded ZIP is `~/timesgate-combined.zip`. Use the actual existing paths if different. Copy the ZIP to the Pi first; do not paste credentials into chat.

```sh
cd ~/timesgate-combined
sudo docker compose exec timesgate node src/cli.ts stop
umask 077
cp -n .env .env.before-diagnostics-0.4.3
unzip -o ~/timesgate-combined.zip -d ~
test -f .env
sudo docker compose up -d --build --force-recreate
sudo docker compose exec timesgate node -p "JSON.parse(require('node:fs').readFileSync('package.json','utf8')).version"
sudo docker compose exec timesgate node src/cli.ts probe
sudo docker compose exec timesgate node src/cli.ts status
```

Expected version: `0.4.3`. The ZIP contains no `.env` or state volume. Do not rerun migration, replace `.env`, dump environment/configuration, or use `docker compose down -v`.

The probe reads the next image ID only. It does not switch, clear, set up or upload any screen. A successful probe confirms this read command was acknowledged; it does not prove the weather layout can render.

## Check the callback address, if the probe succeeds

Print only the validated callback origin:

```sh
sudo docker compose exec timesgate node --input-type=module -e "import {loadConfig,requireWeatherServer} from './src/config.ts'; console.log(requireWeatherServer(loadConfig()))"
```

It must be the Pi's private LAN IP on port 8081, not the Divoom IP, localhost, or the previous stock server's port 8080. From another device on the same Wi-Fi, open that origin followed by `/weather/thermometer-v42.gif` and `/weather/5/forecastCompact`. Expect the artwork and JSON containing a string `DispData`. This checks LAN reachability; Divoom-specific Wi-Fi isolation can still differ.

## Interpret diagnostics

A future explicitly requested setup records only bounded reasons such as:

- `HTTP status 401`: the request received that HTTP status; it is not a raw response dump.
- `request timed out` / `network request failed`: the request outcome can be uncertain; inspect the screen before any deliberate retry.
- `response was not valid JSON` / `response omitted error_code`: the device response was not a supported success acknowledgement.
- `device error_code 7`: the device returned that numeric code. Its meaning still needs verification; the application does not invent an explanation.

No reason includes raw body/header/exception text or credentials. Any failed weather write still halts stock writes and is never automatically retried. Existing failures cannot be reconstructed retrospectively: after a rebuild, `lastWeatherSetup` is null until a new explicit request completes. Keep the earlier result available while diagnosing. There is no instruction here to resend setup or change a Divoom base face.
