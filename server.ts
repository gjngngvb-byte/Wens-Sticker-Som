import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes } from 'node:crypto';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WAMessage } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { createAnimatedSticker, createImageSoundSticker, createAudioTrack, MAX_INPUT_BYTES } from './src/convert.js';
import { sendSoundSticker } from './src/sound-sticker.js';

const PORT = Number(process.env.PORT || 3000);
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const AUTH_DIR = process.env.AUTH_DIR || (existsSync('/var/data') ? '/var/data/stickersom-session' : './data/session');
const MAX_AGE = 15 * 60 * 1000;
const pending = new Map<string, { sticker: Buffer; audio: Buffer; durationMs: number; expires: number }>();
const prepared = new Map<string, { sticker: Buffer; durationMs: number; expires: number }>();
let socket: ReturnType<typeof makeWASocket> | undefined;
let qrDataUrl = '';
let connectedPhone = '';
let connectionState: 'connecting' | 'open' | 'close' = 'connecting';
let pairingRegistered = false;
let lastPairingRequest = 0;
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
function makePending(sticker: Buffer, audio: Buffer, durationMs: number) {
  cleanExpired();
  if (pending.size >= 100) throw new Error('O serviço está cheio. Tente novamente em alguns minutos.');
  let code = makeCode(); while (pending.has(code)) code = makeCode();
  pending.set(code, { sticker, audio, durationMs, expires: Date.now() + MAX_AGE });
  console.log('[StickerSom] Figurinha criada:', code, 'WhatsApp conectado:', !!connectedPhone);
  return { ok: true, code, expiresIn: 900, phone: connectedPhone, whatsappUrl: connectedPhone ? `https://wa.me/${connectedPhone}?text=${encodeURIComponent(code)}` : null };
}

