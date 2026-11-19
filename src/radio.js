import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { pipeline } from 'node:stream';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import { ChannelType } from 'discord.js';
import ffmpegStatic from 'ffmpeg-static';
import { openIcyStream } from './icy.js';
import { log } from './log.js';

/** Turns a station key (or, if allowed, a raw URL) into a station object. */
export function resolveStation(config, value) {
  if (!value) return config.stations[config.defaultStation];
  if (config.stations[value]) return config.stations[value];
  const byName = Object.values(config.stations).find((s) => s.name.toLowerCase() === String(value).toLowerCase());
  if (byName) return byName;
  if (config.allowCustomUrls && /^https?:\/\//i.test(value)) {
    let host = value;
    try {
      host = new URL(value).hostname;
    } catch {
      return null;
    }
    return { key: value, name: host, url: value, description: 'Custom stream', logo: '', website: '' };
  }
  return null;
}

/** One live radio player per Discord server. */
export class GuildRadio extends EventEmitter {
  constructor(guildId, config) {
    super();
    this.guildId = guildId;
    this.config = config;
    this.station = null;
    this.volume = config.defaultVolume;
    this.active = false;
    this.connection = null;
    this.resource = null;
    this.pipe = null;
    this.generation = 0;
    this.starting = false;
    this.retryAttempt = 0;
    this.retryTimer = null;
    this.steadyTimer = null;
    this.nowPlaying = null; // { title, since }
    this.startedAt = null;

    this.player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    this.player.on('error', (err) => {
      // Errors from a pipeline we're deliberately tearing down are expected noise.
      if (this.active && !this.starting) log.warn(`[${guildId}] player error: ${err.message}`);
    });
    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status === AudioPlayerStatus.Playing && oldState.status !== AudioPlayerStatus.Playing) {
        clearTimeout(this.steadyTimer);
        // Only reset the back-off once the stream has proven stable.
        this.steadyTimer = setTimeout(() => (this.retryAttempt = 0), 30_000);
      }
      if (newState.status === AudioPlayerStatus.Idle) {
        clearTimeout(this.steadyTimer);
        if (this.active && !this.starting) this.#scheduleRetry('stream ended');
      }
    });
  }

  get channelId() {
    return this.connection?.joinConfig.channelId ?? null;
  }

  get isActive() {
    return this.active && this.connection !== null;
  }

  /** Joins (or moves to) a voice or stage channel and waits until the connection is ready. */
  async connect(channel) {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    if (connection !== this.connection) {
      this.connection = connection;
      connection.subscribe(this.player);
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          // Moved between channels or a short network hiccup - wait for it to recover.
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
        }
      });
      connection.on(VoiceConnectionStatus.Destroyed, () => {
        if (this.connection === connection) {
          this.connection = null;
          this.stop('disconnected');
        }
      });
      connection.on('error', (err) => log.warn(`[${this.guildId}] voice connection error: ${err.message}`));
    }

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
      throw new Error('Could not connect to the voice channel within 20 seconds.');
    }

    if (channel.type === ChannelType.GuildStageVoice) {
      // Become a speaker on stage channels (needs the "Mute Members" permission or a moderator).
      await channel.guild.members.me?.voice.setSuppressed(false).catch(() => {
        log.warn(`[${this.guildId}] could not become a stage speaker - grant the bot "Mute Members" or invite it to speak`);
      });
    }
  }

  /** Starts (or switches to) a station. Resolves once the first stream connection is attempted. */
  async play(station) {
    const switching = this.active && this.station?.url !== station.url;
    const alreadyPlaying = this.active && !switching && this.player.state.status === AudioPlayerStatus.Playing;
    this.station = station;
    this.active = true;
    if (alreadyPlaying) return;
    this.nowPlaying = null;
    this.startedAt = Date.now();
    this.retryAttempt = 0;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.#startStream();
  }

  setVolume(percent) {
    this.volume = percent;
    this.resource?.volume?.setVolumeLogarithmic(percent / 100);
  }

  /** Stops audio and leaves the voice channel. */
  stop(reason = 'stopped') {
    const wasActive = this.active || this.connection !== null;
    this.active = false;
    this.generation++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.steadyTimer);
    this.retryTimer = null;
    this.#killPipeline();
    this.player.stop(true);
    this.resource = null;
    this.nowPlaying = null;
    this.startedAt = null;
    const connection = this.connection;
    this.connection = null;
    if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    if (wasActive) this.emit('stopped', reason);
  }

  async #startStream() {
    const gen = ++this.generation;
    const station = this.station;
    this.starting = true;
    this.#killPipeline();

    try {
      const icy = await openIcyStream(station.url, {
        userAgent: this.config.stream.userAgent,
        timeoutMs: this.config.stream.timeoutSeconds * 1000,
        metadataEncoding: this.config.stream.metadataEncoding,
        onMetadata: (title) => {
          if (gen === this.generation) this.#onTitle(title);
        },
      });

      if (gen !== this.generation || !this.active) {
        icy.close();
        return;
      }

      const ffmpeg = spawn(
        this.config.stream.ffmpegPath || ffmpegStatic || 'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error',
          '-probesize', '65536', '-analyzeduration', '500000',
          '-i', 'pipe:0',
          '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2',
          'pipe:1',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      );
      ffmpeg.stderr.on('data', (d) => log.debug(`[${this.guildId}] ffmpeg: ${String(d).trim()}`));
      ffmpeg.once('error', (err) => {
        if (gen !== this.generation) return;
        log.error(`[${this.guildId}] failed to start ffmpeg: ${err.message}. Set stream.ffmpegPath or FFMPEG_PATH.`);
        this.emit('fatal', new Error('ffmpeg could not be started on the host.'));
        this.stop('ffmpeg missing');
      });

      pipeline(icy.stream, ffmpeg.stdin, (err) => {
        const benign = ['EPIPE', 'ECANCELED', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_STREAM_DESTROYED'];
        if (err && gen === this.generation && !benign.includes(err.code)) {
          log.warn(`[${this.guildId}] stream error (${station.name}): ${err.message}`);
        }
      });

      this.pipe = { icy, ffmpeg };
      const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw, inlineVolume: true });
      resource.volume.setVolumeLogarithmic(this.volume / 100);
      this.resource = resource;
      this.player.play(resource);
      log.info(`[${this.guildId}] streaming ${station.name} (${station.url})`);

      // Watchdog: if audio never starts flowing, try again.
      entersState(this.player, AudioPlayerStatus.Playing, 20_000).catch(() => {
        if (gen === this.generation && this.active) this.#scheduleRetry('no audio after 20s');
      });
    } catch (err) {
      if (gen === this.generation && this.active) {
        log.warn(`[${this.guildId}] could not open ${station.name}: ${err.message}`);
        this.starting = false;
        this.#scheduleRetry(err.message);
      }
    } finally {
      if (gen === this.generation) this.starting = false;
    }
  }

  #scheduleRetry(reason) {
    if (!this.active || this.retryTimer) return;
    const delays = this.config.stream.reconnectDelaysSeconds;
    const delay = Number(delays[Math.min(this.retryAttempt, delays.length - 1)]) * 1000;
    this.retryAttempt++;
    log.info(`[${this.guildId}] reconnecting in ${delay / 1000}s (${reason})`);
    this.emit('reconnecting', { reason, attempt: this.retryAttempt });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.active) this.#startStream();
    }, delay);
  }

  #killPipeline() {
    if (!this.pipe) return;
    const { icy, ffmpeg } = this.pipe;
    this.pipe = null;
    try {
      icy.close();
    } catch {}
    try {
      ffmpeg.stdin.destroy();
      ffmpeg.stdout.destroy();
      ffmpeg.kill();
    } catch {}
  }

  #onTitle(title) {
    const clean = title || null;
    if (clean === (this.nowPlaying?.title ?? null)) return;
    this.nowPlaying = clean ? { title: clean, since: Date.now() } : null;
    if (clean) this.emit('track', clean);
  }
}
