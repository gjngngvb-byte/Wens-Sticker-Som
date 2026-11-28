import { createServer } from 'node:http';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, type WAMessage } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import pino from 'pino';
import { createAnimatedSticker, createImageSoundSticker, createAudioTrack, getAudioDuration, MAX_INPUT_BYTES } from './src/convert.js';
import { sendSoundSticker } from './src/sound-sticker.js';

const PORT = Number(process.env.PORT || 3000);
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
const AUTH_DIR = process.env.AUTH_DIR || (existsSync('/var/data') ? '/var/data/stickersom-session' : './data/session');
const MAX_AGE = 15 * 60 * 1000;
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const ADMIN_PASSWORD = process.env.STICKERSOM_ADMIN_PASSWORD || '';
const ADMIN_SESSION_SECRET = process.env.STICKERSOM_ADMIN_SESSION_SECRET || ADMIN_PASSWORD;
const ADMIN_COOKIE = 'stickersom_admin';
const CATEGORIES = ['engracado','triste','amor','raiva','reacoes','fofo','jogos','filmes_series','musica','animais','troll','adulto','outros'];
type StickerMeta = { name: string; creatorName: string; info: string; category: string; isAdult: boolean; mediaType: 'image'|'gif'|'video' };
async function createEmbedding(meta: StickerMeta) {
  if (!OPENAI_API_KEY) return null;
  const input = [meta.name, meta.category, meta.info, meta.creatorName].filter(Boolean).join('. ').slice(0, 2000);
  const response = await fetch('https://api.openai.com/v1/embeddings', { method: 'POST', headers: { authorization: 'Bearer ' + OPENAI_API_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'text-embedding-3-small', input }) });
  if (!response.ok) throw new Error('Falha ao gerar embedding da figurinha.');
  const data = await response.json() as { data?: Array<{ embedding?: number[] }> };
  return data.data?.[0]?.embedding || null;
}
async function saveStickerEmbedding(id: string, meta: StickerMeta) {
  if (!OPENAI_API_KEY) return;
  try {
    const embedding = await createEmbedding(meta);
    if (!embedding) return;
    const headers = { ...serviceHeaders(), 'content-type': 'application/json', prefer: 'return=minimal' };
    await fetch(`${SUPABASE_URL}/rest/v1/stickers?id=eq.${encodeURIComponent(id)}`, { method: 'PATCH', headers, body: JSON.stringify({ embedding: `[${embedding.join(',')}]` }) });
  } catch (error) { console.error('[StickerSom] Embedding não salvo:', error); }
}
async function rpc(name: string, body: Record<string, unknown>) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers: { ...serviceHeaders(), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error('Não consegui consultar os dados de descoberta.');
  return response.json();
}
async function persistSticker(sticker: Buffer, audio: Buffer, meta: StickerMeta) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('O armazenamento permanente ainda não está configurado.');
  const id = randomBytes(16).toString('hex');
  const stickerPath = `${id}/sticker.webp`, audioPath = `${id}/audio.ogg`;
  const headers = { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` };
  const upload = async (path: string, data: Buffer, contentType: string) => {
    const response = await fetch(`${SUPABASE_URL}/storage/v1/object/stickersom-media/${path}`, { method: 'POST', headers: { ...headers, 'content-type': contentType, 'x-upsert': 'false' }, body: new Uint8Array(data) });
    if (!response.ok) throw new Error(`Falha ao salvar mídia (${response.status}).`);
  };
  await upload(stickerPath, sticker, 'image/webp');
  try { await upload(audioPath, audio, 'audio/ogg'); } catch (error) { await fetch(`${SUPABASE_URL}/storage/v1/object/stickersom-media/${stickerPath}`, { method: 'DELETE', headers }); throw error; }
  const record = { name: meta.name, site_name: 'StickerSom', creator_name: meta.creatorName || null, info: meta.info || null, category: meta.category, is_adult: meta.isAdult, media_type: meta.mediaType, media_path: stickerPath, audio_path: audioPath };
  const response = await fetch(`${SUPABASE_URL}/rest/v1/stickers`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json', prefer: 'return=representation' }, body: JSON.stringify(record) });
  if (!response.ok) throw new Error(`Falha ao registrar figurinha (${response.status}).`);
  const saved = (await response.json())[0];
  await saveStickerEmbedding(saved.id, meta);
  return saved;
}
async function listStickers(category = '') {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Galeria indisponível no momento.');
  const params = new URLSearchParams({ select: '*', order: 'created_at.desc', limit: '100' });
  params.set('status', 'eq.active');
  if (category === 'adulto') params.set('is_adult', 'eq.true'); else if (category && CATEGORIES.includes(category)) params.set('category', `eq.${category}`);
  const response = await fetch(`${SUPABASE_URL}/rest/v1/stickers?${params}`, { headers: { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` } });
  if (!response.ok) throw new Error('Não consegui carregar a galeria.');
  return (await response.json()).map((item: any) => ({ ...item, media_url: `${SUPABASE_URL}/storage/v1/object/public/stickersom-media/${item.media_path}`, audio_url: item.audio_path ? `${SUPABASE_URL}/storage/v1/object/public/stickersom-media/${item.audio_path}` : null }));
}
const pending = new Map<string, { sticker: Buffer; audio: Buffer; durationMs: number; expires: number }>();
const prepared = new Map<string, { sticker: Buffer; source: Buffer; startSec: number; durationMs: number; videoDurationSec: number; expires: number; meta: StickerMeta }>();
let socket: ReturnType<typeof makeWASocket> | undefined;
let qrDataUrl = '';
let connectedPhone = '';
let connectionState: 'connecting' | 'open' | 'close' = 'connecting';
let pairingRegistered = false;
let pairingReady = false;
let lastPairingRequest = 0;
let reconnectTimer: NodeJS.Timeout | undefined;
let resettingSession = false;
let resetInProgress = false;
const rate = new Map<string, { count: number; reset: number }>();

