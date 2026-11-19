const DEBUG = /^(1|true|yes)$/i.test(process.env.DEBUG ?? '');

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const log = {
  debug: (...args) => DEBUG && console.log(stamp(), 'DEBUG', ...args),
  info: (...args) => console.log(stamp(), 'INFO ', ...args),
  warn: (...args) => console.warn(stamp(), 'WARN ', ...args),
  error: (...args) => console.error(stamp(), 'ERROR', ...args),
};
