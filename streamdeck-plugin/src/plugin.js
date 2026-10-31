import streamDeck, { SingletonAction } from "@elgato/streamdeck";

const DEFAULT_SERVER_URL = "http://192.168.6.228:3010";

async function getServerUrl() {
  try {
    const g = await streamDeck.settings.getGlobalSettings();
    const url = g && typeof g.serverUrl === "string" && g.serverUrl.trim();
    return (url || DEFAULT_SERVER_URL).replace(/\/+$/, "");
  } catch (e) {
    return DEFAULT_SERVER_URL;
  }
}

// Fires a POST against the NOM Alerts server and gives the button the
// built-in green-check / red-alert flash as feedback — no custom icon
// state juggling needed for simple, momentary buttons.
async function callApi(action, path, body) {
  const base = await getServerUrl();
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    if (res.ok) {
      await action.showOk();
      return true;
    }
    const text = await res.text().catch(() => "");
    streamDeck.logger.error(`${path} -> HTTP ${res.status} ${text}`);
    await action.showAlert();
    return false;
  } catch (e) {
    streamDeck.logger.error(`${path} failed: ${e.message} (base: ${base})`);
    await action.showAlert();
    return false;
  }
}

// ── Panic Button ──────────────────────────────────────────────────────────
// Two-state toggle. Syncs its visual state once when it appears (not
// continuous polling) so it doesn't lie about whether alerts are actually
// paused if that happened from elsewhere (e.g. admin.html) since last press.
class PanicAction extends SingletonAction {
  manifestId = "com.neighborhoodofmusic.nomalerts.panic";

  async onWillAppear(ev) {
    const base = await getServerUrl();
    try {
      const res = await fetch(`${base}/alerts-paused-state`);
      const data = await res.json();
      await ev.action.setState(data.paused ? 1 : 0);
    } catch (e) {
      streamDeck.logger.error(`panic state sync failed: ${e.message}`);
    }
  }

  async onKeyDown(ev) {
    const wasPaused = (ev.payload.state ?? 0) === 1;
    const newPaused = !wasPaused;
    const ok = await callApi(ev.action, "/alerts-pause-toggle", { paused: newPaused });
    if (ok) await ev.action.setState(newPaused ? 1 : 0);
  }
}

// ── Giveaway ───────────────────────────────────────────────────────────────
class GiveawayStartAction extends SingletonAction {
  manifestId = "com.neighborhoodofmusic.nomalerts.giveawaystart";

  async onKeyDown(ev) {
    const keyword = ((ev.payload.settings && ev.payload.settings.keyword) || "").trim();
    await callApi(ev.action, "/giveaway-start", keyword ? { keyword } : {});
  }
}

class GiveawayCloseAction extends SingletonAction {
  manifestId = "com.neighborhoodofmusic.nomalerts.giveawayclose";
  async onKeyDown(ev) {
    await callApi(ev.action, "/giveaway-stop", {});
  }
}

class GiveawayDrawAction extends SingletonAction {
  manifestId = "com.neighborhoodofmusic.nomalerts.giveawaydraw";
  async onKeyDown(ev) {
    // Server responds 400 with no entries — callApi's showAlert() on a
    // non-OK response already covers that correctly.
    await callApi(ev.action, "/giveaway-draw", {});
  }
}

class GiveawayResetAction extends SingletonAction {
  manifestId = "com.neighborhoodofmusic.nomalerts.giveawayreset";
  async onKeyDown(ev) {
    await callApi(ev.action, "/giveaway-reset", {});
  }
}

// ── Karaoke ────────────────────────────────────────────────────────────────
class KaraokeNextAction extends SingletonAction {
  manifestId = "com.neighborhoodofmusic.nomalerts.karaokenext";
  async onKeyDown(ev) {
    await callApi(ev.action, "/queue/next", {});
  }
}

class KaraokeClearAction extends SingletonAction {
  manifestId = "com.neighborhoodofmusic.nomalerts.karaokeclear";
  async onKeyDown(ev) {
    await callApi(ev.action, "/queue/clear", {});
  }
}

streamDeck.actions.registerAction(new PanicAction());
streamDeck.actions.registerAction(new GiveawayStartAction());
streamDeck.actions.registerAction(new GiveawayCloseAction());
streamDeck.actions.registerAction(new GiveawayDrawAction());
streamDeck.actions.registerAction(new GiveawayResetAction());
streamDeck.actions.registerAction(new KaraokeNextAction());
streamDeck.actions.registerAction(new KaraokeClearAction());

streamDeck.connect();
