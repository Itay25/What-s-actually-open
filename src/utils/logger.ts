const isDev = process.env.NODE_ENV !== 'production';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const logger = {
  info: (message: string, ...args: any[]) => {
    if (isDev) {
      console.log(`[INFO] ${message}`, ...args);
    }
  },
  warn: (message: string, ...args: any[]) => {
    if (isDev) {
      console.warn(`[WARN] ${message}`, ...args);
    }
  },
  error: (message: string, ...args: any[]) => {
    // We might want to log errors even in production, but the requirement says "near-zero logs"
    // and "Keep only critical logs and errors". Usually errors are critical.
    console.error(`[ERROR] ${message}`, ...args);
  },
  debug: (message: string, ...args: any[]) => {
    if (isDev) {
      console.debug(`[DEBUG] ${message}`, ...args);
    }
  }
};

export default logger;
