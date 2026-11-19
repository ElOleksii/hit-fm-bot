import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { resolveStation } from './radio.js';
import { nowPlayingEmbed, settingsEmbed, stationsEmbed } from './embeds.js';
import { log } from './log.js';

const VOICE_TYPES = [ChannelType.GuildVoice, ChannelType.GuildStageVoice];

export function buildCommands(config) {
  const stationOption = (o, required) =>
    o.setName('station').setDescription('Station to play').setRequired(required).setAutocomplete(true);

  const play = new SlashCommandBuilder()
    .setName('play')
    .setDescription('Start the radio in your voice channel')
    .addStringOption((o) =>
      stationOption(o, false).setDescription(config.allowCustomUrls ? 'Station name or a stream URL' : 'Station to play'),
    )
    .addChannelOption((o) =>
      o.setName('channel').setDescription('Voice channel to join (defaults to yours)').addChannelTypes(...VOICE_TYPES),
    );

  const station = new SlashCommandBuilder()
    .setName('station')
    .setDescription('Switch to another station')
    .addStringOption((o) => stationOption(o, true));

  const stations = new SlashCommandBuilder().setName('stations').setDescription('List available stations');
  const stop = new SlashCommandBuilder().setName('stop').setDescription('Stop the radio and leave the voice channel');
  const nowplaying = new SlashCommandBuilder().setName('nowplaying').setDescription("Show what's on air right now");

  const volume = new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Show or change the volume')
    .addIntegerOption((o) =>
      o.setName('level').setDescription(`Volume from 0 to ${config.maxVolume}`).setMinValue(0).setMaxValue(config.maxVolume),
    );

  const settings = new SlashCommandBuilder()
    .setName('settings')
    .setDescription('Configure the radio for this server')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setContexts(InteractionContextType.Guild)
    .addSubcommand((s) => s.setName('show').setDescription('Show current settings'))
    .addSubcommand((s) =>
      s.setName('default-station').setDescription('Station used when /play has no station').addStringOption((o) => stationOption(o, true)),
    )
    .addSubcommand((s) =>
      s
        .setName('dj-role')
        .setDescription('Only members with this role can control the radio (leave empty to allow everyone)')
        .addRoleOption((o) => o.setName('role').setDescription('DJ role')),
    )
    .addSubcommand((s) =>
      s
        .setName('announce-channel')
        .setDescription('Post each new song to a text channel (leave empty to turn off)')
        .addChannelOption((o) =>
          o.setName('channel').setDescription('Text channel').addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
        ),
    )
    .addSubcommand((s) =>
      s
        .setName('24-7')
        .setDescription('Stay in the channel even when nobody is listening, and rejoin after restarts')
        .addBooleanOption((o) => o.setName('enabled').setDescription('Turn 24/7 mode on or off').setRequired(true)),
    )
    .addSubcommand((s) => s.setName('reset').setDescription('Reset this server to the defaults from config.json'));

  return [play, station, stations, stop, nowplaying, volume, settings].map((c) => {
    if (c.name !== 'settings') c.setContexts(InteractionContextType.Guild);
    return c.toJSON();
  });
}

