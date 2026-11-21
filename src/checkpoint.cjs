const { closeSync, constants, fstatSync, openSync, readSync, realpathSync } = require('node:fs');
const { isAbsolute, relative, sep } = require('node:path');

const maxBytes = 5 * 1024 * 1024;
const maxPixels = 32 * 1024 * 1024;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function png(data) {
  if (!Buffer.isBuffer(data) || data.length < 33 || data.length > maxBytes
      || !data.subarray(0, 8).equals(pngSignature) || data.readUInt32BE(8) !== 13
      || data.toString('ascii', 12, 16) !== 'IHDR') {
    return null;
  }
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  return width > 0 && height > 0 && width * height <= maxPixels ? data : null;
}

function readPng(path) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const entry = fstatSync(fd);
    if (!entry.isFile() || entry.size < 33 || entry.size > maxBytes) {
      return null;
    }
    const data = Buffer.alloc(entry.size);
    return readSync(fd, data, 0, data.length, 0) === data.length ? png(data) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

function pngAttachment(attachments, output) {
  const matches = (attachments ?? []).filter(attachment => attachment.name === 'reprocue-checkpoint');
  if (matches.length !== 1 || matches[0].contentType !== 'image/png') {
    return null;
  }
  const [attachment] = matches;
  if (attachment.body) {
    return png(attachment.body);
  }
  if (typeof attachment.path !== 'string') {
    return null;
  }
  try {
    const resolved = realpathSync(attachment.path);
    const suffix = relative(realpathSync(output), resolved);
    if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) {
      return null;
    }
    return readPng(resolved);
  } catch {
    return null;
  }
}

module.exports = { readPng, pngAttachment };
