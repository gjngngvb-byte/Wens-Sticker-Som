import { randomUUID } from 'node:crypto';

export type StickerMetadata = { packName: string; publisher?: string; emojis?: string[] };

function chunk(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload, payload.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/**
 * Grava nome do pacote e autor no bloco EXIF do WebP, no formato que o WhatsApp lê
 * (um JSON dentro de um TIFF mínimo, na tag 0x5741). É o texto mostrado ao tocar na figurinha.
 */
export function addStickerMetadata(webp: Buffer, meta: StickerMetadata): Buffer {
  const info = inspectWebp(webp);
  const json = Buffer.from(JSON.stringify({
    'sticker-pack-id': randomUUID(),
    'sticker-pack-name': meta.packName,
    'sticker-pack-publisher': meta.publisher ?? '',
    emojis: meta.emojis ?? [''],
  }), 'utf8');
  // TIFF little-endian com um único campo: tag 0x5741, tipo UNDEFINED, valor no offset 22.
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
  tiff.writeUInt32LE(json.length, 14);
  const exif = chunk('EXIF', Buffer.concat([tiff, json]));

  const chunks: Buffer[] = [];
  let offset = 12, hasVp8x = false, hasAlpha = false;
  while (offset < webp.length) {
    const type = webp.toString('ascii', offset, offset + 4), size = webp.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (type === 'ALPH' || type === 'VP8L') hasAlpha = true;
    if (type !== 'EXIF') chunks.push(Buffer.from(webp.subarray(offset, end)));
    if (type === 'VP8X') hasVp8x = true;
    offset = end;
  }
  if (!hasVp8x) {
    // WebP simples não tem cabeçalho estendido; cria um para poder anunciar o EXIF.
    const vp8x = Buffer.alloc(10);
    vp8x[0] = hasAlpha ? 0x10 : 0;
    vp8x.writeUIntLE(info.width - 1, 4, 3);
    vp8x.writeUIntLE(info.height - 1, 7, 3);
    chunks.unshift(chunk('VP8X', vp8x));
  }
  chunks[0]![8] = chunks[0]![8]! | 0x08; // VP8X: flag "tem EXIF"
  const body = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...chunks, exif]);
  const riff = Buffer.alloc(8);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(body.length, 4);
  return Buffer.concat([riff, body]);
}

/** Lê de volta o JSON do EXIF (para testes e conferência). */
export function readStickerMetadata(webp: Buffer): Record<string, unknown> | undefined {
  const at = webp.indexOf('EXIF', 12, 'ascii');
  if (at < 0) return undefined;
  const size = webp.readUInt32LE(at + 4), payload = webp.subarray(at + 8, at + 8 + size);
  return JSON.parse(payload.subarray(22, 22 + payload.readUInt32LE(14)).toString('utf8'));
}

export type WebpInfo ={ width: number; height: number; animated: boolean; frames: number; durationMs: number };

/** Lê os blocos RIFF de um WebP sem decodificar imagens. Lança erro se o arquivo estiver malformado. */
export function inspectWebp(data: Buffer): WebpInfo {
  if (data.length < 20 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP')
    throw new Error('Não é um arquivo WebP.');
  if (data.readUInt32LE(4) + 8 !== data.length) throw new Error('Tamanho RIFF inconsistente.');
  let offset = 12, width = 0, height = 0, animated = false, frames = 0, durationMs = 0;
  while (offset + 8 <= data.length) {
    const type = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + size > data.length) throw new Error('Bloco WebP truncado.');
    if (type === 'VP8X') {
      animated = (data[body]! & 0x02) !== 0;
      width = data.readUIntLE(body + 4, 3) + 1;
      height = data.readUIntLE(body + 7, 3) + 1;
    } else if (type === 'ANMF') {
      frames++;
      durationMs += data.readUIntLE(body + 12, 3);
    } else if ((type === 'VP8 ' || type === 'VP8L') && !width) {
      // WebP simples sem VP8X: a dimensão fica dentro do bitstream.
      if (type === 'VP8L') {
        const bits = data.readUInt32LE(body + 1);
        width = (bits & 0x3fff) + 1; height = ((bits >> 14) & 0x3fff) + 1;
      } else {
        width = data.readUInt16LE(body + 6) & 0x3fff; height = data.readUInt16LE(body + 8) & 0x3fff;
      }
      frames = 1;
    }
    offset = body + size + (size % 2);
  }
  if (offset !== data.length) throw new Error('Final do WebP inconsistente.');
  if (!animated && !frames) frames = 1;
  return { width, height, animated, frames, durationMs };
}
