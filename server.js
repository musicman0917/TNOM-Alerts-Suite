/**
 * NOM Twitch Token Broker
 * ─────────────────────────────────────────────────────────────
 * Handles OAuth authorization code flow, stores refresh token,
 * auto-refreshes access token before expiry, and serves it
 * to the overlay on localhost.
 *
 * PM2:  pm2 start server.js --name nom-token-broker
 * Port: 3010
 */

require('dotenv').config();

const http     = require('http');
const WebSocket = require('ws');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const url      = require('url');

// ─── Config ────────────────────────────────────────────────────────────────
const CLIENT_ID      = process.env.TWITCH_CLIENT_ID      || 'ahmv5pa2kzq44jvn81i7z3k0jqmtgl';
const CLIENT_SECRET  = process.env.TWITCH_CLIENT_SECRET;
const BROADCASTER_ID = process.env.TWITCH_BROADCASTER_ID || '40541927';
const REDIRECT_URI   = process.env.REDIRECT_URI          || 'http://localhost:3010/callback';
const PORT           = parseInt(process.env.PORT)        || 3010;
const SERVER_IP      = process.env.SERVER_IP             || '192.168.6.228';
const TOKEN_FILE     = path.join(__dirname, '.twitch-token.json');

if (!CLIENT_SECRET) {
  console.error('FATAL: TWITCH_CLIENT_SECRET is not set. Add it to your .env file or PM2 environment.');
  process.exit(1);
}

const SCOPES = [
  'moderator:read:followers',
  'channel:read:subscriptions',
  'bits:read',
  'channel:read:redemptions',
  'channel:read:polls',
  'channel:read:predictions',
  'channel:read:hype_train',
  'channel:read:goals',
  'user:read:chat',
  'user:write:chat',
].join(' ');

// ─── Token Store ────────────────────────────────────────────────────────────
// If TWITCH_ACCESS_TOKEN and TWITCH_REFRESH_TOKEN are set in .env,
// they are used as the initial token — no browser auth flow needed.
let tokenStore = {
  accessToken:  null,
  refreshToken: null,
  expiresAt:    0,
};

function saveTokens() {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenStore, null, 2));
}

function loadTokens() {
  // Prefer saved token file (most up-to-date after refreshes)
  if (fs.existsSync(TOKEN_FILE)) {
    try {
      tokenStore = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      console.log('[nom-token-broker] Loaded saved tokens from file');
      return;
    } catch (e) {
      console.log('[nom-token-broker] Could not load token file, checking .env');
    }
  }
  // Fall back to .env values (initial bootstrap)
  if (process.env.TWITCH_ACCESS_TOKEN) {
    tokenStore.accessToken  = process.env.TWITCH_ACCESS_TOKEN;
    tokenStore.refreshToken = process.env.TWITCH_REFRESH_TOKEN || null;
    tokenStore.expiresAt    = process.env.TWITCH_EXPIRES_AT
      ? parseInt(process.env.TWITCH_EXPIRES_AT)
      : Date.now() + (3600 - 300) * 1000; // assume ~1hr if unknown
    console.log('[nom-token-broker] Loaded tokens from .env');
    saveTokens(); // persist so future restarts use the file
  }
}

// ─── Goal State ─────────────────────────────────────────────────────────────
const GOAL_FILE = path.join(__dirname, '.goal-state.json');

// ─── Twitch Channel Goals ─────────────────────────────────────────────────────
// Stores currently active Twitch channel goals keyed by type
// Types: follower, subscriber, subscription, new_subscription, new_subscriber
let activeChannelGoals = {};

function getGoalForAlertType(alertType) {
  // Map alert types to relevant Twitch goal types
  if (alertType === 'follow') {
    return activeChannelGoals['follower'] || activeChannelGoals['new_follower'] || null;
  }
  if (['sub', 'resub', 'giftsub'].includes(alertType)) {
    return activeChannelGoals['subscriber']        ||
           activeChannelGoals['subscription']      ||
           activeChannelGoals['new_subscription']  ||
           activeChannelGoals['new_subscriber']    || null;
  }
  return null;
}

// ─── Panic Button (Alerts Pause State) ───────────────────────────────────────
let alertsPausedState = { paused: false };

// ─── Social Config ────────────────────────────────────────────────────────────
const SOCIAL_CONFIG_FILE = path.join(__dirname, '.social-config.json');
let socialConfig = [
  { enabled: true,  icon: '🟣', handle: '/neighborhoodofmusic', label: 'Twitch' },
  { enabled: true,  icon: '🎵', handle: '@musicman0917',         label: 'TikTok' },
  { enabled: true,  icon: '🐦', handle: '@NomusicNom',           label: 'Twitter' },
  { enabled: true,  icon: '▶️', handle: 'NeighborhoodofMusic',   label: 'YouTube' },
  { enabled: true,  icon: '🦋', handle: '@neighborhoodofmusic',  label: 'Bluesky' },
  { enabled: true,  icon: '💬', handle: 'discord.gg/nom',        label: 'Discord' },
];

let socialScrollerEnabled = true;
(function loadSocialScrollerEnabled() {
  const f = path.join(__dirname, '.social-scroller-enabled.json');
  if (fs.existsSync(f)) {
    try { socialScrollerEnabled = JSON.parse(fs.readFileSync(f, 'utf8')).enabled !== false; } catch(e) {}
  }
})();

function loadSocialConfig() {
  if (fs.existsSync(SOCIAL_CONFIG_FILE)) {
    try { socialConfig = JSON.parse(fs.readFileSync(SOCIAL_CONFIG_FILE, 'utf8')); } catch(e) {}
  }
}