function adminSignature(payload: string) { return createHmac('sha256', ADMIN_SESSION_SECRET).update(payload).digest('hex'); }
function adminCookieToken() { const payload = String(Date.now() + 12 * 60 * 60 * 1000); return payload + '.' + adminSignature(payload); }
function isAdmin(req: import('node:http').IncomingMessage) {
  if (!ADMIN_PASSWORD || !ADMIN_SESSION_SECRET) return false;
  const raw = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(ADMIN_COOKIE + '='));
  if (!raw) return false;
  const parts = decodeURIComponent(raw.slice(ADMIN_COOKIE.length + 1)).split('.');
  if (parts.length !== 2 || !/^\d+$/.test(parts[0]) || Number(parts[0]) < Date.now()) return false;
  const expected = adminSignature(parts[0]);
  return parts[1].length === expected.length && timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected));
}
function serviceHeaders() { if (!SUPABASE_SERVICE_KEY) throw new Error('Configure SUPABASE_SERVICE_ROLE_KEY no servidor para habilitar a administração.'); return { apikey: SUPABASE_SERVICE_KEY, authorization: 'Bearer ' + SUPABASE_SERVICE_KEY }; }
async function permanentlyDeleteSticker(id: string) {
  const headers = serviceHeaders();
  const lookup = await fetch(SUPABASE_URL + '/rest/v1/stickers?select=id,media_path,audio_path&id=eq.' + encodeURIComponent(id) + '&limit=1', { headers });
  if (!lookup.ok) throw new Error('Não consegui localizar a figurinha para apagar.');
  const rows = await lookup.json() as Array<{id:string;media_path:string;audio_path:string|null}>;
  if (!rows.length) throw new Error('Figurinha não encontrada.');
  for (const path of [rows[0].media_path, rows[0].audio_path].filter(Boolean)) { const removed = await fetch(SUPABASE_URL + '/storage/v1/object/stickersom-media/' + path, { method:'DELETE', headers }); if (!removed.ok && removed.status !== 404) throw new Error('Não consegui remover os arquivos da figurinha.'); }
  const deleted = await fetch(SUPABASE_URL + '/rest/v1/stickers?id=eq.' + encodeURIComponent(id), { method:'DELETE', headers });
  if (!deleted.ok) throw new Error('Não consegui apagar o registro da figurinha.');
}
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
async function makePending(sticker: Buffer, audio: Buffer, durationMs: number, meta: StickerMeta) {
  cleanExpired();
  if (pending.size >= 100) throw new Error('O serviço está cheio. Tente novamente em alguns minutos.');
  let code = makeCode(); while (pending.has(code)) code = makeCode();
  const saved = await persistSticker(sticker, audio, meta);
  code = 'SS-' + String(saved.id).slice(-6).toUpperCase();
  pending.set(code, { sticker, audio, durationMs, expires: Date.now() + MAX_AGE });
  console.log('[StickerSom] Figurinha criada e salva na galeria:', code, 'WhatsApp conectado:', !!connectedPhone);
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
    if (qr) {
      pairingReady = true;
      qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
      console.log('[StickerSom] Novo QR Code de pareamento disponível.');
    }
    if (connection === 'open') {
      pairingReady = false;
      connectionState = 'open';
      pairingRegistered = true;
      qrDataUrl = '';
      connectedPhone = current.user?.id?.split(':')[0]?.split('@')[0] || '';
      console.log('[StickerSom] WhatsApp conectado:', connectedPhone);
    }
    if (connection === 'close' && socket === current) {
      pairingReady = false;
      connectionState = 'close';
      connectedPhone = '';
      if (resettingSession) return;
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
      const isOwnChat = (!!ownNumber && (chatNumber === ownNumber || alternateNumber === ownNumber)) || (msg.key.fromMe === true && remoteJid.endsWith('@lid'));
      const isDirectChat = remoteJid.endsWith('@s.whatsapp.net') || remoteJid.endsWith('@lid');
      // Aceita PN e LID no chat consigo mesmo, sem processar mensagens enviadas a terceiros.
      if (!msg.message || !isDirectChat || (msg.key.fromMe && !isOwnChat)) continue;
      const code = messageText(msg).trim().toUpperCase();
      if (!/^SS-[A-F0-9]{6}$/.test(code)) continue;
      console.log('[StickerSom] Código de figurinha recebido na conversa:', remoteJid, 'selfChat:', isOwnChat);
      cleanExpired();
      let item = pending.get(code);
      try {
        if (item) {
          await sendSoundSticker(current, msg.key.remoteJid, { sticker: item.sticker, audio: item.audio, durationMs: item.durationMs });
          pending.delete(code);
        } else {
          const suffix = code.slice(3).toLowerCase();
          const headers = { apikey: SUPABASE_KEY, authorization: `Bearer ${SUPABASE_KEY}` };
          const lookup = await fetch(`${SUPABASE_URL}/rest/v1/stickers?select=media_path,audio_path&id=like.*${suffix}&status=eq.active&limit=2`, { headers });
          const rows = lookup.ok ? await lookup.json() as Array<{media_path:string;audio_path:string}> : [];
          if (rows.length !== 1) throw new Error(rows.length ? 'Código duplicado. Gere outra figurinha.' : 'Código não encontrado.');
          const row = rows[0];
          const [visual, audio] = await Promise.all([
            fetch(`${SUPABASE_URL}/storage/v1/object/public/stickersom-media/${row.media_path}`),
            fetch(`${SUPABASE_URL}/storage/v1/object/public/stickersom-media/${row.audio_path}`)
          ]);
          if (!visual.ok || !audio.ok) throw new Error('Não consegui baixar a mídia.');
          await sendSoundSticker(current, msg.key.remoteJid, { sticker: Buffer.from(await visual.arrayBuffer()), audio: Buffer.from(await audio.arrayBuffer()), durationMs: 10000 });
        }
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
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      if (!ADMIN_PASSWORD || !ADMIN_SESSION_SECRET) return json(res,503,{error:'Acesso administrativo ainda não configurado no servidor.'});
      let body=''; for await (const chunk of req) body += chunk.toString(); let password=''; try { password=String(JSON.parse(body).password || ''); } catch {}
      const a=Buffer.from(password), b=Buffer.from(ADMIN_PASSWORD); if(a.length!==b.length || !timingSafeEqual(a,b)) return json(res,401,{error:'Senha incorreta.'});
      res.setHeader('Set-Cookie', ADMIN_COOKIE+'='+adminCookieToken()+'; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200'); return json(res,200,{ok:true,admin:true});
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/logout') { res.setHeader('Set-Cookie',ADMIN_COOKIE+'=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0'); return json(res,200,{ok:true}); }
    if (req.method === 'GET' && url.pathname === '/api/admin/status') return json(res,200,{admin:isAdmin(req)});
    if (req.method === 'POST' && url.pathname === '/api/delete-request') {
      let body=''; for await (const chunk of req) body += chunk.toString(); let id=''; try{id=String(JSON.parse(body).id||'');}catch{}
      if(!/^[0-9a-f-]{36}$/i.test(id)) return json(res,400,{error:'Figurinha inválida.'});
      const headers={apikey:SUPABASE_KEY,authorization:'Bearer '+SUPABASE_KEY,'content-type':'application/json',prefer:'return=minimal'};
      const check=await fetch(SUPABASE_URL+'/rest/v1/stickers?select=id&id=eq.'+encodeURIComponent(id)+'&limit=1',{headers}); if(!check.ok || !(await check.json()).length) return json(res,404,{error:'Figurinha não encontrada.'});
      const saved=await fetch(SUPABASE_URL+'/rest/v1/sticker_delete_requests',{method:'POST',headers,body:JSON.stringify({sticker_id:id})}); if(!saved.ok) throw new Error('Não consegui registrar a solicitação. Tente novamente.');
      const quarantine=await fetch(SUPABASE_URL+'/rest/v1/stickers?id=eq.'+encodeURIComponent(id),{method:'PATCH',headers:{...serviceHeaders(),'content-type':'application/json','prefer':'return=minimal'},body:JSON.stringify({status:'quarantined'})});
      if(!quarantine.ok) throw new Error('O pedido foi registrado, mas não consegui colocar a figurinha em quarentena.');
      return json(res,200,{ok:true});
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/stats') {
      if (!isAdmin(req)) return json(res,401,{error:'Acesso restrito ao administrador.'});
      return json(res,200,{ok:true,stats:await rpc('stickersom_admin_stats',{})});
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/feature') {
      if (!isAdmin(req)) return json(res,401,{error:'Acesso restrito ao administrador.'});
      let body=''; for await (const chunk of req) body+=chunk.toString(); let id='',featured=false;
      try { const b=JSON.parse(body); id=String(b.id||''); featured=!!b.featured; } catch {}
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json(res,400,{error:'Figurinha inválida.'});
      const result=await fetch(SUPABASE_URL+'/rest/v1/stickers?id=eq.'+encodeURIComponent(id),{method:'PATCH',headers:{...serviceHeaders(),'content-type':'application/json','prefer':'return=representation'},body:JSON.stringify({is_featured:featured})});
      if(!result.ok) throw new Error('Não consegui atualizar a vitrine ADM.');
      return json(res,200,{ok:true,featured});
    }
    if (req.method === 'POST' && url.pathname === '/api/events') {
      let body=''; for await (const chunk of req) body+=chunk.toString();
      let stickerId='',visitorId='',eventType='';
      try { const b=JSON.parse(body); stickerId=String(b.stickerId||''); visitorId=String(b.visitorId||''); eventType=String(b.eventType||''); } catch {}
      if(!/^[0-9a-f-]{36}$/i.test(stickerId) || !/^[a-zA-Z0-9_-]{12,80}$/.test(visitorId) || !['view','select','send','favorite'].includes(eventType)) return json(res,400,{error:'Evento inválido.'});
      const saved=await fetch(SUPABASE_URL+'/rest/v1/sticker_events',{method:'POST',headers:{...serviceHeaders(),'content-type':'application/json','prefer':'return=minimal'},body:JSON.stringify({sticker_id:stickerId,visitor_id:visitorId,event_type:eventType})});
      if(!saved.ok) throw new Error('Não consegui registrar a interação.');
      return json(res,200,{ok:true});
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/requests') {
      if(!isAdmin(req)) return json(res,401,{error:'Acesso restrito ao administrador.'}); const headers=serviceHeaders();
      const r=await fetch(SUPABASE_URL+'/rest/v1/sticker_delete_requests?select=id,sticker_id,requester_note,status,created_at,stickers(name,category)&order=created_at.desc',{headers}); if(!r.ok) throw new Error('Não consegui carregar as solicitações.'); return json(res,200,{ok:true,requests:await r.json()});
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/delete') {
      if(!isAdmin(req)) return json(res,401,{error:'Acesso restrito ao administrador.'}); let body=''; for await (const chunk of req) body+=chunk.toString(); let id='',requestId=''; try{const b=JSON.parse(body);id=String(b.id||'');requestId=String(b.requestId||'');}catch{}
      if(!/^[0-9a-f-]{36}$/i.test(id)) return json(res,400,{error:'Figurinha inválida.'}); await permanentlyDeleteSticker(id);
      if(/^[0-9a-f-]{36}$/i.test(requestId)) await fetch(SUPABASE_URL+'/rest/v1/sticker_delete_requests?id=eq.'+encodeURIComponent(requestId),{method:'PATCH',headers:{...serviceHeaders(),'content-type':'application/json'},body:JSON.stringify({status:'approved',resolved_at:new Date().toISOString()})}); return json(res,200,{ok:true});
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/restore') {
      if(!isAdmin(req)) return json(res,401,{error:'Acesso restrito ao administrador.'}); let body=''; for await(const chunk of req) body+=chunk.toString(); let id='',requestId=''; try{const b=JSON.parse(body);id=String(b.id||'');requestId=String(b.requestId||'');}catch{}
      if(!/^[0-9a-f-]{36}$/i.test(id)) return json(res,400,{error:'Figurinha inválida.'});
      const restored=await fetch(SUPABASE_URL+'/rest/v1/stickers?id=eq.'+encodeURIComponent(id),{method:'PATCH',headers:{...serviceHeaders(),'content-type':'application/json','prefer':'return=representation'},body:JSON.stringify({status:'active'})});
      if(!restored.ok) throw new Error('Não consegui restaurar a figurinha.'); const rows=await restored.json(); if(!rows.length) return json(res,404,{error:'Figurinha não encontrada.'});
      if(/^[0-9a-f-]{36}$/i.test(requestId)) await fetch(SUPABASE_URL+'/rest/v1/sticker_delete_requests?id=eq.'+encodeURIComponent(requestId),{method:'PATCH',headers:{...serviceHeaders(),'content-type':'application/json'},body:JSON.stringify({status:'rejected',resolved_at:new Date().toISOString()})});
      return json(res,200,{ok:true});
    }
    if (req.method === 'POST' && url.pathname === '/api/admin/reject') {
      if(!isAdmin(req)) return json(res,401,{error:'Acesso restrito ao administrador.'}); let body=''; for await (const chunk of req) body+=chunk.toString(); let id=''; try{id=String(JSON.parse(body).id||'');}catch{}
      if(!/^[0-9a-f-]{36}$/i.test(id)) return json(res,400,{error:'Solicitação inválida.'}); const r=await fetch(SUPABASE_URL+'/rest/v1/sticker_delete_requests?id=eq.'+encodeURIComponent(id),{method:'PATCH',headers:{...serviceHeaders(),'content-type':'application/json'},body:JSON.stringify({status:'rejected',resolved_at:new Date().toISOString()})}); if(!r.ok) throw new Error('Não consegui recusar a solicitação.'); return json(res,200,{ok:true});
    }
    if (req.method === 'POST' && url.pathname === '/api/send-created') {
      if (!socket || !connectedPhone) return json(res,409,{error:'Conecte o WhatsApp antes de enviar.'});
      let body=''; for await(const chunk of req) body+=chunk.toString();
      let code=''; try{code=String(JSON.parse(body).code||'').toUpperCase();}catch{}
      const item=pending.get(code);
      if(!item)return json(res,404,{error:'Esta criação não está mais na fila de envio. Ela continua salva na galeria.'});
      await sendSoundSticker(socket,`${connectedPhone}@s.whatsapp.net`,{sticker:item.sticker,audio:item.audio,durationMs:item.durationMs});
      pending.delete(code);
      return json(res,200,{ok:true});
    }
    if (req.method === 'POST' && url.pathname === '/api/send-sticker') {
      if (!socket || !connectedPhone) return json(res,409,{error:'Conecte o WhatsApp antes de enviar.'});
      let body=''; for await(const chunk of req) body+=chunk.toString();
      let id=''; try{id=String(JSON.parse(body).id||'');}catch{}
      if(!/^[0-9a-f-]{36}$/i.test(id))return json(res,400,{error:'Figurinha inválida.'});
      const headers={apikey:SUPABASE_KEY,authorization:`Bearer ${SUPABASE_KEY}`};
      const lookup=await fetch(`${SUPABASE_URL}/rest/v1/stickers?select=media_path,audio_path&id=eq.${encodeURIComponent(id)}&status=eq.active&limit=1`,{headers});
      if(!lookup.ok)throw new Error('Não consegui localizar a figurinha.');
      const rows=await lookup.json() as Array<{media_path:string;audio_path:string}>;
      if(!rows.length)return json(res,404,{error:'Figurinha não encontrada.'});
      const row=rows[0];
      const [visual,audio]=await Promise.all([fetch(`${SUPABASE_URL}/storage/v1/object/public/stickersom-media/${row.media_path}`),fetch(`${SUPABASE_URL}/storage/v1/object/public/stickersom-media/${row.audio_path}`)]);
      if(!visual.ok||!audio.ok)throw new Error('Falha ao baixar a mídia da galeria.');
      await sendSoundSticker(socket,`${connectedPhone}@s.whatsapp.net`,{sticker:Buffer.from(await visual.arrayBuffer()),audio:Buffer.from(await audio.arrayBuffer()),durationMs:10000});
      return json(res,200,{ok:true});
    }
    if (req.method === 'POST' && url.pathname === '/api/send-package') {
      if (!socket || !connectedPhone) return json(res, 409, { error: 'Conecte o WhatsApp antes de enviar.' });
      let body=''; for await (const chunk of req) body += chunk.toString();
      let ids:string[]=[]; try { ids=JSON.parse(body).ids; } catch {}
      if (!Array.isArray(ids) || !ids.length || ids.length>50 || ids.some(x=>typeof x!=='string')) return json(res,400,{error:'Selecione de 1 a 50 figurinhas.'});
      const headers={apikey:SUPABASE_KEY,authorization:`Bearer ${SUPABASE_KEY}`};
      const query=new URLSearchParams({select:'id,media_path,audio_path',id:`in.(${ids.join(',')})`});
      const rowsResponse=await fetch(`${SUPABASE_URL}/rest/v1/stickers?${query}`,{headers});
      if(!rowsResponse.ok)throw new Error('Não consegui localizar as figurinhas selecionadas.');
      const rows=await rowsResponse.json() as Array<{id:string;media_path:string;audio_path:string}>;
      if(rows.length!==ids.length)return json(res,404,{error:'Uma ou mais figurinhas não foram encontradas.'});
      let sent=0;
      for(const row of rows){
        const [visual,audio]=await Promise.all([fetch(`${SUPABASE_URL}/storage/v1/object/${'public'}/stickersom-media/${row.media_path}`),fetch(`${SUPABASE_URL}/storage/v1/object/public/stickersom-media/${row.audio_path}`)]);
        if(!visual.ok||!audio.ok)throw new Error('Falha ao baixar uma mídia da galeria.');
        await sendSoundSticker(socket,`${connectedPhone}@s.whatsapp.net`,{sticker:Buffer.from(await visual.arrayBuffer()),audio:Buffer.from(await audio.arrayBuffer()),durationMs:10000});
        sent++;
      }
      return json(res,200,{ok:true,sent});
    }
    if (req.method === 'GET' && url.pathname === '/api/gallery') {
      const category = url.searchParams.get('category') || '';
      const section = url.searchParams.get('section') || 'all';
      let stickers:any[] = await listStickers(category);
      if (section === 'featured') stickers = stickers.filter((s:any) => s.is_featured);
      else if (section === 'trending' || section === 'spotlight') {
        const ranked:any[] = await rpc('stickersom_trending',{p_days:section==='spotlight'?14:30,p_limit:30});
        const rank = new Map(ranked.map((x:any)=>[String(x.sticker_id),Number(x.score)]));
        stickers = stickers.filter((s:any)=>rank.has(String(s.id))).sort((a:any,b:any)=>(rank.get(String(b.id))||0)-(rank.get(String(a.id))||0));
        if(section==='spotlight') stickers=stickers.slice(0,12);
      } else if (section === 'recommended') {
        const visitorId = url.searchParams.get('visitorId') || '';
        if (/^[a-zA-Z0-9_-]{12,80}$/.test(visitorId)) {
          const ranked:any[] = await rpc('stickersom_recommended',{p_visitor_id:visitorId,p_limit:30});
          const rank = new Map(ranked.map((x:any)=>[String(x.sticker_id),Number(x.score)]));
          stickers = stickers.filter((s:any)=>rank.has(String(s.id))).sort((a:any,b:any)=>(rank.get(String(b.id))||0)-(rank.get(String(a.id))||0));
        } else stickers=[];
      } else if (section === 'similar') {
        const sourceId = url.searchParams.get('stickerId') || '';
        const all = await listStickers();
        const source:any = all.find((s:any)=>String(s.id)===sourceId);
        if (!source) stickers=[];
        else if (source.embedding) {
          const ranked:any[] = await rpc('stickersom_similar',{p_embedding:source.embedding,p_exclude:source.id,p_limit:12});
          const ids=ranked.map((x:any)=>String(x.sticker_id));
          stickers=ids.map(id=>all.find((s:any)=>String(s.id)===id)).filter(Boolean);
        } else {
          const words=new Set(String(source.name+' '+(source.info||'')).toLowerCase().split(/[^a-z0-9áéíóúãõç]+/).filter((x:string)=>x.length>3));
          stickers=all.filter((s:any)=>s.id!==source.id).map((s:any)=>({s,score:(s.category===source.category?4:0)+String(s.name+' '+(s.info||'')).toLowerCase().split(/[^a-z0-9áéíóúãõç]+/).filter((x:string)=>words.has(x)&&x.length>3).length})).filter((x:any)=>x.score>0).sort((a:any,b:any)=>b.score-a.score).map((x:any)=>x.s).slice(0,12);
        }
      }
      return json(res, 200, { ok: true, stickers });
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return json(res, 200, { ok: true, connected: !!connectedPhone, phone: connectedPhone, connectionState });
    }
    if (req.method === 'GET' && url.pathname === '/api/qr') {
      return json(res, 200, { ok: true, qr: qrDataUrl, connected: !!connectedPhone });
    }
    if (req.method === 'GET' && url.pathname === '/pair') {
      if (!isAdmin(req)) { res.writeHead(302,{location:'/gallery'}); return res.end(); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conectar WhatsApp | StickerSom</title><body style="margin:0;background:var(--bg);color:var(--ink);font:16px system-ui"><link rel="stylesheet" href="/styles.css"><header class="top"><div class="top-left"><button class="menu-trigger" id="menuOpen" aria-label="Abrir menu">☰</button><div class="drawer-backdrop" id="drawerBackdrop" hidden></div><aside class="side-drawer" id="sideDrawer" aria-label="Menu principal" aria-hidden="true"><div class="drawer-head"><b>StickerSom</b><button id="menuClose" aria-label="Fechar menu">×</button></div><a href="/gallery">▦ Galeria</a><a href="/">✦ Criar figurinhas</a><a href="/gallery#selected">✓ Selecionados</a><a href="/pair" id="adminConnectLink" hidden>⌁ Conectar WhatsApp</a><details class="drawer-tools"><summary>🧰 Ferramentas</summary><div class="drawer-tool-links"><a href="https://noadsdl.com/" target="_blank" rel="noopener noreferrer">▶ Baixar vídeos do YouTube ↗</a><a href="https://www.myinstants.com/pt/index/br/" target="_blank" rel="noopener noreferrer">♫ Baixar efeitos sonoros ↗</a><a href="https://snapinsta.com.br/" target="_blank" rel="noopener noreferrer">◎ Baixar conteúdo do Instagram ↗</a><a href="https://snaptik.fi/pt" target="_blank" rel="noopener noreferrer">♪ Baixar vídeos do TikTok ↗</a><a href="https://giphy.com/explore/imagens" target="_blank" rel="noopener noreferrer">▧ Baixar GIFs ↗</a></div></details><div class="drawer-admin-area"><button id="adminLogin" class="drawer-admin">♙ Administrador</button><a href="/gallery#adminRequests" id="adminRequestsLink" hidden>▤ Solicitações de exclusão</a><button id="adminLogout" class="drawer-admin" hidden>Sair da administração</button></div></aside></div><a class="brand" href="/"><span class="brand-mark">♪</span><span>sticker<strong>som</strong></span></a><a class="online connect-button" id="connection" href="/pair" hidden>⌁ Conectar WhatsApp</a></header><main style="max-width:420px;width:100%"><h2>Conectar WhatsApp StickerSom</h2><p id="state">${connectedPhone ? 'WhatsApp já conectado: +' + connectedPhone : 'Escolha uma forma de conexão'}</p><section style="background:#201e29;padding:18px;border-radius:16px;margin:18px 0"><h3>Por código</h3><p>Digite o número que será conectado, com código do país. Ex.: 5511999999999</p><input id="phone" inputmode="numeric" autocomplete="tel" placeholder="5511999999999" style="box-sizing:border-box;width:100%;padding:14px;border-radius:9px;border:0;font-size:17px"><button id="request" style="margin-top:12px;width:100%;padding:14px;border:0;border-radius:9px;background:#9c6bff;color:white;font-weight:700;font-size:16px">Gerar código de pareamento</button><h1 id="paircode" style="letter-spacing:5px"></h1><p id="message" aria-live="polite">No WhatsApp: Aparelhos conectados → Conectar aparelho → Conectar com número de telefone</p></section><section style="background:#201e29;padding:18px;border-radius:16px"><h3>Ou use QR Code</h3><img id="qrImage" width="280" style="max-width:100%;display:none" alt="QR Code para conectar WhatsApp"><p id="qrHint">Aguardando QR Code…</p><p>WhatsApp → Aparelhos conectados → Conectar aparelho</p></section><section style="background:#201e29;padding:18px;border-radius:16px;margin-top:18px"><h3>Problemas de conexão?</h3><p>Limpe a sessão salva e conecte o WhatsApp novamente.</p><button id="resetSession" style="width:100%;padding:14px;border:0;border-radius:9px;background:#a33b3b;color:white;font-weight:700;font-size:15px">Desconectar e limpar sessão</button><p id="resetMessage" aria-live="polite"></p></section><script>document.getElementById('phone').addEventListener('input',e=>{const el=e.target;const digits=el.value.replace(/[^0-9]/g,'');if(el.value!==digits)el.value=digits;});
document.getElementById('request').onclick=async()=>{const phone=document.getElementById('phone').value.replace(/[^0-9]/g,'');const msg=document.getElementById('message');const btn=document.getElementById('request');document.getElementById('paircode').textContent='';msg.textContent='Solicitando código…';btn.disabled=true;try{const r=await fetch('/api/pairing-code',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phone})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Não foi possível gerar o código.');document.getElementById('paircode').textContent=d.code;msg.textContent='No celular, abra Aparelhos conectados → Conectar aparelho → Conectar com número de telefone e digite este código.'}catch(e){msg.textContent=e.message}finally{btn.disabled=false}};</script><script>
const state=document.getElementById('state');
const qrImage=document.getElementById('qrImage');
const qrHint=document.getElementById('qrHint');
async function refreshQr(){try{const r=await fetch('/api/qr',{cache:'no-store'});const d=await r.json();if(d.qr){qrImage.src=d.qr;qrImage.style.display='inline-block';qrHint.textContent='Leia este código com o WhatsApp.';}else if(!d.connected){qrImage.style.display='none';qrHint.textContent='Aguardando o WhatsApp disponibilizar o QR Code…';}}catch{}setTimeout(refreshQr,2000);}
refreshQr();
document.getElementById('resetSession').onclick=async()=>{
  if(!confirm('Isso vai desconectar o WhatsApp do StickerSom e apagar a sessão salva neste servidor. Depois será necessário conectar novamente pelo QR Code ou código. Continuar?'))return;
  const btn=document.getElementById('resetSession'),msg=document.getElementById('resetMessage');
  btn.disabled=true;msg.textContent='Limpando sessão e reiniciando conexão…';
  try{
    const r=await fetch('/api/reset-session',{method:'POST'});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Não foi possível limpar a sessão.');
    document.getElementById('paircode').textContent='';
    document.getElementById('message').textContent='Sessão limpa. Aguarde o QR Code e conecte novamente.';
    msg.textContent='Sessão apagada. O QR Code será atualizado em instantes.';
  }catch(e){msg.textContent=e.message;btn.disabled=false;}
};
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
</script><script src="/menu.js"></script></main></body>`);
    }
    if (req.method === 'POST' && url.pathname === '/api/reset-session') {
      if (!isAdmin(req)) return json(res,401,{error:'Acesso restrito ao administrador.'});
      if (resetInProgress) return json(res, 409, { error: 'A limpeza da sessão já está em andamento.' });
      resetInProgress = true;
      resettingSession = true;
      clearTimeout(reconnectTimer);
      connectedPhone = '';
      pairingRegistered = false;
      pairingReady = false;
      connectionState = 'connecting';
      qrDataUrl = '';
      try {
        const oldSocket = socket;
        socket = undefined;
        if (oldSocket) {
          try { oldSocket.end(new Error('Sessão reiniciada pelo painel StickerSom')); } catch {}
        }
        await rm(AUTH_DIR, { recursive: true, force: true });
        await mkdir(AUTH_DIR, { recursive: true });
        pending.clear();
        prepared.clear();
        console.log('[StickerSom] Sessão WhatsApp apagada manualmente.');
        setTimeout(() => {
          resettingSession = false;
          void connect().catch(error => {
            connectionState = 'close';
            console.error('[StickerSom] Falha ao iniciar novo pareamento:', error);
          });
        }, 700);
        return json(res, 200, { ok: true, message: 'Sessão apagada. Conecte novamente pelo QR Code.' });
      } catch (error) {
        resettingSession = false;
        connectionState = 'close';
        throw error;
      } finally {
        resetInProgress = false;
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/pairing-code') {
      if (!isAdmin(req)) return json(res,401,{error:'Acesso restrito ao administrador.'});
      if (connectedPhone || pairingRegistered) return json(res, 409, { error: 'O WhatsApp já está conectado. Limpe a sessão antes de gerar um novo pareamento.' });
      let body = '';
      for await (const chunk of req) body += chunk.toString();
      let phone = '';
      try { phone = String(JSON.parse(body).phone || '').replace(/\D/g, ''); } catch {}
      if (!/^\d{10,15}$/.test(phone)) return json(res, 400, { error: 'Informe o número com código do país, somente números.' });
      if (Date.now() - lastPairingRequest < 60_000) return json(res, 429, { error: 'Aguarde 1 minuto antes de solicitar outro código.' });

      // Um aparelho ainda não pareado nunca chega ao estado "open".
      // A prontidão para pareamento é indicada pelo evento QR do Baileys.
      const deadline = Date.now() + 15000;
      while ((!socket || !pairingReady) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!socket || !pairingReady || pairingRegistered || connectedPhone) {
        return json(res, 503, { error: 'O novo pareamento ainda está sendo preparado. Aguarde o QR Code aparecer e tente gerar o código novamente.' });
      }
      try {
        lastPairingRequest = Date.now();
        const code = await socket.requestPairingCode(phone);
        return json(res, 200, { ok: true, code });
      } catch (error) {
        console.error('[StickerSom] Falha ao gerar código de pareamento:', error);
        return json(res, 500, { error: 'O WhatsApp recusou a geração do código. Atualize a página e tente novamente.' });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/create') {
      const ip = req.socket.remoteAddress || 'unknown';
      const now = Date.now(), bucket = rate.get(ip);
      if (bucket && bucket.reset > now && bucket.count >= 5) return json(res,429,{error:'Muitas criações. Aguarde um minuto.'});
      if (!bucket || bucket.reset < now) rate.set(ip,{count:1,reset:now+60_000}); else bucket.count++;
      const mode=url.searchParams.get('mode')||'video-original';
      const meta: StickerMeta = { name: (url.searchParams.get('name') || '').trim().slice(0,120), creatorName: (url.searchParams.get('creator') || '').trim().slice(0,80), info: (url.searchParams.get('info') || '').trim().slice(0,500), category: url.searchParams.get('category') || '', isAdult: url.searchParams.get('isAdult') === 'true', mediaType: mode === 'image-audio' ? (String(req.headers['content-type']||'').includes('gif') ? 'gif' : 'image') : 'video' };
      if (!meta.name) return json(res,400,{error:'Dê um nome para a figurinha.'});
      if (!CATEGORIES.includes(meta.category)) return json(res,400,{error:'Escolha uma categoria válida.'});
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
        return json(res,200,await makePending(visual.sticker,visual.audio,visual.durationMs,meta));
      }
      cleanExpired();
      if(prepared.size>=100)return json(res,503,{error:'O serviço está cheio. Tente novamente em alguns minutos.'});
      const uploadId=randomBytes(18).toString('hex');
      prepared.set(uploadId,{sticker:visual.sticker,source:input,startSec,durationMs:visual.durationMs,videoDurationSec:visual.durationMs/1000,expires:Date.now()+MAX_AGE,meta});
      return json(res,200,{ok:true,uploadId});
    }
    if(req.method==='POST'&&url.pathname==='/api/attach-audio'){
      const id=url.searchParams.get('id')||'',item=prepared.get(id);
      if(!item||item.expires<Date.now()){prepared.delete(id);return json(res,404,{error:'Preparação expirada. Crie a figurinha novamente.'});}
      const chunks:Buffer[]=[];let total=0;
      for await(const chunk of req){const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);total+=b.length;if(total>MAX_INPUT_BYTES){json(res,413,{error:'O áudio ultrapassa 16 MB.'});req.destroy();return;}chunks.push(b);}
      if(!total)return json(res,400,{error:'Escolha um arquivo de áudio.'});
      const audioInput=Buffer.concat(chunks);
      const audioDuration=await getAudioDuration(audioInput);
      const finalDuration=Math.min(10,Math.max(item.videoDurationSec,audioDuration));
      let finalSticker=item.sticker;
      if(finalDuration>item.videoDurationSec+0.03){
        const extended=await createAnimatedSticker(item.source,{fit:'cortar',startSec:item.startSec,durationSec:finalDuration,loopVideo:true,meta:{packName:'StickerSom',publisher:'StickerSom'}});
        finalSticker=extended.sticker;
      }
      const sound=await createAudioTrack(audioInput,finalDuration,audioDuration+0.02<finalDuration);
      if(sound.silent)return json(res,422,{error:'O áudio está em silêncio. Escolha outro arquivo.'});
      prepared.delete(id);
      return json(res,200,await makePending(finalSticker,sound.audio,Math.round(finalDuration*1000),(item as any).meta));
    }
    if (req.method === 'GET' && url.pathname === '/gallery') { const page=await readFile('gallery.html'); res.writeHead(200,{'content-type':'text/html; charset=utf-8'}); return res.end(page); }
    if (req.method === 'GET' && url.pathname === '/') {
      const html = await readFile('index.html');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
    }
    if (req.method === 'GET' && ['/app.js','/styles.css','/menu.js','/gallery.js'].includes(url.pathname)) {
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
