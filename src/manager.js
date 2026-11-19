import { ActivityType, ChannelType, PermissionFlagsBits } from 'discord.js';
import { GuildRadio, resolveStation } from './radio.js';
import { trackEmbed } from './embeds.js';
import { log } from './log.js';

/** Owns every server's radio and the cross-cutting behaviour around it. */
export class RadioManager {
  constructor(client, config, store) {
    this.client = client;
    this.config = config;
    this.store = store;
    this.radios = new Map();
    this.aloneTimers = new Map();
    this.lastTrack = null;
    this.presenceTimer = null;
    this.lastPresenceKey = null;
    this.shuttingDown = false;
  }

  get(guildId) {
    let radio = this.radios.get(guildId);
    if (!radio) {
      radio = new GuildRadio(guildId, this.config);
      radio.volume = this.store.get(guildId).volume;
      radio.on('track', (title) => this.#onTrack(radio, title));
      radio.on('stopped', (reason) => this.#onStopped(radio, reason));
      this.radios.set(guildId, radio);
    }
    return radio;
  }

  peek(guildId) {
    return this.radios.get(guildId);
  }

  /** Joins `channel` and starts `station` (falls back to the server's saved station). */
  async start(channel, station) {
    const settings = this.store.get(channel.guild.id);
    station ??= resolveStation(this.config, settings.station);
    this.#checkVoicePermissions(channel);
    const radio = this.get(channel.guild.id);
    radio.setVolume(settings.volume);
    await radio.connect(channel);
    await radio.play(station);
    this.store.set(channel.guild.id, { station: station.key, lastChannelId: channel.id });
    this.refreshAloneTimer(channel.guild);
    this.schedulePresence();
    return radio;
  }

  stop(guildId, reason = 'stopped') {
    this.radios.get(guildId)?.stop(reason);
  }

  shutdown() {
    this.shuttingDown = true;
    for (const radio of this.radios.values()) radio.stop('shutdown');
  }

  /** Rejoins 24/7 servers and config.autoJoin channels after the bot starts. */
  async restoreSessions() {
    const targets = new Map();
    for (const entry of this.config.autoJoin) {
      targets.set(entry.guildId, { channelId: entry.channelId, station: entry.station });
    }
    for (const guildId of this.store.guildIds()) {
      const s = this.store.get(guildId);
      if (s.stay247 && s.lastChannelId && !targets.has(guildId)) {
        targets.set(guildId, { channelId: s.lastChannelId, station: s.station });
      }
    }

    for (const [guildId, target] of targets) {
      try {
        const guild = await this.client.guilds.fetch(guildId);
        const channel = await guild.channels.fetch(target.channelId);
        if (!channel?.isVoiceBased()) throw new Error(`channel ${target.channelId} is not a voice channel`);
        const station = resolveStation(this.config, target.station ?? this.store.get(guildId).station);
        await this.start(channel, station);
        log.info(`[${guildId}] auto-joined #${channel.name} with ${station.name}`);
      } catch (err) {
        log.warn(`[${guildId}] auto-join failed: ${err.message}`);
      }
    }
  }

  /** Leaves after a grace period when no humans are left listening (unless 24/7 is on). */
  refreshAloneTimer(guild) {
    const radio = this.radios.get(guild.id);
    const delay = this.config.leaveWhenAloneAfterSeconds;
    const clear = () => {
      clearTimeout(this.aloneTimers.get(guild.id));
      this.aloneTimers.delete(guild.id);
    };
    if (!radio?.isActive || delay === 0 || this.store.get(guild.id).stay247) return clear();

    const channel = guild.channels.cache.get(radio.channelId);
    const listeners = channel?.members.filter((m) => !m.user.bot).size ?? 0;
    if (listeners > 0) return clear();
    if (this.aloneTimers.has(guild.id)) return;

    this.aloneTimers.set(
      guild.id,
      setTimeout(() => {
        this.aloneTimers.delete(guild.id);
        const ch = guild.channels.cache.get(radio.channelId);
        if (radio.isActive && (ch?.members.filter((m) => !m.user.bot).size ?? 0) === 0 && !this.store.get(guild.id).stay247) {
          log.info(`[${guild.id}] nobody listening for ${delay}s - leaving`);
          radio.stop('alone');
        }
      }, delay * 1000),
    );
  }

  schedulePresence() {
    if (this.config.presence === 'off' || this.presenceTimer) return;
    // Discord rate-limits presence updates, so batch them.
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null;
      this.#updatePresence();
    }, 5_000);
  }

  #updatePresence() {
    const user = this.client.user;
    if (!user) return;
    const active = [...this.radios.values()].filter((r) => r.isActive);
    let name;
    if (active.length === 0) {
      name = `${this.config.stations[this.config.defaultStation].name} | /play`;
    } else if (this.config.presence === 'track' && this.lastTrack && this.lastTrack.radio.isActive) {
      name = this.lastTrack.title;
    } else {
      const names = [...new Set(active.map((r) => r.station.name))];
      name = names.length === 1 ? names[0] : `radio in ${active.length} servers`;
    }
    name = name.slice(0, 128);
    if (name === this.lastPresenceKey) return;
    this.lastPresenceKey = name;
    user.setPresence({ activities: [{ name, type: ActivityType.Listening }], status: 'online' });
  }

  async #onTrack(radio, title) {
    this.lastTrack = { radio, title };
    this.schedulePresence();
    const settings = this.store.get(radio.guildId);
    if (!this.config.announceTrackChanges || !settings.announceChannelId) return;
    try {
      const channel = await this.client.channels.fetch(settings.announceChannelId);
      if (channel?.isTextBased()) {
        await channel.send({ embeds: [trackEmbed(this.config, radio)] });
      }
    } catch (err) {
      log.warn(`[${radio.guildId}] could not announce track: ${err.message}`);
    }
  }

  #onStopped(radio, reason) {
    log.info(`[${radio.guildId}] radio stopped (${reason})`);
    clearTimeout(this.aloneTimers.get(radio.guildId));
    this.aloneTimers.delete(radio.guildId);
    // Forget the channel unless the bot itself is shutting down, so a kicked bot doesn't come back on restart.
    if (!this.shuttingDown && reason !== 'shutdown') this.store.set(radio.guildId, { lastChannelId: null });
    if (this.lastTrack?.radio === radio) this.lastTrack = null;
    this.schedulePresence();
  }

  #checkVoicePermissions(channel) {
    const me = channel.guild.members.me;
    const perms = me ? channel.permissionsFor(me) : null;
    const missing = [];
    if (!perms?.has(PermissionFlagsBits.ViewChannel)) missing.push('View Channel');
    if (!perms?.has(PermissionFlagsBits.Connect)) missing.push('Connect');
    if (channel.type !== ChannelType.GuildStageVoice && !perms?.has(PermissionFlagsBits.Speak)) missing.push('Speak');
    if (missing.length) throw new Error(`I'm missing these permissions in ${channel}: ${missing.join(', ')}`);
    if (channel.full && !perms.has(PermissionFlagsBits.MoveMembers)) throw new Error(`${channel} is full.`);
  }
}
