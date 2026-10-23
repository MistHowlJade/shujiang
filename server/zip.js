// 通用 ZIP 打包 / 解包（store / deflate），无第三方依赖。
// EPUB 与 Word（.docx）共用：两者都是 ZIP 容器。
import { deflateRawSync, inflateRawSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * 把文件按给定顺序写成 ZIP。
 * @param {{name: string, data: string|Buffer, store?: boolean}[]} files
 * @returns {Buffer}
 */
export function zip(files) {
  const now = new Date();
  const time = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff;
  const date = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const local = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const method = file.store ? 0 : 8;
    const body = method === 0 ? raw : deflateRawSync(raw, { level: 9 });
    const sum = crc32(raw);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);       // 文件名 UTF-8
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(time, 10);
    header.writeUInt16LE(date, 12);
    header.writeUInt32LE(sum, 14);
    header.writeUInt32LE(body.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(name.length, 26);
    header.writeUInt16LE(0, 28);
    local.push(header, name, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(sum, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += header.length + name.length + body.length;
  }

  const centralSize = central.reduce((sum, buf) => sum + buf.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, ...central, end]);
}

/* ------------------------------------------------------------------ */
/* 解包：只取一个条目（Word 导入用），不落盘、不信任目录里的路径       */
/* ------------------------------------------------------------------ */

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * 从 ZIP 里取出一个文件。只支持单卷、非 ZIP64 的普通 ZIP。
 * 只解压目标条目，并用 maxBytes 限制解压后大小，避免 zip bomb。
 * @param {Buffer} buf
 * @param {string} name
 * @param {{maxBytes?: number}} [opts]
 * @returns {Buffer}
 */
export function unzipEntry(buf, name, { maxBytes = 40 * 1024 * 1024 } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是有效的 Word 文档（文件太小）');
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('不是有效的 Word 文档（找不到 ZIP 目录）');

  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || cdDisk !== 0) throw new Error('不支持分卷 ZIP');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的 Word 文档');
  }
  if (!count) throw new Error('ZIP 里没有文件');
  if (count > 2000) throw new Error('ZIP 里的文件太多');
  if (cdOffset + cdSize > buf.length) throw new Error('ZIP 目录不完整');

  let pos = cdOffset;
  let found = null;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== CENTRAL_SIG) {
      throw new Error('ZIP 目录损坏');
    }
    const flags = buf.readUInt16LE(pos + 8);
    const method = buf.readUInt16LE(pos + 10);
    const sum = buf.readUInt32LE(pos + 16);
    const csize = buf.readUInt32LE(pos + 20);
    const usize = buf.readUInt32LE(pos + 24);
    const nlen = buf.readUInt16LE(pos + 28);
    const elen = buf.readUInt16LE(pos + 30);
    const clen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    if (csize === 0xffffffff || usize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('暂不支持 ZIP64 格式的 Word 文档');
    }
    if (pos + 46 + nlen + elen + clen > buf.length) throw new Error('ZIP 目录损坏');

    const entryName = buf.toString('utf8', pos + 46, pos + 46 + nlen).replace(/\\/g, '/');
    if (entryName === name) {
      if (found) throw new Error('ZIP 里有重复的正文文件');
      found = { flags, method, sum, csize, usize, localOffset };
    }
    pos += 46 + nlen + elen + clen;
  }

  if (!found) throw new Error(`ZIP 里没有 ${name}`);
  if (found.flags & 1) throw new Error('加密的 Word 文档暂不支持');
  if (found.usize > maxBytes) {
    throw new Error(`正文解压后太大（上限 ${Math.round(maxBytes / 1024 / 1024)} MB）`);
  }

  const lh = found.localOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== LOCAL_SIG) {
    throw new Error('ZIP 文件头损坏');
  }
  const nlen = buf.readUInt16LE(lh + 26);
  const elen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nlen + elen;
  const end = start + found.csize;
  if (end > buf.length) throw new Error('ZIP 文件不完整');
  const localName = buf.toString('utf8', lh + 30, lh + 30 + nlen).replace(/\\/g, '/');
  if (localName !== name) throw new Error('ZIP 文件名对不上');

  const raw = buf.subarray(start, end);
  let out;
  if (found.method === 0) {
    out = Buffer.from(raw);
  } else if (found.method === 8) {
    try {
      out = inflateRawSync(raw, { maxOutputLength: maxBytes });
    } catch (err) {
      throw new Error(`解压失败：${err.message}`);
    }
  } else {
    throw new Error(`不支持的 ZIP 压缩方式：${found.method}`);
  }
  if (out.length !== found.usize) throw new Error('解压后的长度对不上');
  if (crc32(out) !== found.sum) throw new Error('文件校验失败（CRC 对不上）');
  return out;
}
