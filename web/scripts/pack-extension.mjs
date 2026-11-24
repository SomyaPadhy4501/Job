// Zips the Chrome extension (../../extension) into the site's static files, so
// the Autofill page can offer it as a download that always matches this build:
//   web/public/downloads/job-board-extension.zip
//   web/public/downloads/extension.json   { version, bytes, files, builtAt }
//
// Runs before `vite build` (see package.json). EXTENSION_DIR overrides the
// source folder. No dependencies: a small ZIP writer over node:zlib.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(process.env.EXTENSION_DIR || join(here, '../../extension'));
const out = join(here, '../public/downloads');
const FOLDER = 'job-board-extension'; // what the zip unpacks to

function files(dir) {
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : [path];
    });
}

// CRC-32 (zlib.crc32 exists from Node 22.2; this table is the fallback).
const TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 =
  zlib.crc32 ||
  ((buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  });

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // A fixed timestamp keeps the zip identical between builds of the same code.
  const time = 0, date = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const packed = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, packed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const paths = files(source);
const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
const entries = paths.map((path) => ({
  name: FOLDER + '/' + relative(source, path).split('\\').join('/'),
  data: readFileSync(path),
}));
const archive = zip(entries);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'job-board-extension.zip'), archive);
writeFileSync(
  join(out, 'extension.json'),
  JSON.stringify(
    {
      name: manifest.name,
      version: manifest.version,
      bytes: archive.length,
      files: entries.length,
      autofill: entries.some((e) => e.name.endsWith('/autofill.js')),
      folder: FOLDER,
    },
    null,
    2
  ) + '\n'
);
console.log(`packed ${entries.length} files from ${source} → downloads/job-board-extension.zip (${archive.length} bytes, v${manifest.version})`);

// The Workday employers, for the extension's Workday collection
// (extension/workday-collect.js). Workday blocks GitHub's runners (Cloudflare,
// since 2026-11-24), so the owner's browser reads these boards instead. The
// list comes from src/config.js, so adding a tenant there reaches the
// extension with the next deploy.
const require = createRequire(import.meta.url);
const { COMPANIES } = require(join(here, '../../src/config.js'));
const tenants = COMPANIES.filter((c) => c.source === 'workday' && c.tenant && c.wd && c.site).map(
  ({ slug, displayName, tenant, wd, site, searches }) => ({ slug, displayName, tenant, wd, site, ...(searches ? { searches } : {}) })
);
writeFileSync(join(out, 'workday-tenants.json'), JSON.stringify({ tenants }) + '\n');
console.log(`listed ${tenants.length} Workday employers → downloads/workday-tenants.json`);
