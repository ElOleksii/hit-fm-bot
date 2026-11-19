import fs from 'node:fs';
import path from 'node:path';

/** Small JSON-file store for per-server settings that admins change at runtime. */
export class GuildStore {
  constructor(config) {
    this.config = config;
    this.file = config.dataFile;
    this.data = {};
    if (fs.existsSync(this.file)) {
      try {
        this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')) ?? {};
      } catch (err) {
        console.warn(`[store] could not read ${this.file} (${err.message}); starting fresh`);
      }
    }
  }

  defaults() {
    return {
      station: this.config.defaultStation,
      volume: this.config.defaultVolume,
      djRoleId: null,
      announceChannelId: null,
      stay247: this.config.stayInChannelByDefault,
      lastChannelId: null,
    };
  }

  get(guildId) {
    const merged = { ...this.defaults(), ...this.data[guildId] };
    // Guard against stations that were removed from config.json after being saved.
    if (!this.config.stations[merged.station] && !this.#isCustomUrl(merged.station)) {
      merged.station = this.config.defaultStation;
    }
    merged.volume = Math.min(this.config.maxVolume, Math.max(0, merged.volume));
    return merged;
  }

  set(guildId, patch) {
    this.data[guildId] = { ...this.data[guildId], ...patch };
    this.#save();
    return this.get(guildId);
  }

  reset(guildId) {
    const { lastChannelId } = this.data[guildId] ?? {};
    this.data[guildId] = lastChannelId ? { lastChannelId } : {};
    this.#save();
    return this.get(guildId);
  }

  guildIds() {
    return Object.keys(this.data);
  }

  #isCustomUrl(value) {
    return this.config.allowCustomUrls && /^https?:\/\//i.test(value ?? '');
  }

  #save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}