export function createInteractionHandler({ config, store, manager }) {
  const reply = (interaction, content, extra = {}) => {
    const payload = typeof content === 'string' ? { content, ...extra } : { ...content, ...extra };
    if (!interaction.deferred && !interaction.replied) return interaction.reply(payload);
    delete payload.flags; // visibility is fixed once a reply is deferred
    return interaction.editReply(payload);
  };
  const fail = (interaction, message) => reply(interaction, `❌ ${message}`, { flags: MessageFlags.Ephemeral });

  const isManager = (member) => member.permissions.has(PermissionFlagsBits.ManageGuild);

  /** DJ role + "be in the same channel" checks for commands that change playback. */
  function controlError(interaction) {
    const member = interaction.member;
    if (isManager(member)) return null;
    const { djRoleId } = store.get(interaction.guildId);
    if (djRoleId && !member.roles.cache.has(djRoleId)) return `You need the <@&${djRoleId}> role to control the radio.`;
    const radio = manager.peek(interaction.guildId);
    if (radio?.isActive && member.voice.channelId !== radio.channelId) {
      return `Join <#${radio.channelId}> to control the radio.`;
    }
    return null;
  }

  const handlers = {
    async play(interaction) {
      const denied = controlError(interaction);
      if (denied) return fail(interaction, denied);
      const settings = store.get(interaction.guildId);
      const requested = interaction.options.getString('station');
      const station = resolveStation(config, requested ?? settings.station);
      if (!station) return fail(interaction, `Unknown station \`${requested}\`. See \`/stations\`.`);
      const channel = interaction.options.getChannel('channel') ?? interaction.member.voice.channel;
      if (!channel) return fail(interaction, 'Join a voice channel first, or pick one with the `channel` option.');

      await interaction.deferReply();
      const radio = await manager.start(channel, station);
      return reply(interaction, { content: `📻 Tuned in to **${station.name}** in ${channel}`, embeds: [nowPlayingEmbed(config, radio)] });
    },

    async station(interaction) {
      const denied = controlError(interaction);
      if (denied) return fail(interaction, denied);
      const value = interaction.options.getString('station', true);
      const station = resolveStation(config, value);
      if (!station) return fail(interaction, `Unknown station \`${value}\`. See \`/stations\`.`);
      const radio = manager.peek(interaction.guildId);
      store.set(interaction.guildId, { station: station.key });
      if (!radio?.isActive) {
        return reply(interaction, `📻 **${station.name}** selected. Use \`/play\` to start listening.`);
      }
      await interaction.deferReply();
      await radio.play(station);
      return reply(interaction, { content: `🔀 Switched to **${station.name}**`, embeds: [nowPlayingEmbed(config, radio)] });
    },

    async stations(interaction) {
      const radio = manager.peek(interaction.guildId);
      const current = radio?.isActive ? radio.station.key : store.get(interaction.guildId).station;
      return reply(interaction, { embeds: [stationsEmbed(config, current)] });
    },

    async stop(interaction) {
      const radio = manager.peek(interaction.guildId);
      if (!radio?.isActive) return fail(interaction, "The radio isn't playing.");
      const denied = controlError(interaction);
      if (denied) return fail(interaction, denied);
      manager.stop(interaction.guildId, 'stopped');
      return reply(interaction, '⏹️ Radio stopped. See you!');
    },

    async nowplaying(interaction) {
      const radio = manager.peek(interaction.guildId) ?? { isActive: false, station: null };
      return reply(interaction, { embeds: [nowPlayingEmbed(config, radio)] });
    },

    async volume(interaction) {
      const level = interaction.options.getInteger('level');
      const radio = manager.peek(interaction.guildId);
      if (level === null) {
        return reply(interaction, `🔊 Volume is **${store.get(interaction.guildId).volume}%**`);
      }
      const denied = controlError(interaction);
      if (denied) return fail(interaction, denied);
      store.set(interaction.guildId, { volume: level });
      radio?.setVolume(level);
      const icon = level === 0 ? '🔇' : level < 50 ? '🔈' : level < 100 ? '🔉' : '🔊';
      return reply(interaction, `${icon} Volume set to **${level}%**`);
    },

    async settings(interaction) {
      if (!isManager(interaction.member)) return fail(interaction, 'You need the **Manage Server** permission.');
      const guildId = interaction.guildId;
      const sub = interaction.options.getSubcommand();
      const ephemeral = { flags: MessageFlags.Ephemeral };

      if (sub === 'default-station') {
        const value = interaction.options.getString('station', true);
        const station = resolveStation(config, value);
        if (!station) return fail(interaction, `Unknown station \`${value}\`.`);
        store.set(guildId, { station: station.key });
      } else if (sub === 'dj-role') {
        const role = interaction.options.getRole('role');
        store.set(guildId, { djRoleId: role?.id ?? null });
      } else if (sub === 'announce-channel') {
        const channel = interaction.options.getChannel('channel');
        if (channel) {
          const perms = channel.permissionsFor(interaction.guild.members.me);
          if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
            return fail(interaction, `I need View Channel, Send Messages and Embed Links in ${channel}.`);
          }
        }
        store.set(guildId, { announceChannelId: channel?.id ?? null });
      } else if (sub === '24-7') {
        const enabled = interaction.options.getBoolean('enabled', true);
        const radio = manager.peek(guildId);
        store.set(guildId, { stay247: enabled, ...(radio?.isActive ? { lastChannelId: radio.channelId } : {}) });
        manager.refreshAloneTimer(interaction.guild);
      } else if (sub === 'reset') {
        store.reset(guildId);
        manager.peek(guildId)?.setVolume(store.get(guildId).volume);
        manager.refreshAloneTimer(interaction.guild);
      }
      return reply(interaction, { embeds: [settingsEmbed(config, store.get(guildId))] }, ephemeral);
    },
  };

  async function autocomplete(interaction) {
    const query = interaction.options.getFocused().toLowerCase();
    const choices = Object.values(config.stations)
      .filter((s) => !query || s.key.toLowerCase().includes(query) || s.name.toLowerCase().includes(query))
      .slice(0, 25)
      .map((s) => ({ name: s.name.slice(0, 100), value: s.key }));
    await interaction.respond(choices).catch(() => {});
  }

  return async function onInteraction(interaction) {
    if (!interaction.inGuild()) return;
    if (interaction.isAutocomplete()) return autocomplete(interaction);
    if (!interaction.isChatInputCommand()) return;
    const handler = handlers[interaction.commandName];
    if (!handler) return;
    try {
      await handler(interaction);
    } catch (err) {
      log.warn(`[${interaction.guildId}] /${interaction.commandName} failed: ${err.message}`);
      await fail(interaction, err.message || 'Something went wrong.').catch(() => {});
    }
  };
}
