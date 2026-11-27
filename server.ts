import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WAMessage } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { createAnimatedSticker, MAX_INPUT_BYTES } from './src/convert.js';
import { sendSoundSticker } from './src/sound-sticker.js';

const PORT = Number(process.env.PORT || 3000);
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const AUTH_DIR = process.env.AUTH_DIR || (existsSync('/var/data') ? '/var/data/stickersom-session' : './data/session');
const MAX_AGE = 15 * 60 * 1000;
const pending = new Map<string, { sticker: Buffer; audio: Buffer; durationMs: number; expires: number }>();
let socket: ReturnType<typeof makeWASocket> | undefined;
let qrDataUrl = '';
let connectedPhone = '';
let reconnectTimer: NodeJS.Timeout | undefined;
const rate = new Map<string, { count: number; reset: number }>();

function json(res: import('node:http').ServerResponse, status: number, body: object) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function messageText(m: WAMessage): string {
  const c = m.message;
  return c?.conversation || c?.extendedTextMessage?.text || c?.imageMessage?.caption || c?.videoMessage?.caption || '';
}
function cleanExpired() {
  const now = Date.now();
  for (const [code, item] of pending) if (item.expires < now) pending.delete(code);
}
function makeCode() { return 'SS-' + randomBytes(3).toString('hex').toUpperCase(); }

async function connect() {
  await mkdir(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const current = makeWASocket({ auth: state, logger, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false });
  socket = current;
  current.ev.on('creds.update', saveCreds);
  current.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
    if (connection === 'open') {
      qrDataUrl = '';
      connectedPhone = current.user?.id?.split(':')[0]?.split('@')[0] || '';
      console.log('[StickerSom] WhatsApp conectado:', connectedPhone);
    }
    if (connection === 'close' && socket === current) {
      connectedPhone = '';
      const status = (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        console.error('[StickerSom] Sessão desconectada. É necessário parear novamente.');
        return;
      }
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => void connect().catch(console.error), status === DisconnectReason.restartRequired ? 500 : 3000);
    }
  });
  current.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe || !msg.key.remoteJid?.endsWith('@s.whatsapp.net')) continue;
      const code = messageText(msg).trim().toUpperCase();
      if (!/^SS-[A-F0-9]{6}$/.test(code)) continue;
      cleanExpired();
      const item = pending.get(code);
      if (!item) {
        await current.sendMessage(msg.key.remoteJid, { text: 'Esse código não existe ou expirou. Volte ao StickerSom e crie sua figurinha novamente.' });
        continue;
      }
      try {
        await sendSoundSticker(current, msg.key.remoteJid, { sticker: item.sticker, audio: item.audio, durationMs: item.durationMs });
        pending.delete(code);
        await current.sendMessage(msg.key.remoteJid, { text: '🔊 Sua figurinha sonora chegou! Toque nela para ouvir.' });
      } catch (error) {
        console.error('[StickerSom] Falha no envio:', error);
        await current.sendMessage(msg.key.remoteJid, { text: 'Não consegui entregar essa figurinha agora. Tente gerar outra pelo site.' });
      }
    }
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, { ok: true, connected: !!connectedPhone, phone: connectedPhone });
    }
    if (req.method === 'GET' && url.pathname === '/pair') {
      if (!qrDataUrl) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;background:#111;color:#fff;display:grid;place-items:center;min-height:90vh;text-align:center"><main><h2>StickerSom</h2><p>${connectedPhone ? 'WhatsApp já conectado: +' + connectedPhone : 'Aguardando QR Code. Atualize esta página em alguns segundos.'}</p>${connectedPhone ? '' : '<meta http-equiv="refresh" content="5">'}</main></body>`);
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta name="viewport" content="width=device-width"><body style="font:16px system-ui;background:#111;color:#fff;display:grid;place-items:center;min-height:90vh;text-align:center"><main><h2>Conectar WhatsApp StickerSom</h2><p>WhatsApp → Aparelhos conectados → Conectar aparelho</p><img width="320" src="${qrDataUrl}"><p>Esta página atualiza automaticamente.</p><meta http-equiv="refresh" content="15"></main></body>`);
    }
    if (req.method === 'POST' && url.pathname === '/api/create') {
      const ip = req.socket.remoteAddress || 'unknown';
      const now = Date.now(), bucket = rate.get(ip);
      if (bucket && bucket.reset > now && bucket.count >= 5) return json(res, 429, { error: 'Muitas criações. Aguarde um minuto.' });
      if (!bucket || bucket.reset < now) rate.set(ip, { count: 1, reset: now + 60_000 }); else bucket.count++;
      const duration = Math.min(10, Math.max(0.2, Number(url.searchParams.get('duration') || 5)));
      const start = Math.max(0, Number(url.searchParams.get('start') || 0));
      const chunks: Buffer[] = []; let total = 0;
      for await (const chunk of req) {
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += b.length;
        if (total > MAX_INPUT_BYTES) { json(res, 413, { error: 'O vídeo ultrapassa 16 MB.' }); req.destroy(); return; }
        chunks.push(b);
      }
      if (!total) return json(res, 400, { error: 'Selecione um vídeo.' });
      const result = await createAnimatedSticker(Buffer.concat(chunks), {
        fit: 'cortar', withAudio: true, startSec: start, durationSec: duration,
        meta: { packName: 'StickerSom', publisher: 'StickerSom' },
      });
      if (!result.audio || result.audioSilent) return json(res, 422, { error: result.audioSilent ? 'O trecho selecionado está sem áudio.' : 'Não consegui extrair o áudio deste vídeo.' });
      cleanExpired();
      if (pending.size >= 100) return json(res, 503, { error: 'O serviço está cheio. Tente novamente em alguns minutos.' });
      let code = makeCode(); while (pending.has(code)) code = makeCode();
      pending.set(code, { sticker: result.sticker, audio: result.audio, durationMs: result.durationMs, expires: Date.now() + MAX_AGE });
      return json(res, 200, { ok: true, code, expiresIn: 900, phone: connectedPhone, whatsappUrl: connectedPhone ? `https://wa.me/${connectedPhone}?text=${encodeURIComponent(code)}` : null });
    }
    if (req.method === 'GET' && url.pathname === '/') {
      const html = await readFile('index.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    if (req.method === 'GET' && ['/app.js','/styles.css'].includes(url.pathname)) {
      const file = await readFile('.' + url.pathname);
      res.writeHead(200, { 'content-type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8' });
      return res.end(file);
    }
    json(res, 404, { error: 'Não encontrado.' });
  } catch (error) {
    console.error('[StickerSom HTTP]', error);
    if (!res.headersSent) json(res, 500, { error: error instanceof Error ? error.message : 'Falha inesperada.' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log(`[StickerSom] Site/API em :${PORT}`));
connect().catch(error => { console.error('[StickerSom] Não foi possível iniciar WhatsApp:', error); process.exitCode = 1; });
