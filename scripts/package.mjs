// Builds the store-upload zip. Writes the archive by hand so packaging needs
// no dependencies and behaves the same on every platform.

import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything the browser needs, and nothing else.
const INCLUDE = ['manifest.json', 'popup.html', 'popup.js', 'background.js', 'LICENSE', 'lib', 'icons'];

function collect(relative) {
  const absolute = path.join(root, relative);
  if (statSync(absolute).isDirectory()) {
    return readdirSync(absolute).flatMap((child) => collect(path.posix.join(relative, child)));
  }
  return [relative];
}

const CRC_TABLE = Int32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// Fixed 1980-01-01 stamp so the same input always produces the same zip.
const DOS_TIME = 0;
const DOS_DATE = 0x21;

function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, compressed);
    centrals.push(central);
    offset += local.length + compressed.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuf, end]);
}

const { version, name } = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const files = INCLUDE.flatMap(collect)
  .sort()
  .map((relative) => ({ name: relative, data: readFileSync(path.join(root, relative)) }));

const zip = buildZip(files);
const outDir = path.join(root, 'dist');
mkdirSync(outDir, { recursive: true });

const outFile = path.join(outDir, `claude-usage-monitor-${version}.zip`);
writeFileSync(outFile, zip);

console.log(`packaged ${name} v${version}`);
console.log(`  ${files.length} files, ${(zip.length / 1024).toFixed(1)} KB`);
console.log(`  ${path.relative(root, outFile)}`);
