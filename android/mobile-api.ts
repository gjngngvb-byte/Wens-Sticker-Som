import { createServer } from 'node:http';
import type { WASocket } from '@whiskeysockets/baileys';
import { createAnimatedSticker, MAX_INPUT_BYTES } from './convert.js';
import { sendSoundSticker } from './sound-sticker.js';

let started = false;

/** API restrita ao loopback: o app Android e o Termux compartilham localhost no mesmo aparelho. */
export function startMobileApi(getSocket: () => WASocket): void {
  if (started) return;
  started = true;
  const server = createServer(async (req, res) => {
    const json = (status: number, body: object) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET' && req.method !== 'POST') return json(405, { error: 'Método não permitido.' });
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/health') return json(200, { ok: true, service: 'StickerSom' });
    if (req.method !== 'POST' || url.pathname !== '/sticker') return json(404, { error: 'Rota não encontrada.' });

    const phone = (url.searchParams.get('to') ?? '').replace(/\D/g, '');
    if (phone.length < 8 || phone.length > 15) return json(400, { error: 'Número de destino inválido. Use DDI + DDD + número.' });
    const startMs = Number(url.searchParams.get('start') ?? 0);
    const durationMs = Number(url.searchParams.get('duration') ?? 10000);
    if (!Number.isFinite(startMs) || startMs < 0 || !Number.isFinite(durationMs) || durationMs < 200 || durationMs > 10000)
      return json(400, { error: 'Trecho inválido. A duração máxima é 10 segundos.' });

    try {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of req) {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += part.length;
        if (total > MAX_INPUT_BYTES) { req.destroy(); return json(413, { error: 'O vídeo ultrapassa 16 MB.' }); }
        chunks.push(part);
      }
      if (!total) return json(400, { error: 'Vídeo vazio.' });
      const socket = getSocket();
      if (!socket.user?.id) return json(503, { error: 'WhatsApp ainda não está conectado. Abra o bot no Termux.' });
      const result = await createAnimatedSticker(Buffer.concat(chunks), {
        fit: 'cortar', withAudio: true, startSec: startMs / 1000, durationSec: durationMs / 1000,
      });
      if (!result.audio || result.audioSilent) return json(422, { error: result.audioSilent ? 'O trecho escolhido está sem áudio.' : 'Não consegui extrair o áudio desse vídeo.' });
      await sendSoundSticker(socket, `${phone}@s.whatsapp.net`, {
        sticker: result.sticker, audio: result.audio, durationMs: result.durationMs,
      });
      return json(200, { ok: true, message: 'Figurinha sonora enviada.', trimmed: result.trimmed });
    } catch (error) {
      console.error('[StickerSom API]', error);
      return json(500, { error: error instanceof Error ? error.message : 'Falha ao gerar a figurinha.' });
    }
  });
  server.on('error', error => console.error('[StickerSom API] Erro no servidor local:', error));
  server.listen(3988, '127.0.0.1', () => console.log('[StickerSom] API local pronta em http://127.0.0.1:3988'));
}
