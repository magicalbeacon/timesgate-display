# Pomodoro phase display 0.5.4

This release retains the 25-minute focus, automatic 5-minute break, every-fourth 15-minute break, and manual next focus from 0.5.3. Reset and process restart still clear the session count. No new `.env` setting is required.

## Upgrade and rollback

Back up the complete existing `~/timesgate-combined` directory, including `.env`, before replacing any files. Retain the Compose state volume and old image. Use only sanitized 0.5.4 release source; preserve the original `.env` with mode 600 and any local modifications. A Docker restart clears an active Pomodoro session, so choose a time when interruption is acceptable. Keep the stock HALTED flag and weather hold; do not arm stocks or retry weather setup.

After replacing source, rebuild and start the service. Verify the container package version is 0.5.4, `/healthz` returns `{"ok":true}`, `/api/status` reports the stock hold intact, and `/pomodoro/4/countdown` returns a string `DispData`. If verification fails, restore the backed-up directory and rebuild the previous image without removing the state volume. The timer restarts at idle under either version.

## Enable screen 4 phase visuals

The current native layout remains in place until this separate explicit step:

```sh
cd ~/timesgate-combined
sudo docker compose exec timesgate node src/cli.ts pomodoro setup --apply --poll-seconds 1 --background phase
```

Check sanitized status for `lastPomodoroSetup`, `lastPomodoroSetupProfile`, `phaseDisplayActive`, and `lastAcknowledgedPhase`, then inspect the physical panel. The new layout polls Focus / Short break / Long break, four session progress marks (`O` completed, `.` remaining), and the countdown. The labels occupy the clear top 22 pixels of the existing GIFs; the clock remains in its proven footer. The working typing cat is used for focus and the sleeping cat for both break types. One-second polling is requested, though physical display cadence may be slower.

At a focus-to-break or break-to-focus transition, the server sends **one** targeted LCD3 (human screen 4) `Draw/SendHttpItemList` command with the appropriate fixed GIF URL. The protocol requires a fresh layout command to select a different background; changing GIF bytes at a cached URL is not treated as a reliable refresh. Text polling updates the label and marks without further device writes. Reset while already in focus updates the marks through polling. There are no continuous frame uploads, writes to other screens, or automatic stock permissions.

The profile operates only after an acknowledged explicit setup in the current process. Restart or stop disables automatic switching until another explicit setup. If a phase write fails or has an uncertain result, switching disables itself without retrying; the last acknowledged layout and its polling text are the fallback. Inspect screen 4 before deciding whether to run setup again. Acknowledgement does not prove physical rendering or animation.

The label uses native font 170, progress marks use font 196, and the working countdown keeps font 188. These choices follow the [Times Gate font catalog](https://github.com/averhaegen/hacs-divoom-times-gate-dev/blob/main/docs/FONTS_CATALOG.md) and [screen-scoped item-list protocol](https://github.com/averhaegen/hacs-divoom-times-gate-dev/blob/main/docs/API.md). Firmware behavior still needs visual inspection.

## Return to the previous layout

After checking screen 4, explicitly reinstall the known typing cat profile if needed:

```sh
sudo docker compose exec timesgate node src/cli.ts pomodoro setup --apply --poll-seconds 1 --background animated
```

This disables automatic phase switching in the current process. It does not change stock rotation, HALTED, weather, or other screens. To roll back the app version, restore the backup directory and rebuild the previous image while retaining its `.env` and Compose state volume.
