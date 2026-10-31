# NOM Alerts Stream Deck Plugin

Seven buttons that talk directly to `server.js` (the same broker everything
else in this repo uses) over your local network — no Streamer.bot, no extra
accounts.

| Button | What it does |
|---|---|
| Panic | Toggles all overlay alerts on/off (two-state) |
| Giveaway: Start | Starts a giveaway — optional custom keyword in the button's settings |
| Giveaway: Close Entries | Stops accepting new entries |
| Giveaway: Draw Winner | Picks a random winner |
| Giveaway: Reset | Clears all entries |
| Karaoke: Next Singer | Advances the queue |
| Karaoke: Clear Queue | Empties the queue |

Each press flashes the Stream Deck's built-in green-check / red-X overlay to
confirm success or failure — no live polling, no custom animations to break.

## Install (no build needed)

1. Copy the whole `com.neighborhoodofmusic.nomalerts.sdPlugin` folder to:
   `%APPDATA%\Elgato\StreamDeck\Plugins\`
   (paste that path into File Explorer's address bar, then drop the folder in)
2. Restart the Stream Deck app (or right-click its tray icon → Quit, then
   reopen it).
3. The buttons appear under the **NOM Alerts** category in the action list —
   drag any of them onto a key.
4. On the first button you drag over, open its property inspector (click the
   key) and check the **Server URL** field — it defaults to
   `http://192.168.6.228:3010`, which should already be correct since that's
   this repo's configured IP everywhere else. It only needs setting once:
   it's shared across every NOM Alerts button on the Stream Deck.
5. For **Giveaway: Start**, there's also an optional **Keyword** field —
   leave it blank to use whatever keyword is already configured on the
   server (or was last set via `admin.html`).

Nothing else to configure. No `npm install`, no Node.js needed on your
machine for this — Stream Deck runs it with its own bundled Node.js runtime.

## Rebuilding (only if you're changing the button logic)

The shipped `bin/plugin.js` inside the `.sdPlugin` folder is a bundled,
dependency-free build of `src/plugin.js` — editing the `.sdPlugin` folder's
`bin/plugin.js` directly won't survive a rebuild, so edit `src/plugin.js`
instead, then:

```
npm install
npm run build    # re-bundles src/plugin.js -> .sdPlugin/bin/plugin.js
npm run icons    # only if you changed gen_icons.py (needs Python + Pillow)
```

Then re-copy the `.sdPlugin` folder to the Plugins directory and restart
Stream Deck (or just restart it if installed as a symlink/dev path).

## Notes

- Property inspectors (the settings screens) use Elgato's
  [sdpi-components](https://sdpi-components.dev) library loaded from their
  CDN — needs internet access the moment you open a button's settings, same
  as any other modern Stream Deck plugin.
- The Panic button syncs its visual state once when it appears on a profile
  (a single fetch, not continuous polling), so it won't lie about whether
  alerts are paused if that happened elsewhere (e.g. `admin.html`) since the
  last time you pressed it.
- Giveaway Draw and Reset, and Karaoke Clear Queue, fire immediately on
  press — there's no confirmation step, by design (kept simple per the
  original ask). Misplaced presses show the red-X failure flash only if the
  server call itself fails, not as a safety check.
