export function createLogger(scope = 'bot') {
  const entries = [];

  function write(level, message, meta) {
    const timestamp = new Date().toISOString();
    const suffix = meta === undefined ? '' : ` ${formatMeta(meta)}`;
    const line = `[${timestamp}] [${scope}] [${level}] ${message}${suffix}`;
    entries.push({
      timestamp,
      scope,
      level,
      message,
      meta: meta === undefined ? null : formatMeta(meta),
      line
    });
    if (entries.length > 500) {
      entries.shift();
    }

    console.log(line);
  }

  return {
    debug: (message, meta) => write('debug', message, meta),
    info: (message, meta) => write('info', message, meta),
    warn: (message, meta) => write('warn', message, meta),
    error: (message, meta) => write('error', message, meta),
    getEntries: () => [...entries],
    // Empty the in-memory buffer (panel "clear logs" button). Returns how many were dropped.
    clearEntries: () => {
      const n = entries.length;
      entries.length = 0;
      return n;
    }
  };
}

function formatMeta(meta) {
  if (meta instanceof Error) {
    return meta.stack || meta.message;
  }

  if (typeof meta === 'string') {
    return meta;
  }

  try {
    return JSON.stringify(meta);
  } catch {
    return String(meta);
  }
}