function saveSocialConfig() {
  fs.writeFileSync(SOCIAL_CONFIG_FILE, JSON.stringify(socialConfig, null, 2));
}

// ─── Theme State ─────────────────────────────────────────────────────────────
const THEME_FILE = path.join(__dirname, '.theme.json');
let themeState = { theme: 'tavern' };

function loadThemeState() {
  if (fs.existsSync(THEME_FILE)) {
    try { themeState = { ...themeState, ...JSON.parse(fs.readFileSync(THEME_FILE, 'utf8')) }; }
    catch (e) {}
  }
}

function saveThemeState() {
  fs.writeFileSync(THEME_FILE, JSON.stringify(themeState, null, 2));
}

let goalState = {
  bits:   0,
  subs:   0,
  tips:   0,
  title:  'Stream Goal',
  amount: 500,
  visible: true,
};

function loadGoalState() {
  if (fs.existsSync(GOAL_FILE)) {
    try { goalState = { ...goalState, ...JSON.parse(fs.readFileSync(GOAL_FILE, 'utf8')) }; }
    catch (e) { console.log('[goal] Could not load goal state'); }
  }
}

function saveGoalState() {
  fs.writeFileSync(GOAL_FILE, JSON.stringify(goalState, null, 2));
}

// Streamer payout after Twitch 50/50 split
function subToDollars(tier) {
  const t = parseInt(tier, 10);
  if (t >= 3) return 12.50;
  if (t >= 2) return 5.00;
  return 3.00;
}

function addGoalRevenue(type, amount, tier) {
  const n = parseFloat(amount) || 0;
  const t = parseInt(tier) || 1;
  if (type === 'bits')    goalState.bits += n / 100;
  if (type === 'sub')     goalState.subs += subToDollars(t);
  if (type === 'prime')   goalState.subs += 3.00;
  if (type === 'resub')   goalState.subs += subToDollars(t);
  if (type === 'giftsub') goalState.subs += subToDollars(t) * (n > 1 ? n : 1);
  if (type === 'tip')     goalState.tips += n;
  saveGoalState();
  broadcastGoal();
}

function broadcastGoal() {
  const data = `data: ${JSON.stringify({ type: 'goal-update', goal: goalState })}

`;
  for (const client of sseClients) {
    try { client.write(data); } catch (e) { sseClients.delete(client); }
  }
}

// ─── Giveaway ───────────────────────────────────────────────────────────────
const GIVEAWAY_FILE = path.join(__dirname, '.giveaway-state.json');

let giveawayState = {
  active:  false,      // accepting new entries via chat keyword
  keyword: '!enter',
  entries: [],          // [{ userId, username }]
  winner:  null,         // { userId, username } | null
};

function loadGiveawayState() {
  if (fs.existsSync(GIVEAWAY_FILE)) {
    try { giveawayState = { ...giveawayState, ...JSON.parse(fs.readFileSync(GIVEAWAY_FILE, 'utf8')) }; }
    catch (e) { console.log('[giveaway] Could not load giveaway state'); }
  }
}

function saveGiveawayState() {
  fs.writeFileSync(GIVEAWAY_FILE, JSON.stringify(giveawayState, null, 2));
}

function broadcastGiveaway(payload) {
  const data = `data: ${JSON.stringify({ type: 'giveaway', ...payload })}\n\n`;
  for (const client of sseClients) {
    try { client.write(data); } catch (e) { sseClients.delete(client); }
  }
}

// Shared giveaway actions — called from both the admin HTTP endpoints and
// the !giveaway chat commands, so both surfaces always behave identically.
function giveawayStart(keyword) {
  giveawayState.active  = true;
  giveawayState.keyword = (keyword && keyword.trim()) || '!enter';
  giveawayState.entries = [];
  giveawayState.winner  = null;
  saveGiveawayState();
  broadcastGiveaway({ status: 'started', keyword: giveawayState.keyword, count: 0 });
  sendChatMessage(`🎉 Giveaway started! Type ${giveawayState.keyword} in chat to enter!`);
  console.log(`[giveaway] Started — keyword: ${giveawayState.keyword}`);
}

function giveawayCloseEntries() {
  giveawayState.active = false;
  saveGiveawayState();
  broadcastGiveaway({ status: 'stopped', keyword: giveawayState.keyword, count: giveawayState.entries.length });
  sendChatMessage(`🔒 Giveaway entries are closed! ${giveawayState.entries.length} entered — winner coming soon!`);
  console.log(`[giveaway] Entries closed — ${giveawayState.entries.length} total`);
}

function giveawayDraw() {
  if (!giveawayState.entries.length) return null;
  const winner     = giveawayState.entries[Math.floor(Math.random() * giveawayState.entries.length)];
  const entryCount = giveawayState.entries.length;
  giveawayState.active = false;
  giveawayState.winner = winner;
  saveGiveawayState();
  broadcastGiveaway({
    status:  'drawing',
    keyword: giveawayState.keyword,
    count:   entryCount,
    entries: giveawayState.entries.map(e => e.username),
    winner:  winner.username,
  });
  const discordHandle = socialConfig.find(s => s.label === 'Discord')?.handle;
  const claimNote = discordHandle
    ? ` You MUST be in our Discord (${discordHandle}) to claim your prize!`
    : ' You MUST be in our Discord to claim your prize!';
  sendChatMessage(`🏆 The giveaway winner is @${winner.username}! Congratulations! 🎉${claimNote}`);
  announceGiveawayWinnerToDiscord(winner, giveawayState.keyword, entryCount);
  console.log(`[giveaway] Winner drawn: ${winner.username} (from ${entryCount} entries)`);
  return winner;
}

