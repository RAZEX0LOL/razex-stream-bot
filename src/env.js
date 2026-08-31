import fs from 'node:fs';
import path from 'node:path';

export function loadDotEnv(filePath = '.env') {
  const resolvedPath = path.resolve(process.cwd(), filePath);
  if (!fs.existsSync(resolvedPath)) {
    return false;
  }

  const content = fs.readFileSync(resolvedPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = parseEnvValue(line.slice(separatorIndex + 1).trim());
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }

  return true;
}

export function readEnv(name, { required = false, defaultValue = undefined } = {}) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (required) {
      throw new Error(`Missing required environment variable: ${name}`);
    }

    return defaultValue;
  }

  return value;
}

export function normalizeAccessToken(token) {
  if (!token) {
    return token;
  }

  return token.startsWith('oauth:') ? token.slice('oauth:'.length) : token;
}

function parseEnvValue(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}