async function connect() {
  await mkdir(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const current = makeWASocket({ auth: state, logger, printQRInTerminal: false, markOnlineOnConnect: false, syncFullHistory: false });
  socket = current;
  pairingRegistered = !!state.creds.registered;
  current.ev.on('creds.update', saveCreds);
  current.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
    if (connection === 'open') {
      connectionState = 'open';
      pairingRegistered = true;
      qrDataUrl = '';
      connectedPhone = current.user?.id?.split(':')[0]?.split('@')[0] || '';
      console.log('[StickerSom] WhatsApp conectado:', connectedPhone);
    }
    if (connection === 'close' && socket === current) {
      connectionState = 'close';
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
    // Registra os metadados de entrega para diagnosticar mensagens que não chegam ao fluxo.
    console.log('[StickerSom] Evento messages.upsert:', type, messages.map(m => ({ jid: m.key.remoteJid, alt: m.key.remoteJidAlt, fromMe: m.key.fromMe, text: messageText(m).slice(0, 24) })));
    // Mensagens enviadas pelo próprio aparelho podem chegar como append; mensagens recebidas como notify.
    if (type !== 'notify' && type !== 'append') return;
    for (const msg of messages) {
      const remoteJid = msg.key.remoteJid || '';
      const ownNumber = current.user?.id?.split(':')[0]?.split('@')[0];
      const chatNumber = remoteJid.split(':')[0].split('@')[0];
      const alternateNumber = msg.key.remoteJidAlt?.split(':')[0]?.split('@')[0];
      const isOwnChat = !!ownNumber && (chatNumber === ownNumber || alternateNumber === ownNumber);
      const isDirectChat = remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid');
      // Aceita PN e LID no chat consigo mesmo, sem processar mensagens enviadas a terceiros.
      if (!msg.message || !isDirectChat || (msg.key.fromMe && !isOwnChat)) continue;
      const code = messageText(msg).trim().toUpperCase();
      if (!/^SS-[A-F0-9]{6}$/.test(code)) continue;
      console.log('[StickerSom] Código de figurinha recebido na conversa:', remoteJid, 'selfChat:', isOwnChat);
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
      return json(res, 200, { ok: true, connected: !!connectedPhone, phone: connectedPhone, connectionState });
    }
    if (req.method === 'GET' && url.pathname === '/api/qr') {
      return json(res, 200, { ok: true, qr: qrDataUrl, connected: !!connectedPhone });
    }
    if (req.method === 'GET' && url.pathname === '/pair') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar WhatsApp | StickerSom</title><body style="font:16px system-ui;background:#111;color:#fff;display:grid;place-items:center;min-height:90vh;text-align:center;padding:20px"><main style="max-width:420px;width:100%"><h2>Conectar WhatsApp StickerSom</h2><p id="state">${connectedPhone ? 'WhatsApp já conectado: +' + connectedPhone : 'Escolha uma forma de conexão'}</p><section style="background:#201e29;padding:18px;border-radius:16px;margin:18px 0"><h3>Por código</h3><p>Digite o número que será conectado, com código do país. Ex.: 5511999999999</p><input id="phone" inputmode="numeric" autocomplete="tel" placeholder="5511999999999" style="box-sizing:border-box;width:100%;padding:14px;border-radius:9px;border:0;font-size:17px"><button id="request" style="margin-top:12px;width:100%;padding:14px;border:0;border-radius:9px;background:#9c6bff;color:white;font-weight:700;font-size:16px">Gerar código de pareamento</button><h1 id="paircode" style="letter-spacing:5px"></h1><p id="message" aria-live="polite">No WhatsApp: Aparelhos conectados → Conectar aparelho → Conectar com número de telefone</p></section><section style="background:#201e29;padding:18px;border-radius:16px"><h3>Ou use QR Code</h3><img id="qrImage" width="280" style="max-width:100%;display:none" alt="QR Code para conectar WhatsApp"><p id="qrHint">Aguardando QR Code…</p><p>WhatsApp → Aparelhos conectados → Conectar aparelho</p></section><script>document.getElementById('phone').addEventListener('input',e=>{const el=e.target;const digits=el.value.replace(/[^0-9]/g,'');if(el.value!==digits)el.value=digits;});
document.getElementById('request').onclick=async()=>{const phone=document.getElementById('phone').value.replace(/[^0-9]/g,'');const msg=document.getElementById('message');const btn=document.getElementById('request');document.getElementById('paircode').textContent='';msg.textContent='Solicitando código…';btn.disabled=true;try{const r=await fetch('/api/pairing-code',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Não foi possível gerar o código.');document.getElementById('paircode').textContent=d.code;msg.textContent='No celular, abra Aparelhos conectados → Conectar aparelho → Conectar com número de telefone e digite este código.'}catch(e){msg.textContent=e.message}finally{btn.disabled=false}};</script><script>
const state=document.getElementById('state');
const qrImage=document.getElementById('qrImage');
const qrHint=document.getElementById('qrHint');
async function refreshQr(){try{const r=await fetch('/api/qr',{cache:'no-store'});const d=await r.json();if(d.qr){qrImage.src=d.qr;qrImage.style.display='inline-block';qrHint.textContent='Leia este código com o WhatsApp.';}else if(!d.connected){qrImage.style.display='none';qrHint.textContent='Aguardando o WhatsApp disponibilizar o QR Code…';}}catch{}setTimeout(refreshQr,2000);}
refreshQr();
async function waitForConnection(){
  try{
    const r=await fetch('/api/status',{cache:'no-store'});
    const s=await r.json();
    if(s.connected){
      state.textContent='✓ WhatsApp conectado! Voltando ao StickerSom…';
      setTimeout(()=>location.replace('/?connected=1'),900);
      return;
    }
  }catch{}
  setTimeout(waitForConnection,2000);
}
if(!false) waitForConnection();
</script></main></body>`);
    }
    if (req.method === 'POST' && url.pathname === '/api/pairing-code') {
      if (connectedPhone || pairingRegistered) return json(res, 409, { error: 'O WhatsApp já está conectado.' });
      if (!socket || connectionState !== 'open') return json(res, 503, { error: 'O WhatsApp do StickerSom está reconectando. Aguarde alguns segundos e tente novamente ou use o QR Code.' });
      if (Date.now() - lastPairingRequest < 60_000) return json(res, 429, { error: 'Aguarde 1 minuto antes de solicitar outro código.' });
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      let phone = '';
      try { phone = String(JSON.parse(body).phone || '').replace(/\D/g, ''); } catch {}
      if (!/^\d{10,15}$/.test(phone)) return json(res, 400, { error: 'Informe o número com código do país, somente números.' });
      try {
        lastPairingRequest = Date.now();
        const code = await socket.requestPairingCode(phone);
        return json(res, 200, { ok: true, code });
      } catch (error) {
        console.error('[StickerSom] Falha ao gerar código de pareamento:', error);
        return json(res, 500, { error: 'O WhatsApp não conseguiu gerar o código. Tente pelo QR Code.' });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/create') {
      const ip = req.socket.remoteAddress || 'unknown';
      const now = Date.now(), bucket = rate.get(ip);
      if (bucket && bucket.reset > now && bucket.count >= 5) return json(res,429,{error:'Muitas criações. Aguarde um minuto.'});
      if (!bucket || bucket.reset < now) rate.set(ip,{count:1,reset:now+60_000}); else bucket.count++;
      const mode=url.searchParams.get('mode')||'video-original';
      if(!['image-audio','video-audio','video-original'].includes(mode))return json(res,400,{error:'Modo inválido.'});
      const duration=Math.min(10,Math.max(0.2,Number(url.searchParams.get('duration')||5)));
      const startSec=Math.max(0,Number(url.searchParams.get('start')||0));
      const chunks:Buffer[]=[];let total=0;
      for await(const chunk of req){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=b.length;if(total>MAX_INPUT_BYTES){json(res,413,{error:'O arquivo ultrapassa 16 MB.'});req.destroy();return;}chunks.push(b);}
      if(!total)return json(res,400,{error:'Selecione um arquivo.'});
      const input=Buffer.concat(chunks),type=String(req.headers['content-type']||'').toLowerCase();
      let visual;
      if(mode==='image-audio'){
        if(!type.startsWith('image/'))return json(res,415,{error:'Envie uma imagem ou GIF.'});
        visual=type.includes('gif')
          ? await createAnimatedSticker(input,{fit:'cortar',withAudio:false,durationSec:10,meta:{packName:'StickerSom',publisher:'StickerSom'}})
          : await createImageSoundSticker(input,{packName:'StickerSom',publisher:'StickerSom'});
      }else{
        if(!type.startsWith('video/'))return json(res,415,{error:'Envie um vídeo.'});
        visual=await createAnimatedSticker(input,{fit:'cortar',withAudio:mode==='video-original',startSec,durationSec:duration,meta:{packName:'StickerSom',publisher:'StickerSom'}});
      }
      if(mode==='video-original'){
        if(!visual.audio||visual.audioSilent)return json(res,422,{error:visual.audioSilent?'O trecho selecionado está sem áudio.':'Esse vídeo não tem áudio. Escolha outro modo ou outro vídeo.'});
        return json(res,200,makePending(visual.sticker,visual.audio,visual.durationMs));
      }
      cleanExpired();
      if(prepared.size>=100)return json(res,503,{error:'O serviço está cheio. Tente novamente em alguns minutos.'});
      const uploadId=randomBytes(18).toString('hex');
      prepared.set(uploadId,{sticker:visual.sticker,durationMs:visual.durationMs,expires:Date.now()+MAX_AGE});
      return json(res,200,{ok:true,uploadId});
    }
    if(req.method==='POST'&&url.pathname==='/api/attach-audio'){
      const id=url.searchParams.get('id')||'',item=prepared.get(id);
      if(!item||item.expires<Date.now()){prepared.delete(id);return json(res,404,{error:'Preparação expirada. Crie a figurinha novamente.'});}
      const chunks:Buffer[]=[];let total=0;
      for await(const chunk of req){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=b.length;if(total>MAX_INPUT_BYTES){json(res,413,{error:'O áudio ultrapassa 16 MB.'});req.destroy();return;}chunks.push(b);}
      if(!total)return json(res,400,{error:'Escolha um arquivo de áudio.'});
      const sound=await createAudioTrack(Buffer.concat(chunks),Math.min(10,item.durationMs/1000));
      if(sound.silent)return json(res,422,{error:'O áudio está em silêncio. Escolha outro arquivo.'});
      prepared.delete(id);
      return json(res,200,makePending(item.sticker,sound.audio,sound.durationMs));
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
