import { EmbedBuilder } from 'discord.js';

function splitTitle(title) {
  const idx = title.indexOf(' - ');
  return idx > 0 ? { artist: title.slice(0, idx).trim(), song: title.slice(idx + 3).trim() } : { artist: null, song: title };
}

function base(config, station) {
  const embed = new EmbedBuilder().setColor(config.embedColorInt);
  if (station) {
    embed.setAuthor({ name: station.name, url: station.website || undefined, iconURL: station.logo || undefined });
  }
  return embed;
}

export function trackEmbed(config, radio) {
  const { artist, song } = splitTitle(radio.nowPlaying?.title ?? '');
  const embed = base(config, radio.station).setTitle(`🎵 ${song}`.slice(0, 256));
  if (artist) embed.setDescription(artist.slice(0, 4096));
  return embed;
}

export function nowPlayingEmbed(config, radio) {
  const embed = base(config, radio.station);
  if (!radio.isActive) {
    return embed.setDescription('📴 The radio is off. Use `/play` to start it.');
  }
  if (radio.nowPlaying) {
    const { artist, song } = splitTitle(radio.nowPlaying.title);
    embed.setTitle(`🎵 ${song}`.slice(0, 256));
    embed.setDescription(artist ? `by **${artist}**` : null);
  } else {
    embed.setTitle('🎙️ Live').setDescription('_No track info right now (ads, news or the host is talking)._');
  }
  embed.addFields(
    { name: 'Channel', value: `<#${radio.channelId}>`, inline: true },
    { name: 'Volume', value: `${radio.volume}%`, inline: true },
    { name: 'On air since', value: `<t:${Math.floor(radio.startedAt / 1000)}:R>`, inline: true },
  );
  if (radio.station.logo) embed.setThumbnail(radio.station.logo);
  return embed;
}

export function stationsEmbed(config, currentKey) {
  const lines = Object.values(config.stations).map((s) => {
    const marker = s.key === currentKey ? '▶️' : '•';
    const desc = s.description ? ` — ${s.description}` : '';
    return `${marker} **${s.name}** \`${s.key}\`${desc}`;
  });
  if (config.allowCustomUrls) lines.push('', '_You can also pass any http(s) stream URL to `/play`._');
  return base(config).setTitle('📻 Stations').setDescription(lines.join('\n').slice(0, 4096));
}

export function settingsEmbed(config, settings) {
  const station = config.stations[settings.station]?.name ?? settings.station;
  const leave = config.leaveWhenAloneAfterSeconds;
  return base(config)
    .setTitle('⚙️ Radio settings')
    .addFields(
      { name: 'Default station', value: station, inline: true },
      { name: 'Volume', value: `${settings.volume}%`, inline: true },
      { name: '24/7 mode', value: settings.stay247 ? 'On' : 'Off', inline: true },
      { name: 'DJ role', value: settings.djRoleId ? `<@&${settings.djRoleId}>` : 'Anyone can control', inline: true },
      {
        name: 'Track announcements',
        value: !config.announceTrackChanges ? 'Disabled in config' : settings.announceChannelId ? `<#${settings.announceChannelId}>` : 'Off',
        inline: true,
      },
      { name: 'Leave when alone', value: settings.stay247 || leave === 0 ? 'Never' : `After ${leave}s`, inline: true },
    );
}
