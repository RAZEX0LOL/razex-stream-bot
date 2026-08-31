import fs from 'node:fs';
import path from 'node:path';

// How every store touches disk.
//
// The old way — one writeFileSync straight over the live file — has a window in which
// the file is neither the old content nor the new one. A crash, an OOM kill or a host
// reboot inside that window leaves truncated JSON. The second half of the problem was
// worse: load() caught the parse error, started empty, and the next save() overwrote
// the damaged file with nothing. For a chat service that can mean losing every command,
// viewer balance, timer, and queued track at once.
//
// So: write beside the target, fsync, then rename over it. Rename within one filesystem
// is atomic — a reader sees either the whole old file or the whole new one, never a
// half. And a file we cannot parse is kept as evidence instead of being erased.

// Write `text` so that the file is never observed half-written.
export function writeJsonAtomic(filePath, text, { mode } = {}) {
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // Same directory on purpose: rename is only atomic within a filesystem, and /tmp is
  // very often a different one.
  const tmp = `${target}.${process.pid}.tmp`;
  const options = mode === undefined ? { encoding: 'utf8' } : { encoding: 'utf8', mode };

  let handle = null;
  try {
    fs.writeFileSync(tmp, text, options);
    // Without fsync the rename can land while the contents are still only in the page
    // cache — after a power cut the file exists and is empty. This is the case the
    // whole exercise is about, so pay the few milliseconds.
    handle = fs.openSync(tmp, 'r+');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(tmp, target);
    if (mode !== undefined) {
      fs.chmodSync(target, mode);
    }
  } catch (error) {
    if (handle !== null) {
      try {
        fs.closeSync(handle);
      } catch {
        // already closed
      }
    }
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

// Read and parse a store file.
//
// Returns `fallback` when the file simply is not there yet (a fresh install), but a
// file that exists and does not parse is a different animal: that is damage, and
// silently starting empty would let the next write erase the evidence along with the
// data. Such a file is moved aside as <name>.corrupt-<stamp> and reported loudly.
export function readJsonSafe(filePath, fallback, { logger, label = path.basename(filePath) } = {}) {
  const target = path.resolve(filePath);
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      logger?.warn?.(`Не смог прочитать ${label}: ${error.message}`);
    }
    return fallback;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    const kept = `${target}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      fs.renameSync(target, kept);
    } catch {
      // If even that fails we still refuse to pretend the store was empty.
    }
    logger?.error?.(
      `Файл ${label} повреждён (${error.message}). Сохранил как ${path.basename(kept)} — ` +
        'данные не потеряны, но их надо восстановить вручную.'
    );
    return fallback;
  }
}

// Move a file we could not parse out of the way, keeping it as evidence.
//
// Called from the stores' own catch blocks: they each parse and sanitise differently, so
// they keep doing that — this only makes sure a damaged file is not quietly overwritten
// by the next save(). Only syntax errors qualify: a permission problem or a bad disk is
// not corruption, and renaming the file would make that worse.
export function quarantineCorrupt(filePath, error, { logger, label } = {}) {
  if (!(error instanceof SyntaxError)) {
    return null;
  }
  const target = path.resolve(filePath);
  const kept = `${target}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    fs.renameSync(target, kept);
  } catch {
    return null;
  }
  logger?.error?.(
    `Файл ${label ?? path.basename(target)} повреждён и сохранён как ${path.basename(kept)}. ` +
      'Стор продолжит работу пустым — данные из копии нужно вернуть вручную.'
  );
  return kept;
}
