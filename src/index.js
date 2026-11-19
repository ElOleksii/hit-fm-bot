import { Client, Events, GatewayIntentBits } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { loadConfig } from './config.js';
import { GuildStore } from './store.js';
import { RadioManager } from './manager.js';
import { buildCommands, createInteractionHandler } from './commands.js';
import { log } from './log.js';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  log.error('DISCORD_TOKEN is not set. Copy .env.example to .env and paste your bot token there.');
  process.exit(1);
}

let config;
try {
  config = loadConfig();
} catch (err) {
  log.error(err.message);
  process.exit(1);
}

log.debug(`\n${generateDependencyReport()}`);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const store = new GuildStore(config);
const manager = new RadioManager(client, config, store);

client.once(Events.ClientReady, async (c) => {
  log.info(`Logged in as ${c.user.tag} in ${c.guilds.cache.size} server(s)`);
  const body = buildCommands(config);
  try {
    if (config.commandGuildId) {
      await c.application.commands.set(body, config.commandGuildId);
      // Remove global copies so the commands don't show up twice in that server.
      await c.application.commands.set([]);
      log.info(`Registered ${body.length} slash commands in server ${config.commandGuildId} (instant)`);
    } else {
      await c.application.commands.set(body);
      log.info(`Registered ${body.length} global slash commands (can take a few minutes to appear the first time)`);
    }
  } catch (err) {
    log.error(`Failed to register slash commands: ${err.message}`);
  }
  manager.schedulePresence();
  await manager.restoreSessions();
});

client.on(Events.InteractionCreate, createInteractionHandler({ config, store, manager }));

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  manager.refreshAloneTimer(newState.guild ?? oldState.guild);
});

client.on(Events.GuildDelete, (guild) => manager.stop(guild.id, 'removed from server'));
client.on(Events.Error, (err) => log.error(`client error: ${err.message}`));
process.on('unhandledRejection', (err) => log.error('unhandled rejection:', err));

let shuttingDown = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (shuttingDown) process.exit(1);
    shuttingDown = true;
    log.info('Shutting down...');
    manager.shutdown();
    await client.destroy().catch(() => {});
    process.exit(0);
  });
}

client.login(token).catch((err) => {
  log.error(`Login failed: ${err.message}. Check DISCORD_TOKEN in .env.`);
  process.exit(1);
});
