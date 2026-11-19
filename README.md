# Hit FM Discord Bot

A Discord bot that streams **Hit FM** radio live into voice (and stage) channels, with live
"now playing" song titles, auto-reconnect, per-server settings and a fully configurable
station list.

## Features

- Live audio from Hit FM's own streams (6 channels preconfigured, including 320 kbps HD)
- Real-time song titles from the stream metadata: `/nowplaying`, bot status, and optional song announcements in a text channel
- Auto-reconnect with back-off if the stream drops, plus a watchdog for stalled audio
- Per-server settings saved to disk: default station, volume, DJ role, announcement channel, 24/7 mode
- 24/7 mode: stays in the channel and rejoins automatically after a restart
- Leaves on its own when nobody is listening (configurable)
- Add any other internet radio station by editing `config.json`

## Requirements

- Node.js **22.9 or newer**
- A Discord bot token
- ffmpeg is bundled through `ffmpeg-static`; nothing else to install

## Setup

1. **Create the bot.** Open the [Discord Developer Portal](https://discord.com/developers/applications), click **New Application**, then go to **Bot** and click **Reset Token**. Copy the token.
2. **Invite it.** Go to **OAuth2 → URL Generator**. Tick the `bot` and `applications.commands` scopes, then the bot permissions **View Channels, Send Messages, Embed Links, Connect, Speak**. Open the generated URL and add the bot to your server.
3. **Install:**
   ```bash
   npm install
   ```
4. **Configure:**
   ```bash
   cp .env.example .env
   ```
   ```bash
   cp config.example.json config.json
   ```
   Paste your token into `.env` as `DISCORD_TOKEN=...`, then edit `config.json` as needed.
5. **Optional: test the streams** (no token needed). This decodes a few seconds of every station:
   ```bash
   npm run check
   ```
6. **Run:**
   ```bash
   npm start
   ```

Global slash commands can take a few minutes to show up the first time. While testing,
set `commandGuildId` in `config.json` to your server's ID so they register instantly.

## Commands

| Command | Who | What it does |
|---|---|---|
| `/play [station] [channel]` | DJ | Joins your voice channel (or the one you pick) and starts the radio |
| `/station <station>` | DJ | Switches station live, or sets the station if the radio is off |
| `/stations` | Everyone | Lists the stations |
| `/nowplaying` | Everyone | Shows the current song, channel, volume and how long the radio has been on |
| `/volume [level]` | DJ | Shows or sets the volume (0 to `maxVolume`) |
| `/stop` | DJ | Stops and leaves |
| `/settings show` | Manage Server | Shows this server's settings |
| `/settings default-station <station>` | Manage Server | Station used when `/play` has none |
| `/settings dj-role [role]` | Manage Server | Limits control to one role; leave empty to let everyone control it |
| `/settings announce-channel [channel]` | Manage Server | Posts every new song there; leave empty to turn off |
| `/settings 24-7 <enabled>` | Manage Server | Never leave when the channel is empty, and rejoin after restarts |
| `/settings reset` | Manage Server | Back to `config.json` defaults |

"DJ" means: anyone if no DJ role is set, otherwise members with the DJ role. Members with
**Manage Server** can always control the bot. While the radio is on, non-managers must be
in the same voice channel to control it.

## Configuration (`config.json`)

| Key | Default | Description |
|---|---|---|
| `defaultStation` | `"hitfm"` | Station key used by default |
| `stations` | Hit FM channels | `{ "key": { "name", "url", "description?", "logo?", "website?" } }`. Any MP3/AAC/OGG HTTP stream works |
| `allowCustomUrls` | `false` | Let users pass any stream URL to `/play` |
| `defaultVolume` | `80` | Starting volume for new servers (%) |
| `maxVolume` | `150` | Upper limit for `/volume` (max 200) |
| `stayInChannelByDefault` | `false` | 24/7 mode for servers that haven't set it |
| `leaveWhenAloneAfterSeconds` | `120` | Leave after this many seconds with no listeners. `0` means never |
| `announceTrackChanges` | `true` | Master switch for song announcements (each server still picks a channel) |
| `presence` | `"track"` | Bot status: `"track"` (current song), `"station"` (station name) or `"off"` |
| `embedColor` | `"#E30613"` | Colour of embeds |
| `commandGuildId` | `""` | Register commands in this server only (instant). Empty means global |
| `dataFile` | `"data/guilds.json"` | Where per-server settings are stored |
| `autoJoin` | `[]` | `[{ "guildId", "channelId", "station?" }]`: channels to join at startup |
| `stream.ffmpegPath` | `""` | Use your own ffmpeg instead of the bundled one (or set `FFMPEG_PATH`) |
| `stream.userAgent` | | User-Agent sent to the radio server |
| `stream.timeoutSeconds` | `15` | Reconnect if no data arrives for this long |
| `stream.reconnectDelaysSeconds` | `[1,2,5,10,30]` | Back-off between reconnect attempts. The last value repeats |
| `stream.metadataEncoding` | `"auto"` | Song title encoding. `auto` tries UTF-8 and then Windows-1251 |

Keys starting with `_` (like `_comment`) are ignored. A different config file can be used with
`CONFIG_PATH=path/to/file.json`. Set `DEBUG=true` in `.env` for verbose logs, including the
voice dependency report.

### Adding a station

```json
"stations": {
  "hitfm": { "name": "Hit FM", "url": "https://online.hitfm.ua/HitFM" },
  "my-station": { "name": "My Station", "url": "https://example.com/stream.mp3", "logo": "https://example.com/logo.png" }
}
```

## Notes

- Audio is decoded by ffmpeg and encoded to Opus with `opusscript`. For many servers at once,
  `npm install @discordjs/opus` (native, needs build tools) uses much less CPU and is picked
  up automatically.
- Discord voice end-to-end encryption (DAVE) is handled by `@discordjs/voice` and `@snazzah/davey`.
- Radio servers send a few seconds of buffered audio when you connect, so the bot plays a few seconds
  behind the live broadcast, the same as any web player.
- Keep the process running with something like `pm2 start src/index.js --node-args="--env-file=.env"`,
  or a Windows service or systemd unit.