function giveawayReset() {
  giveawayState.active  = false;
  giveawayState.entries = [];
  giveawayState.winner  = null;
  saveGiveawayState();
  broadcastGiveaway({ status: 'reset' });
  console.log('[giveaway] Reset');
}

function giveawayRemoveEntrant(username) {
  const target = (username || '').trim().replace(/^@/, '').toLowerCase();
  if (!target) return false;
  const before = giveawayState.entries.length;
  giveawayState.entries = giveawayState.entries.filter(e => e.username.toLowerCase() !== target);
  const removed = giveawayState.entries.length !== before;
  if (removed) {
    saveGiveawayState();
    broadcastGiveaway({
      status:  giveawayState.active ? 'active' : 'stopped',
      keyword: giveawayState.keyword,
      count:   giveawayState.entries.length,
    });
    console.log(`[giveaway] Removed entrant: ${target}`);
  }
  return removed;
}

// A chatter counts as a giveaway moderator if they're the broadcaster or
// carry the moderator badge on this message.
function isGiveawayMod(event) {
  if (event.chatter_user_id === BROADCASTER_ID) return true;
  return (event.badges || []).some(b => b.set_id === 'moderator');
}

// ─── Integrations (Discord webhook, etc.) ──────────────────────────────────
const INTEGRATIONS_FILE = path.join(__dirname, '.integrations.json');
let integrations = { discordWebhookUrl: '' };

function loadIntegrations() {
  if (fs.existsSync(INTEGRATIONS_FILE)) {
    try { integrations = { ...integrations, ...JSON.parse(fs.readFileSync(INTEGRATIONS_FILE, 'utf8')) }; }
    catch (e) { console.log('[integrations] Could not load integrations'); }
  }
}

function saveIntegrations() {
  fs.writeFileSync(INTEGRATIONS_FILE, JSON.stringify(integrations, null, 2));
}

function postDiscordWebhook(webhookUrl, payload) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(webhookUrl); } catch (e) { console.log('[discord] Invalid webhook URL'); resolve(false); return; }
    const data = JSON.stringify(payload);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(opts, res => {
      res.on('data', () => {});
      res.on('end', () => resolve(res.statusCode >= 200 && res.statusCode < 300));
    });
    req.on('error', (e) => { console.log(`[discord] Webhook error: ${e.message}`); resolve(false); });
    req.write(data);
    req.end();
  });
}

