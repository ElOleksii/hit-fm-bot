import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  defaultStation: 'hitfm',
  stations: {
    hitfm: { name: 'Hit FM', url: 'https://online.hitfm.ua/HitFM' },
  },
  allowCustomUrls: false,
  defaultVolume: 80,
  maxVolume: 150,
  stayInChannelByDefault: false,
  leaveWhenAloneAfterSeconds: 120,
  announceTrackChanges: true,
  presence: 'track',
  embedColor: '#E30613',
  commandGuildId: '',
  dataFile: 'data/guilds.json',
  autoJoin: [],
  stream: {
    ffmpegPath: '',
    userAgent: 'HitFM-Discord-Bot/1.0',
    timeoutSeconds: 15,
    reconnectDelaysSeconds: [1, 2, 5, 10, 30],
    metadataEncoding: 'auto',
  },
};

const PRESENCE_MODES = ['track', 'station', 'off'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    if (key.startsWith('$') || key.startsWith('_')) continue; // allow "_comment" keys
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function fail(message) {
  throw new Error(`Invalid config: ${message}`);
}

export function loadConfig() {
  const file = path.resolve(ROOT, process.env.CONFIG_PATH || 'config.json');
  let user = {};
  if (fs.existsSync(file)) {
    try {
      user = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      fail(`could not parse ${file}: ${err.message}`);
    }
  } else {
    console.warn(`[config] ${file} not found - using built-in defaults. Copy config.example.json to config.json to customise.`);
  }

  const cfg = deepMerge(DEFAULTS, user);
  // A user-supplied station list replaces the defaults instead of merging with them.
  if (isPlainObject(user.stations)) cfg.stations = user.stations;

  // Stations
  const stations = {};
  for (const [key, raw] of Object.entries(cfg.stations)) {
    if (key.startsWith('_')) continue;
    const s = typeof raw === 'string' ? { url: raw } : raw;
    if (!isPlainObject(s) || typeof s.url !== 'string') fail(`station "${key}" needs a "url"`);
    if (!/^https?:\/\//i.test(s.url)) fail(`station "${key}" url must start with http:// or https://`);
    if (key.length > 100) fail(`station key "${key}" is longer than 100 characters`);
    stations[key] = {
      key,
      name: s.name || key,
      url: s.url,
      description: s.description || '',
      logo: s.logo || '',
      website: s.website || '',
    };
  }
  if (Object.keys(stations).length === 0) fail('at least one station is required');
  cfg.stations = stations;
  if (!stations[cfg.defaultStation]) fail(`defaultStation "${cfg.defaultStation}" is not in "stations"`);

  // Numbers
  cfg.maxVolume = clampInt(cfg.maxVolume, 1, 200, 'maxVolume');
  cfg.defaultVolume = clampInt(cfg.defaultVolume, 0, cfg.maxVolume, 'defaultVolume');
  cfg.leaveWhenAloneAfterSeconds = clampInt(cfg.leaveWhenAloneAfterSeconds, 0, 86_400, 'leaveWhenAloneAfterSeconds');
  cfg.stream.timeoutSeconds = clampInt(cfg.stream.timeoutSeconds, 3, 300, 'stream.timeoutSeconds');
  const delays = cfg.stream.reconnectDelaysSeconds;
  if (!Array.isArray(delays) || delays.length === 0 || delays.some((d) => !(Number(d) >= 0))) {
    fail('stream.reconnectDelaysSeconds must be a non-empty array of numbers');
  }

  if (!PRESENCE_MODES.includes(cfg.presence)) fail(`presence must be one of ${PRESENCE_MODES.join(', ')}`);

  const color = String(cfg.embedColor).replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(color)) fail('embedColor must be a hex colour like "#E30613"');
  cfg.embedColorInt = Number.parseInt(color, 16);

  if (!Array.isArray(cfg.autoJoin)) fail('autoJoin must be an array');
  // Entries left blank (like the template in config.example.json) are ignored.
  cfg.autoJoin = cfg.autoJoin.filter((e) => e && (e.guildId || e.channelId));
  for (const entry of cfg.autoJoin) {
    if (!entry?.guildId || !entry?.channelId) fail('every autoJoin entry needs "guildId" and "channelId"');
    if (entry.station && !stations[entry.station]) fail(`autoJoin station "${entry.station}" is not in "stations"`);
  }

  cfg.dataFile = path.resolve(ROOT, cfg.dataFile);
  cfg.stream.ffmpegPath = process.env.FFMPEG_PATH || cfg.stream.ffmpegPath || '';
  return cfg;
}

function clampInt(value, min, max, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`${name} must be a number`);
  return Math.min(max, Math.max(min, Math.round(n)));
}
