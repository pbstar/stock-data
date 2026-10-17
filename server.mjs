#!/usr/bin/env node
// 本地 A 股 K 线查看服务：直接读取 kline.json（或 kline.json.gz），前端只通过 HTTP 接口取数据。
// 启动: node server.mjs        (默认 http://localhost:5173)
// 可选: PORT=5180 或 --port 5180 改端口；KLINE_FILE=path/to/kline.json 指定数据文件

import { createServer } from 'node:http';
import { existsSync, readFileSync, openSync, readSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { basename } from 'node:path';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const DATA_FILE = process.env.KLINE_FILE || `${ROOT}kline.json`;
const DATA_SOURCE = existsSync(DATA_FILE)
  ? DATA_FILE
  : existsSync(`${DATA_FILE}.gz`)
    ? `${DATA_FILE}.gz`
    : null;
if (!DATA_SOURCE) {
  console.error(`找不到数据文件: ${DATA_FILE} 或 ${DATA_FILE}.gz`);
  process.exit(1);
}
const IS_GZ = DATA_SOURCE.endsWith('.gz');
const argPortIdx = process.argv.indexOf('--port');
const ARG_PORT = argPortIdx > 0 ? Number(process.argv[argPortIdx + 1]) : null;
const PORT = Number(process.env.PORT || ARG_PORT || 5173);

// ---------- 启动时扫描一遍原文件，只记录每只股票 K 线数组的字节偏移 ----------
function buildIndex() {
  const t0 = Date.now();
  const raw = readFileSync(DATA_SOURCE);
  const buf = IS_GZ ? gunzipSync(raw) : raw;
  const stocks = [];
  const byCode = new Map();
  const byDigits = new Map();
  const marker = '{"code":"';
  let pos = 0;

  while ((pos = buf.indexOf(marker, pos)) !== -1) {
    const codeStart = pos + marker.length;
    const codeEnd = buf.indexOf('"', codeStart);
    if (codeEnd < 0) throw new Error(`索引损坏 @${pos}`);
    const code = buf.toString('utf8', codeStart, codeEnd);

    const nameQuote = buf.indexOf('"name":"', codeEnd);
    if (nameQuote < 0) throw new Error(`缺少 name @${codeEnd}`);
    const nameStart = nameQuote + 8;

    let i = nameStart;
    while (i < buf.length) {
      const b = buf[i];
      if (b === 0x5c) i += 2;
      else if (b === 0x22) break;
      else i++;
    }
    const name = JSON.parse(buf.toString('utf8', nameQuote + 7, i + 1));

    const kMarker = buf.indexOf('"k":[', i);
    if (kMarker < 0) throw new Error(`缺少 k 数组 @${code}`);
    const arrStart = kMarker + 4;

    let depth = 0, j = arrStart, inStr = false;
    for (; j < buf.length; j++) {
      const b = buf[j];
      if (inStr) {
        if (b === 0x5c) j++;
        else if (b === 0x22) inStr = false;
      } else if (b === 0x22) inStr = true;
      else if (b === 0x5b) depth++;
      else if (b === 0x5d && --depth === 0) break;
    }

    const entry = { code, name, start: arrStart, end: j + 1 };
    stocks.push(entry);
    byCode.set(code, entry);
    byDigits.set(code.slice(2), entry);

    pos = j + 1;
  }

  const firstDate = /"date":"(\d{8})"/.exec(
    buf.toString('utf8', stocks[0].start, Math.min(stocks[0].end, stocks[0].start + 40)),
  )[1];
  const last = stocks[stocks.length - 1];
  const m = /"date":"(\d{8})"[^}]*\}\]$/.exec(
    buf.toString('utf8', Math.max(last.start, last.end - 200), last.end),
  );
  const lastDate = m ? m[1] : firstDate;

  console.log(`索引完成: ${stocks.length} 只股票, ${firstDate}~${lastDate}, 数据源 ${basename(DATA_SOURCE)}, 用时 ${Date.now() - t0}ms`);
  return { stocks, byCode, byDigits, firstDate, lastDate, buf: IS_GZ ? buf : null };
}

const { stocks, byCode, byDigits, firstDate, lastDate, buf: dataBuf } = buildIndex();
const fd = dataBuf ? null : openSync(DATA_SOURCE, 'r');

function readK(code) {
  const entry = byCode.get(code) || byDigits.get(code);
  if (!entry) return null;
  if (dataBuf) {
    return { code: entry.code, name: entry.name, k: JSON.parse(dataBuf.toString('utf8', entry.start, entry.end)) };
  }
  const len = entry.end - entry.start;
  const b = Buffer.allocUnsafe(len);
  let off = 0;
  while (off < len) {
    const n = readSync(fd, b, off, len - off, entry.start + off);
    if (n <= 0) throw new Error(`读取 ${code} 失败`);
    off += n;
  }
  return { code: entry.code, name: entry.name, k: JSON.parse(b.toString('utf8')) };
}

function normalizeCode(input) {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (/^(sh|sz|bj)\d{6}$/.test(s)) return s;
  const m = /^(\d{6})\.(sh|sz|bj)$/.exec(s);
  if (m) return m[2] + m[1];
  if (/^\d{6}$/.test(s)) return s;
  return null;
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const STATIC = {
  '/': ['viewer/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['viewer/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['viewer/app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['viewer/style.css', 'text/css; charset=utf-8'],
};

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    if (path === '/api/meta') {
      return sendJSON(res, 200, { stocks: stocks.length, firstDate, lastDate });
    }

    if (path === '/api/stocks') {
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      const limit = Math.min(Number(url.searchParams.get('limit') || 10000), 10000);
      const list = [];
      for (const s of stocks) {
        if (q && !s.code.includes(q) && !s.name.toLowerCase().includes(q)) continue;
        list.push({ code: s.code, name: s.name });
        if (list.length >= limit) break;
      }
      return sendJSON(res, 200, { total: list.length, stocks: list });
    }

    if (path === '/api/kline') {
      const raw = normalizeCode(url.searchParams.get('code'));
      if (!raw) return sendJSON(res, 400, { error: '缺少或无法识别 code 参数' });
      const data = readK(raw);
      if (!data) return sendJSON(res, 404, { error: `找不到股票 ${raw}` });

      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const limit = Number(url.searchParams.get('limit') || 0);
      let k = data.k;
      if (from && /^\d{8}$/.test(from)) k = k.filter((b) => b.date >= from);
      if (to && /^\d{8}$/.test(to)) k = k.filter((b) => b.date <= to);
      if (limit > 0 && k.length > limit) k = k.slice(-limit);

      return sendJSON(res, 200, { code: data.code, name: data.name, k });
    }

    const file = STATIC[path];
    if (file) {
      const body = readFileSync(ROOT + file[0]);
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
      return res.end(body);
    }

    sendJSON(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    sendJSON(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`K线查看器已启动: http://localhost:${PORT}`);
});