async function announceGiveawayWinnerToDiscord(winner, keyword, count) {
  if (!integrations.discordWebhookUrl) return;
  const ok = await postDiscordWebhook(integrations.discordWebhookUrl, {
    embeds: [{
      title:       '🎉 Giveaway Winner',
      description: `**${winner.username}**`,
      color:       15844367,
      fields: [
        { name: 'Keyword', value: keyword,       inline: true },
        { name: 'Entries', value: String(count), inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  });
  console.log(ok ? `[discord] Winner posted: ${winner.username}` : '[discord] Failed to post winner');
}

// ─── Health Settings ────────────────────────────────────────────────────────
const HEALTH_FILE = path.join(__dirname, '.health-settings.json');

let healthSettings = { steps: true, water: true };

function loadHealthSettings() {
  if (fs.existsSync(HEALTH_FILE)) {
    try { healthSettings = { ...healthSettings, ...JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8')) }; }
    catch (e) {}
  }
}

function saveHealthSettings() {
  fs.writeFileSync(HEALTH_FILE, JSON.stringify(healthSettings, null, 2));
}

// ─── SSE Alert Bus ──────────────────────────────────────────────────────────
// Overlay connects here to receive fired alerts in real time
const sseClients = new Set();

function broadcastAlert(payload) {
  // Goal tracking is handled by the overlay via _real flag — server just broadcasts
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try { client.write(data); } catch (e) { sseClients.delete(client); }
  }
}

// ─── Twitch API helpers ─────────────────────────────────────────────────────
function twitchPost(endpoint, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const opts = {
      hostname: 'id.twitch.tv',
      path:     endpoint,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function exchangeCode(code) {
  const data = await twitchPost('/oauth2/token', {
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    code,
    grant_type:    'authorization_code',
    redirect_uri:  REDIRECT_URI,
  });
  if (data.access_token) {
    tokenStore.accessToken  = data.access_token;
    tokenStore.refreshToken = data.refresh_token;
    tokenStore.expiresAt    = Date.now() + (data.expires_in - 300) * 1000;
    saveTokens();
    console.log('[nom-token-broker] Token exchanged and saved ✓');
  } else {
    throw new Error(JSON.stringify(data));
  }
}

async function refreshAccessToken() {
  if (!tokenStore.refreshToken) {
    console.log('[nom-token-broker] No refresh token — authorization required');
    return false;
  }
  try {
    const data = await twitchPost('/oauth2/token', {
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type:    'refresh_token',
      refresh_token: tokenStore.refreshToken,
    });
    if (data.access_token) {
      tokenStore.accessToken  = data.access_token;
      tokenStore.refreshToken = data.refresh_token || tokenStore.refreshToken;
      tokenStore.expiresAt    = Date.now() + (data.expires_in - 300) * 1000;
      saveTokens();
      console.log('[nom-token-broker] Token refreshed ✓');
      return true;
    } else {
      console.log('[nom-token-broker] Refresh failed:', JSON.stringify(data));
      tokenStore.accessToken = null;
      return false;
    }
  } catch (e) {
    console.log('[nom-token-broker] Refresh error:', e.message);
    return false;
  }
}

async function getValidToken() {
  if (tokenStore.accessToken && Date.now() < tokenStore.expiresAt) {
    return tokenStore.accessToken;
  }
  const ok = await refreshAccessToken();
  return ok ? tokenStore.accessToken : null;
}

// Auto-refresh 5 min before expiry
function scheduleRefresh() {
  const msUntilExpiry = tokenStore.expiresAt - Date.now();
  const delay = Math.max(msUntilExpiry, 60000); // at least 1 min
  setTimeout(async () => {
    await refreshAccessToken();
    scheduleRefresh();
  }, delay);
}

// ─── Twitch Helix helper ────────────────────────────────────────────────────
function helixPost(path, token, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'api.twitch.tv',
      path,
      method: 'POST',
      headers: {
        'Client-ID':     CLIENT_ID,
        'Authorization': `Bearer ${token}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ─── Twitch EventSub WebSocket ───────────────────────────────────────────────
const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

// Events to subscribe to: [type, version, condition]
function eventsubSubscriptions(sessionId, broadcasterId) {
  return [
    { type: 'channel.follow',            version: '2', condition: { broadcaster_user_id: broadcasterId, moderator_user_id: broadcasterId } },
    { type: 'channel.subscribe',         version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.subscription.gift', version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.subscription.message', version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.cheer',             version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.raid',              version: '1', condition: { to_broadcaster_user_id: broadcasterId } },
    { type: 'channel.raid',              version: '1', condition: { from_broadcaster_user_id: broadcasterId } },
    { type: 'channel.poll.begin',        version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.poll.progress',     version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.poll.end',          version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.prediction.begin',  version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.prediction.progress', version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.prediction.lock',   version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.prediction.end',    version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.hype_train.begin',    version: '2', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.hype_train.progress', version: '2', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.hype_train.end',      version: '2', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.goal.begin',          version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.goal.progress',       version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.goal.end',            version: '1', condition: { broadcaster_user_id: broadcasterId } },
    { type: 'channel.chat.message',        version: '1', condition: { broadcaster_user_id: broadcasterId, user_id: broadcasterId } },
  ].map(sub => ({
    type:      sub.type,
    version:   sub.version,
    condition: sub.condition,
    transport: { method: 'websocket', session_id: sessionId },
  }));
}

function helixGet(path, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.twitch.tv',
      path,
      method: 'GET',
      headers: {
        'Client-ID':     CLIENT_ID,
        'Authorization': `Bearer ${token}`,
      },
    };
    const req = https.request(opts, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(buf) }); }
        catch (e) { resolve({ status: res.statusCode, body: buf }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function helixDelete(path, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.twitch.tv',
      path,
      method: 'DELETE',
      headers: {
        'Client-ID':     CLIENT_ID,
        'Authorization': `Bearer ${token}`,
      },
    };
    const req = https.request(opts, res => {
      res.on('data', () => {});
      res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function sendChatMessage(text) {
  try {
    const token = await getValidToken();
    if (!token) { console.log('[chat] No token — cannot send message'); return; }
    const res = await helixPost('/helix/chat/messages', token, {
      broadcaster_id: BROADCASTER_ID,
      sender_id:      BROADCASTER_ID,
      message:        text,
    });
    if (res.status === 200 && res.body?.data?.[0]?.is_sent) {
      console.log(`[chat] Sent: ${text}`);
    } else {
      console.log(`[chat] Send failed: ${JSON.stringify(res.body)}`);
    }
  } catch (e) {
    console.log(`[chat] Send error: ${e.message}`);
  }
}

async function deleteStaleSubscriptions(token) {
  try {
    // Fetch all existing WebSocket-type subscriptions
    const res = await helixGet('/helix/eventsub/subscriptions?status=enabled', token);
    if (res.status !== 200) return;
    const subs = (res.body.data || []).filter(s => s.transport?.method === 'websocket');
    if (subs.length === 0) return;
    console.log(`[eventsub] Deleting ${subs.length} stale subscriptions...`);
    for (const sub of subs) {
      await helixDelete(`/helix/eventsub/subscriptions?id=${sub.id}`, token);
    }
    console.log('[eventsub] Stale subscriptions cleared');
  } catch (e) {
    console.log('[eventsub] Could not delete stale subs:', e.message);
  }
}

async function registerEventSubs(sessionId, token) {
  // Clean up stale subscriptions first to avoid hitting Twitch's transport limit
  await deleteStaleSubscriptions(token);

  const subs = eventsubSubscriptions(sessionId, BROADCASTER_ID);
  for (const sub of subs) {
    const res = await helixPost('/helix/eventsub/subscriptions', token, sub);
    if (res.status === 202) {
      console.log(`[eventsub] Subscribed: ${sub.type} ✓`);
    } else {
      console.log(`[eventsub] Failed ${sub.type}: ${JSON.stringify(res.body)}`);
    }
  }
}

function handleEventSubMessage(msg) {
  const type    = msg?.metadata?.message_type;
  const payload = msg?.payload;

  if (type === 'session_welcome') {
    const sessionId = payload.session.id;
    console.log(`[eventsub] Session: ${sessionId}`);
    getValidToken().then(token => {
      if (token) registerEventSubs(sessionId, token);
      else console.log('[eventsub] No token to register subscriptions');
    });
    return;
  }

  if (type === 'session_keepalive') return;

  if (type === 'notification') {
    const subType = payload?.subscription?.type;
    const event   = payload?.event;
    if (!subType || !event) return;
    console.log(`[eventsub] Event: ${subType}`);
    routeTwitchEvent(subType, event);
    return;
  }

  if (type === 'session_reconnect') {
    const reconnectUrl = payload?.session?.reconnect_url;
    console.log(`[eventsub] Reconnect requested: ${reconnectUrl}`);
    connectEventSub(reconnectUrl);
    return;
  }

  if (type === 'revocation') {
    console.log(`[eventsub] Subscription revoked: ${payload?.subscription?.type}`);
  }
}

function routeTwitchEvent(subType, event) {
  switch (subType) {
    case 'channel.follow':
      broadcastAlert({
        type:     'follow',
        username: event.user_name,
        _real:    true,
        goal:     getGoalForAlertType('follow'),
      });
      console.log(`[twitch] ${event.user_name} followed`);
      break;

    case 'channel.subscribe':
      broadcastAlert({
        type:     'sub',
        username: event.user_name,
        amount:   tierNum(event.tier),
        _real:    true,
        goal:     getGoalForAlertType('sub'),
      });
      console.log(`[twitch] ${event.user_name} subscribed (tier ${event.tier})`);
      break;

    case 'channel.subscription.message':
      broadcastAlert({
        type:     'resub',
        username: event.user_name,
        amount:   event.cumulative_months,
        message:  event.message?.text || null,
        _real:    true,
        goal:     getGoalForAlertType('sub'),
      });
      console.log(`[twitch] ${event.user_name} resubscribed (${event.cumulative_months} months)`);
      break;

    case 'channel.subscription.gift':
      broadcastAlert({
        type:     'giftsub',
        username: event.is_anonymous ? 'An Anonymous Gifter' : event.user_name,
        amount:   event.total,
        _real:    true,
        goal:     getGoalForAlertType('sub'),
      });
      console.log(`[twitch] ${event.user_name} gifted ${event.total} subs`);
      break;

    case 'channel.cheer':
      broadcastAlert({
        type:     'bits',
        username: event.is_anonymous ? 'An Anonymous Cheerer' : event.user_name,
        amount:   event.bits,
        message:  event.message || null,
        _real:    true,
      });
      console.log(`[twitch] ${event.user_name} cheered ${event.bits} bits`);
      break;

    case 'channel.raid':
      if (event.from_broadcaster_user_id === BROADCASTER_ID) {
        // Outgoing raid — we raided someone else
        broadcastAlert({
          type:     'raid_out',
          username: event.to_broadcaster_user_name,
          amount:   event.viewers,
          _real:    true,
        });
        console.log(`[twitch] Raided ${event.to_broadcaster_user_name} with ${event.viewers} viewers`);
      } else {
        // Incoming raid — someone raided us
        broadcastAlert({
          type:     'raid',
          username: event.from_broadcaster_user_name,
          amount:   event.viewers,
          _real:    true,
        });
        console.log(`[twitch] ${event.from_broadcaster_user_name} raided with ${event.viewers} viewers`);
      }
      break;

    case 'channel.goal.begin':
    case 'channel.goal.progress':
      activeChannelGoals[event.type] = {
        type:        event.type,
        description: event.description,
        current:     event.current_amount,
        target:      event.target_amount,
      };
      console.log(`[goal] Active: ${event.type} — ${event.current_amount}/${event.target_amount}`);
      break;

    case 'channel.goal.end':
      delete activeChannelGoals[event.type];
      console.log(`[goal] Ended: ${event.type}`);
      break;

    case 'channel.hype_train.begin':
    case 'channel.hype_train.progress':
    case 'channel.hype_train.end':
      broadcastHypeTrain({
        status:       subType === 'channel.hype_train.end' ? 'ended' :
                      subType === 'channel.hype_train.begin' ? 'started' : 'active',
        level:        event.level,
        total:        event.total,
        goal:         event.goal,
        progress:     event.progress,
        topContribs:  event.top_contributions || [],
        lastContrib:  event.last_contribution || null,
        expiresAt:    event.expires_at || null,
      });
      console.log(`[twitch] Hype Train: ${subType} — level ${event.level}`);
      break;

    case 'channel.poll.begin':
    case 'channel.poll.progress':
    case 'channel.poll.end':
      broadcastPoll({
        status:    subType === 'channel.poll.end' ? event.status : 'active',
        title:     event.title,
        choices:   event.choices,
        endsAt:    event.ends_at,
      });
      console.log(`[twitch] Poll: ${subType} — "${event.title}"`);
      break;

    case 'channel.prediction.begin':
    case 'channel.prediction.progress':
    case 'channel.prediction.lock':
    case 'channel.prediction.end':
      broadcastPrediction({
        status:   subType === 'channel.prediction.end' ? event.status :
                  subType === 'channel.prediction.lock' ? 'locked' : 'active',
        title:    event.title,
        outcomes: event.outcomes,
        locksAt:  event.locks_at,
        winningOutcomeId: event.winning_outcome_id || null,
      });
      console.log(`[twitch] Prediction: ${subType} — "${event.title}"`);
      break;

    case 'channel.chat.message': {
      const rawText = (event.message?.text || '').trim();
      const text    = rawText.toLowerCase();

      // Entry keyword — anyone, only while a giveaway is actively collecting.
      if (giveawayState.active && text === giveawayState.keyword.toLowerCase()) {
        const userId   = event.chatter_user_id;
        const username = event.chatter_user_name;
        if (giveawayState.entries.some(e => e.userId === userId)) break; // one entry per viewer
        giveawayState.entries.push({ userId, username });
        saveGiveawayState();
        broadcastGiveaway({ status: 'active', keyword: giveawayState.keyword, count: giveawayState.entries.length });
        console.log(`[giveaway] ${username} entered (${giveawayState.entries.length} total)`);
        break;
      }

      // Mod/broadcaster commands: !giveaway start|stop|close|draw|reset|remove <user>
      if (text.startsWith('!giveaway ')) {
        if (!isGiveawayMod(event)) {
          console.log(`[giveaway] Ignored !giveaway command from non-mod: ${event.chatter_user_name}`);
          break;
        }
        const parts  = rawText.slice('!giveaway '.length).trim().split(/\s+/);
        const action = (parts[0] || '').toLowerCase();
        const arg    = parts.slice(1).join(' ');

        if (action === 'start') {
          giveawayStart(arg);
        } else if (action === 'stop' || action === 'close') {
          giveawayCloseEntries();
        } else if (action === 'draw') {
          if (!giveawayDraw()) sendChatMessage("No entries yet — can't draw a winner.");
        } else if (action === 'reset') {
          giveawayReset();
        } else if (action === 'remove') {
          giveawayRemoveEntrant(arg);
        }
        console.log(`[giveaway] !giveaway ${action} by ${event.chatter_user_name}`);
        break;
      }
      break;
    }
  }
}

function broadcastHypeTrain(payload) {
  const data = `data: ${JSON.stringify({ type: 'hype_train', ...payload })}

`;
  for (const client of sseClients) {
    try { client.write(data); } catch (e) { sseClients.delete(client); }
  }
}

function broadcastPoll(payload) {
  const data = `data: ${JSON.stringify({ type: 'poll', ...payload })}

`;
  for (const client of sseClients) {
    try { client.write(data); } catch (e) { sseClients.delete(client); }
  }
}

function broadcastPrediction(payload) {
  const data = `data: ${JSON.stringify({ type: 'prediction', ...payload })}

`;
  for (const client of sseClients) {
    try { client.write(data); } catch (e) { sseClients.delete(client); }
  }
}

function tierNum(tier) {
  const t = parseInt(tier, 10);
  if (t >= 3000) return 3;
  if (t >= 2000) return 2;
  return 1;
}

let eventSubWs = null;
let esReconnectMs = 2000;

function connectEventSub(customUrl) {
  const wsUrl = customUrl || EVENTSUB_URL;
  console.log(`[eventsub] Connecting to ${wsUrl}`);

  if (eventSubWs) {
    // Strip listeners first — otherwise terminate() fires this socket's own
    // 'close' handler, which schedules a SECOND independent reconnect on top
    // of the new connection we're about to open, and every subsequent close
    // does the same, spiraling into a reconnect storm that gets us rate-limited.
    eventSubWs.removeAllListeners();
    try { eventSubWs.terminate(); } catch (e) {}
  }

  eventSubWs = new WebSocket(wsUrl);

  eventSubWs.on('open',    ()  => { esReconnectMs = 2000; console.log('[eventsub] Connected'); });
  eventSubWs.on('message', (d) => {
    try { handleEventSubMessage(JSON.parse(d.toString())); } catch (e) {}
  });
  eventSubWs.on('error',   (e) => console.log('[eventsub] Error:', e.message));
  eventSubWs.on('close',   (code) => {
    console.log(`[eventsub] Closed (${code}) — reconnecting in ${esReconnectMs}ms`);
    setTimeout(() => connectEventSub(), esReconnectMs);
    esReconnectMs = Math.min(esReconnectMs * 1.5, 60000);
  });
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS — allow the overlay and admin to fetch from any origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204); res.end(); return;
  }

  // ── GET /token ─────────────────────────────────────────────
  if (pathname === '/token') {
    const token = await getValidToken();
    if (token) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token, clientId: CLIENT_ID }));
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error:   'not_authorized',
        message: `Visit http://localhost:${PORT}/auth to authorize`,
      }));
    }
    return;
  }

  // ── GET /auth ──────────────────────────────────────────────
  if (pathname === '/auth') {
    const authUrl = new URL('https://id.twitch.tv/oauth2/authorize');
    authUrl.searchParams.set('client_id',     CLIENT_ID);
    authUrl.searchParams.set('redirect_uri',  REDIRECT_URI);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('scope',         SCOPES);
    authUrl.searchParams.set('force_verify',   'true');
    authUrl.searchParams.set('force_verify',  'true');
    res.writeHead(302, { Location: authUrl.toString() });
    res.end();
    return;
  }

  // ── GET /callback ──────────────────────────────────────────
  if (pathname === '/callback') {
    const code  = parsed.query.code;
    const error = parsed.query.error;
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end(`<h2>Authorization denied: ${error}</h2>`);
      return;
    }
    if (!code) {
      res.writeHead(400, { 'Content-Type': 'text/html' });
      res.end('<h2>No code received</h2>');
      return;
    }
    try {
      await exchangeCode(code);
      scheduleRefresh();
      connectEventSub();
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head>
        <style>
          body { background:#180C04; color:#F2E4CC; font-family:serif;
                 display:flex; align-items:center; justify-content:center; height:100vh; margin:0; }
          .box { text-align:center; border:1px solid #B87820; padding:40px 60px; border-radius:4px; }
          h2 { color:#E89010; font-size:22px; margin-bottom:12px; }
          p  { color:#C0986A; font-style:italic; }
        </style></head><body>
        <div class="box">
          <h2>♩ Authorized! ♩</h2>
          <p>Token saved. You can close this tab.</p>
          <p style="margin-top:16px;font-size:13px;">nom-token-broker is running on port ${PORT}</p>
        </div></body></html>`);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(`<h2>Token exchange failed: ${e.message}</h2>`);
    }
    return;
  }

  // ── GET /status ────────────────────────────────────────────
  if (pathname === '/status') {
    const token = await getValidToken();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      authorized:  !!token,
      expiresAt:   tokenStore.expiresAt ? new Date(tokenStore.expiresAt).toISOString() : null,
      hasRefresh:  !!tokenStore.refreshToken,
    }));
    return;
  }

  // ── POST /hype-train-test ─────────────────────────────────
  if (pathname === '/hype-train-test' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { level, status } = JSON.parse(body);
        const lvl = parseInt(level) || 1;
        broadcastHypeTrain({
          status:      status || 'active',
          level:       lvl,
          total:       lvl * 1000,
          goal:        (lvl + 1) * 1000,
          progress:    600,
          topContribs: [{ user_name: 'TestViewer', total: 500, type: 'bits' }],
          lastContrib: null,
          expiresAt:   new Date(Date.now() + 5 * 60000).toISOString(),
        });
        console.log(`[hype-train-test] Fired level ${lvl} (${status || 'active'})`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── POST /fire-alert ──────────────────────────────────────────
  if (pathname === '/fire-alert' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        broadcastAlert(payload);
        console.log(`[fire-alert] ${payload.type} — ${payload.username} (${sseClients.size} client(s))`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, clients: sseClients.size }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /alerts-stream (SSE) ───────────────────────────────
  if (pathname === '/alerts-stream') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    res.write('data: {"type":"connected"}\n\n');
    sseClients.add(res);
    console.log(`[sse] Client connected — total: ${sseClients.size}`);
    req.on('close', () => {
      sseClients.delete(res);
      console.log(`[sse] Client disconnected — total: ${sseClients.size}`);
    });
    return;
  }

  // ── GET /alerts-paused-state ──────────────────────────────
  if (pathname === '/alerts-paused-state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(alertsPausedState));
    return;
  }

  // ── POST /alerts-pause-toggle ─────────────────────────────
  if (pathname === '/alerts-pause-toggle' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { paused } = JSON.parse(body);
        alertsPausedState.paused = !!paused;
        const sse = `data: ${JSON.stringify({ type: 'alerts-paused', paused: alertsPausedState.paused })}\n\n`;
        for (const client of sseClients) {
          try { client.write(sse); } catch(e) { sseClients.delete(client); }
        }
        console.log(`[panic] Alerts ${alertsPausedState.paused ? 'PAUSED' : 'RESUMED'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, paused: alertsPausedState.paused }));
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── POST /social-scroller-toggle ──────────────────────────
  if (pathname === '/social-scroller-toggle' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { enabled } = JSON.parse(body);
        socialScrollerEnabled = !!enabled;
        fs.writeFileSync(path.join(__dirname, '.social-scroller-enabled.json'), JSON.stringify({ enabled: socialScrollerEnabled }));
        const sse = `data: ${JSON.stringify({ type: 'social-scroller-toggle', enabled: socialScrollerEnabled })}

`;
        for (const client of sseClients) {
          try { client.write(sse); } catch(e) { sseClients.delete(client); }
        }
        console.log(`[social] Scroller ${socialScrollerEnabled ? 'enabled' : 'disabled'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, enabled: socialScrollerEnabled }));
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /social-scroller-state ─────────────────────────────
  if (pathname === '/social-scroller-state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ enabled: socialScrollerEnabled }));
    return;
  }

  // ── GET /social-config ────────────────────────────────────
  if (pathname === '/social-config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(socialConfig));
    return;
  }

  // ── POST /social-config ────────────────────────────────
  if (pathname === '/social-config' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!Array.isArray(data)) throw new Error('Expected array');
        socialConfig = data;
        saveSocialConfig();
        const sse = `data: ${JSON.stringify({ type: 'social-config', config: socialConfig })}

`;
        for (const client of sseClients) {
          try { client.write(sse); } catch(e) { sseClients.delete(client); }
        }
        console.log(`[social] Config updated — ${socialConfig.length} entries`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch(e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /theme-state ──────────────────────────────────────
  if (pathname === '/theme-state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(themeState));
    return;
  }

  // ── POST /theme-set ────────────────────────────────────
  if (pathname === '/theme-set' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { theme } = JSON.parse(body);
        themeState.theme = theme;
        saveThemeState();
        const data = `data: ${JSON.stringify({ type: 'theme-switch', theme })}

`;
        for (const client of sseClients) {
          try { client.write(data); } catch (e) { sseClients.delete(client); }
        }
        console.log(`[theme] Switched to: ${theme}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, theme }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── POST /goal-toggle ─────────────────────────────────────
  if (pathname === '/goal-toggle' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { visible } = JSON.parse(body);
        goalState.visible = !!visible;
        saveGoalState();
        const data = `data: ${JSON.stringify({ type: 'goal-toggle', visible: !!visible })}

`;
        for (const client of sseClients) {
          try { client.write(data); } catch (e) { sseClients.delete(client); }
        }
        console.log(`[goal] visibility: ${visible ? 'shown' : 'hidden'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /goal-state ───────────────────────────────────────────
  if (pathname === '/goal-state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(goalState));
    return;
  }

  // ── POST /goal-add ─────────────────────────────────────────
  if (pathname === '/goal-add' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { type, amount, tier, note } = JSON.parse(body);
        addGoalRevenue(type, amount, tier);
        console.log(`[goal] Manual add: ${type} +${amount}${note ? ` (${note})` : ''}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, goal: goalState }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── POST /goal-remove ─────────────────────────────────────
  if (pathname === '/goal-remove' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { type, amount, tier, note } = JSON.parse(body);
        const n = parseFloat(amount) || 0;
        const t = parseInt(tier) || 1;
        if (type === 'bits')    goalState.bits = Math.max(0, goalState.bits - n / 100);
        if (type === 'sub')     goalState.subs = Math.max(0, goalState.subs - subToDollars(t));
        if (type === 'prime')   goalState.subs = Math.max(0, goalState.subs - 3.00);
        if (type === 'resub')   goalState.subs = Math.max(0, goalState.subs - subToDollars(t));
        if (type === 'giftsub') goalState.subs = Math.max(0, goalState.subs - subToDollars(t) * (n > 1 ? n : 1));
        if (type === 'tip')     goalState.tips = Math.max(0, goalState.tips - n);
        saveGoalState();
        broadcastGoal();
        console.log(`[goal] Manual remove: ${type} -${amount}${note ? ` (${note})` : ''}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, goal: goalState }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── POST /goal-reset ───────────────────────────────────────
  if (pathname === '/goal-reset' && req.method === 'POST') {
    goalState.bits = 0;
    goalState.subs = 0;
    goalState.tips = 0;
    saveGoalState();
    broadcastGoal();
    console.log('[goal] Goal reset');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── POST /goal-settings ────────────────────────────────────
  if (pathname === '/goal-settings' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { title, amount } = JSON.parse(body);
        if (title)  goalState.title  = title;
        if (amount) goalState.amount = parseFloat(amount);
        saveGoalState();
        broadcastGoal();
        console.log(`[goal] Settings updated — title:"${goalState.title}" amount:${goalState.amount}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, goal: goalState }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /health-data (proxies Fitbit stepcounter) ────────────
  if (pathname === '/health-data') {
    const FITBIT_URL = 'http://127.0.0.1:8082/get-activity-data';
    https.get ? null : null; // https already required
    const http2 = require('http');
    const fitbitReq = http2.get(FITBIT_URL, (fitbitRes) => {
      let data = '';
      fitbitRes.on('data', c => data += c);
      fitbitRes.on('end', () => {
        try {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(data);
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
      });
    });
    fitbitReq.on('error', (e) => {
      console.log(`[health-data] Stepcounter fetch failed: ${e.message}`);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not reach stepcounter', steps: 0, water: 0 }));
    });
    return;
  }

  // ── GET /health-settings ──────────────────────────────────
  if (pathname === '/health-settings') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(healthSettings));
    return;
  }

  // ── POST /health-toggle ────────────────────────────────────
  if (pathname === '/health-toggle' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { tracker, enabled } = JSON.parse(body);
        if (tracker === 'steps') healthSettings.steps = !!enabled;
        if (tracker === 'water') healthSettings.water = !!enabled;
        saveHealthSettings();
        // Broadcast to all SSE clients so overlay updates instantly
        const data = `data: ${JSON.stringify({ type: 'health-toggle', tracker, enabled: !!enabled })}

`;
        for (const client of sseClients) {
          try { client.write(data); } catch (e) { sseClients.delete(client); }
        }
        console.log(`[health] ${tracker} tracker ${enabled ? 'enabled' : 'disabled'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, health: healthSettings }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── GET /giveaway-state ─────────────────────────────────────
  if (pathname === '/giveaway-state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...giveawayState, count: giveawayState.entries.length }));
    return;
  }

  // ── POST /giveaway-start ────────────────────────────────────
  if (pathname === '/giveaway-start' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { keyword } = JSON.parse(body || '{}');
        giveawayStart(keyword);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, giveaway: giveawayState }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── POST /giveaway-stop ─────────────────────────────────────
  if (pathname === '/giveaway-stop' && req.method === 'POST') {
    giveawayCloseEntries();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, giveaway: giveawayState }));
    return;
  }

  // ── POST /giveaway-draw ─────────────────────────────────────
  if (pathname === '/giveaway-draw' && req.method === 'POST') {
    const winner = giveawayDraw();
    if (!winner) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No entries to draw from' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, winner }));
    return;
  }

  // ── POST /giveaway-reset ────────────────────────────────────
  if (pathname === '/giveaway-reset' && req.method === 'POST') {
    giveawayReset();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── GET /discord-webhook-state ──────────────────────────────
  if (pathname === '/discord-webhook-state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ url: integrations.discordWebhookUrl || '' }));
    return;
  }

  // ── POST /discord-webhook-set ───────────────────────────────
  if (pathname === '/discord-webhook-set' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { url: webhookUrl } = JSON.parse(body || '{}');
        integrations.discordWebhookUrl = (webhookUrl || '').trim();
        saveIntegrations();
        console.log(`[discord] Webhook ${integrations.discordWebhookUrl ? 'set' : 'cleared'}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Static files ───────────────────────────────────────────
  // Serve nom-alerts.html, config.js, Assets/, etc. from the same directory
  const MIME = {
    '.html': 'text/html',
    '.js':   'application/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.gif':  'image/gif',
    '.webp': 'image/webp',
    '.mp3':  'audio/mpeg',
    '.wav':  'audio/wav',
    '.ogg':  'audio/ogg',
    '.ico':  'image/x-icon',
  };

  // Sanitize path to prevent directory traversal
  const safePath = path.normalize(pathname).replace(/^(\.\.|\/)/, '');
  const filePath = path.join(__dirname, safePath === '' || safePath === '/' ? 'nom-alerts.html' : safePath);

  // Only serve files inside __dirname
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext      = path.extname(filePath).toLowerCase();
    const mimeType = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type':  mimeType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma':         'no-cache',
      'Expires':        '0',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

// ─── Start ───────────────────────────────────────────────────────────────────
loadTokens();
loadGoalState();
loadHealthSettings();
loadThemeState();
loadSocialConfig();
loadGiveawayState();
loadIntegrations();
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[nom-token-broker] Running on http://${SERVER_IP}:${PORT}`);
  if (tokenStore.refreshToken) {
    scheduleRefresh();
    connectEventSub();
  } else {
    console.log(`[nom-token-broker] Not authorized yet — visit http://localhost:${PORT}/auth on the server`);
  }
});
