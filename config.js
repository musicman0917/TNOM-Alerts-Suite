// ─── NOM Alerts — Config ────────────────────────────────────────────────────
// Keep this file out of any public repos / GitHub pushes.
// Edit values here; nom-alerts.html reads everything from CONFIG.

const CONFIG = {
  // Streamer.bot WebSocket (running on server PC)
  streamerbotUrl:  'ws://127.0.0.1:8080',

  // Twitch token broker (same server, same origin)
  tokenBrokerUrl:  'http://192.168.6.228:3010/token',

  // Alert sounds volume (0.0 – 1.0)
  soundVolume:     0.8,
};
