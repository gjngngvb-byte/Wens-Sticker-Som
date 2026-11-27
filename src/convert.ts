import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConversionError, ffmpeg, mapLimit, PARALLEL, probe, ToolError, withTempDir } from './ffmpeg.js';
import { addStickerMetadata, inspectWebp, type StickerMetadata } from './webp.js';

/** Limites das figurinhas do WhatsApp (repositório oficial WhatsApp/stickers). */
export const STICKER_SIZE = 512;
export const MAX_STATIC_BYTES = 100_000;
export const MAX_ANIMATED_BYTES = 500_000;
export const MAX_SECONDS = 10;
export const MAX_INPUT_BYTES = 16 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 256_000;

/** Espaço guardado para o bloco EXIF com nome do pacote. */
const METADATA_RESERVE = 2_000;
/** Volume máximo abaixo disso (dBFS) conta como "sem som audível". */
const SILENCE_DB = -50;

/**
 * Como o vídeo ocupa o quadrado 512×512:
 * - `cortar` (padrão): preenche o quadrado inteiro cortando o excesso no centro, sem bordas.
 * - `inteiro`: mostra o quadro todo, com bordas transparentes onde sobrar espaço.
 */
export type FitMode = 'cortar' | 'inteiro';

export type StickerOptions = {
  fit?: FitMode;
  meta?: StickerMetadata;
  /** Também extrai o áudio (em paralelo com a imagem). */
  withAudio?: boolean;
  /** Início do trecho em segundos. */
  startSec?: number;
  /** Duração solicitada em segundos (máximo 10). */
  durationSec?: number;
  /** Repete o trecho visual para alcançar a duração final do áudio. */
  loopVideo?: boolean;
  /** Recebe o tempo de cada etapa, para medir desempenho. */
  onStep?: (step: string, ms: number) => void;
};

export type StickerResult = {
  sticker: Buffer;
  animated: boolean;
  durationMs: number;
  /** O vídeo era mais longo que 10 s e só o começo foi usado. */
  trimmed: boolean;
  /** O arquivo de origem tem uma faixa de áudio. */
  hasAudio: boolean;
  /** Áudio Ogg/Opus pronto, quando `withAudio` foi pedido e deu certo. */
  audio?: Buffer;
  /** A faixa de áudio existe, mas está em silêncio. */
  audioSilent?: boolean;
  /** Por que o áudio não pôde ser preparado (a figurinha em si saiu). */
  audioError?: Error;
};

/**
 * Degraus de qualidade, do melhor para o mais leve: [quadros/s, qualidade WebP, resolução de trabalho].
 * Abaixo de 512 o conteúdo é reduzido e ampliado de volta: o arquivo fica menor e a figurinha
 * continua do mesmo tamanho na tela.
 */
const LADDER: readonly (readonly [number, number, number])[] = [
  [15, 60, 512], [12, 50, 512], [10, 45, 448], [10, 35, 384], [8, 30, 320], [6, 25, 256], [5, 20, 192],
];

function withMetadata(webp: Buffer, meta?: StickerMetadata): Buffer {
  return meta?.packName || meta?.publisher ? addStickerMetadata(webp, meta) : webp;
}

function checkInput(input: Buffer): void {
  if (!input.length) throw new ConversionError('O arquivo veio vazio.');
  if (input.length > MAX_INPUT_BYTES) throw new ConversionError('O arquivo passa de 16 MB.');
}

/** Primeira etapa: só ajusta o enquadramento (o resto fica para os degraus). */
function framingFilter(fit: FitMode, fps?: number): string {
  const S = STICKER_SIZE;
  const steps = [fps ? `fps=${fps}` : ''];
  if (fit === 'cortar') steps.push(`scale=${S}:${S}:force_original_aspect_ratio=increase:flags=lanczos`, `crop=${S}:${S}`);
  else steps.push(`scale=${S}:${S}:force_original_aspect_ratio=decrease:force_divisible_by=2:flags=lanczos`);
  steps.push('setsar=1');
  return steps.filter(Boolean).join(',');
}

/** Filtro de um degrau, aplicado sobre o intermediário já enquadrado (largura w × altura h). */
function stepFilter(fit: FitMode, [fps, , detail]: readonly [number, number, number], w: number, h: number, prefix = ''): string {
  const S = STICKER_SIZE;
  const steps = [prefix, `fps=${fps}`];
  if (detail < S) {
    const dw = Math.max(2, Math.round(w * detail / S / 2) * 2), dh = Math.max(2, Math.round(h * detail / S / 2) * 2);
    steps.push(`scale=${dw}:${dh}:flags=area`, `scale=${w}:${h}:flags=bicubic`);
  }
  if (fit === 'inteiro') {
    // yuva420p em todos os quadros: as sobras ficam transparentes (e não pretas).
    steps.push('format=rgba', `pad=${S}:${S}:(ow-iw)/2:(oh-ih)/2:color=black@0`, 'format=yuva420p');
  } else steps.push('format=yuv420p');
  return steps.filter(Boolean).join(',');
}

async function encodeWebp(source: string, output: string, filter: string, quality: number, timeoutMs = 120_000): Promise<number> {
  await ffmpeg(['-loglevel', 'error', '-i', source, '-an', '-vf', filter,
    '-c:v', 'libwebp_anim', '-lossless', '0', '-quality', String(quality), '-compression_level', '4',
    '-loop', '0', '-f', 'webp', output], timeoutMs);
  return (await stat(output)).size;
}

/**
 * Extrai o áudio do trecho usado: Ogg/Opus mono 48 kHz (o formato das mensagens de voz, que
 * toca em todos os aparelhos), com um fade curto nas pontas para não estalar quando repete.
 */
async function extractAudio(source: string, seconds: number, output: string, startSec = 0, loopAudio = false): Promise<{ audio: Buffer; silent: boolean }> {
  const fadeOut = Math.max(0, seconds - 0.12).toFixed(3);
  const { stderr } = await ffmpeg(['-loglevel', 'info', ...(loopAudio ? ['-stream_loop', '-1'] : []), '-ss', startSec.toFixed(3), '-t', seconds.toFixed(3), '-i', source,
    '-map', '0:a:0', '-vn', '-sn', '-dn', '-ac', '1', '-ar', '48000',
    '-af', `afade=t=in:d=0.02,afade=t=out:st=${fadeOut}:d=0.12,volumedetect`,
    '-c:a', 'libopus', '-b:a', '64k', '-application', 'audio', '-map_metadata', '-1', '-f', 'ogg', output], 60_000);
  const audio = await readFile(output);
  if (!audio.length) throw new ConversionError('O áudio saiu vazio.');
  if (audio.length > MAX_AUDIO_BYTES) throw new ConversionError('O áudio ficou grande demais.');
  const raw = /max_volume:\s*(-?[\d.]+|-inf) dB/.exec(stderr)?.[1];
  const maxVolume = raw === '-inf' ? -Infinity : Number(raw);
  return { audio, silent: raw !== undefined && maxVolume <= SILENCE_DB };
}

/** Foto → figurinha estática (WebP 512×512, até 100 KB). */
export async function createStaticSticker(input: Buffer, fit: FitMode = 'cortar', meta?: StickerMetadata): Promise<StickerResult> {
  checkInput(input);
  return withTempDir(async dir => {
    const source = join(dir, 'entrada'), output = join(dir, 'figurinha.webp');
    await writeFile(source, input);
    const info = await probe(source);
    if (!info.hasVideo) throw new ConversionError('Não encontrei uma imagem nesse arquivo.');
    const S = STICKER_SIZE;
    const filter = fit === 'cortar'
      ? `scale=${S}:${S}:force_original_aspect_ratio=increase:flags=lanczos,crop=${S}:${S},setsar=1`
      : `scale=${S}:${S}:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=${S}:${S}:(ow-iw)/2:(oh-ih)/2:color=black@0,setsar=1`;
    for (const quality of [80, 65, 50, 35, 20]) {
      await ffmpeg(['-loglevel', 'error', '-i', source, '-frames:v', '1', '-vf', filter,
        '-c:v', 'libwebp', '-quality', String(quality), '-compression_level', '6', '-f', 'webp', output], 30_000);
      const sticker = withMetadata(await readFile(output), meta);
      if (sticker.length <= MAX_STATIC_BYTES) {
        inspectWebp(sticker);
        return { sticker, animated: false, durationMs: 0, trimmed: false, hasAudio: false };
      }
    }
    throw new ConversionError('Não consegui deixar a figurinha abaixo de 100 KB.');
  });
}

/**
 * Vídeo/GIF → figurinha animada (WebP 512×512, em loop, até 10 s e 500 KB), opcionalmente com o áudio.
 *
 * Para ser rápido mesmo com vídeos pesados:
 * 1. decodifica o vídeo uma única vez para um intermediário 512 px (e, em paralelo, extrai o áudio);
 * 2. estima o tamanho final de cada degrau de qualidade com amostras curtas, codificadas em paralelo;
 * 3. faz a codificação completa direto no melhor degrau que deve caber (e desce um se não couber).
 */
export async function createAnimatedSticker(input: Buffer, options: StickerOptions = {}): Promise<StickerResult> {
  checkInput(input);
  const fit = options.fit ?? 'cortar';
  const limit = MAX_ANIMATED_BYTES - METADATA_RESERVE;
  const timed = async <T>(step: string, work: () => Promise<T>): Promise<T> => {
    const t = performance.now();
    try { return await work(); } finally { options.onStep?.(step, performance.now() - t); }
  };
  return withTempDir(async dir => {
    const source = join(dir, 'entrada'), base = join(dir, 'base.mkv');
    await writeFile(source, input);
    const info = await timed('analisar', () => probe(source));
    if (!info.hasVideo) throw new ConversionError('Não encontrei vídeo nesse arquivo.');
    const startSec = Math.max(0, options.startSec ?? 0);
    const available = Math.max(0, (info.durationSec ?? MAX_SECONDS) - startSec);
    const seconds = options.loopVideo
      ? Math.min(MAX_SECONDS, options.durationSec ?? MAX_SECONDS)
      : Math.min(MAX_SECONDS, options.durationSec ?? MAX_SECONDS, available);
    if (seconds < 0.2) throw new ConversionError('O vídeo é curto demais (mínimo 0,2 s).');

    // Áudio em paralelo com todo o trabalho de imagem. Falha no áudio não derruba a figurinha.
    const audioTask = options.withAudio && info.hasAudio
      ? timed('áudio', () => extractAudio(source, seconds, join(dir, 'audio.ogg'), startSec)).then(
        result => ({ ...result, error: undefined }),
        (error: Error) => ({ audio: undefined, silent: false, error }))
      : undefined;

    // 1. Intermediário: enquadrado em 512, no máximo 15 quadros/s, só os primeiros 10 s.
    const baseFps = Math.min(15, Math.round(info.fps ?? 15)) || 15;
    await timed('decodificar', () => ffmpeg(['-loglevel', 'error', ...(options.loopVideo ? ['-stream_loop', '-1'] : []), '-ss', startSec.toFixed(3), '-t', seconds.toFixed(3), '-i', source,
      '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', framingFilter(fit, baseFps),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '10', '-pix_fmt', 'yuv444p', base], 120_000)
      .catch((error: unknown) => {
        throw error instanceof ToolError && !/não foi encontrado/.test(error.message)
          ? new ConversionError('Não consegui ler o vídeo. Ele pode estar corrompido ou num formato não suportado.') : error;
      }));
    const baseInfo = await probe(base);
    const w = baseInfo.width ?? STICKER_SIZE, h = baseInfo.height ?? STICKER_SIZE;

    // 2. Estimativa: amostra de três janelas curtas (começo, meio, fim), ~1,5 s de vídeo.
    //    Busca binária pelo melhor degrau que deve caber: 2–3 amostras em vez de codificar tudo.
    let first = 0;
    if (seconds > 3) {
      const win = 0.5, mid = seconds / 2 - win / 2, end = seconds - win;
      // Entre aspas simples as vírgulas fazem parte da expressão, não separam filtros.
      const select = `select='between(t,0,${win})+between(t,${mid.toFixed(2)},${(mid + win).toFixed(2)})+between(t,${end.toFixed(2)},${seconds.toFixed(2)})',setpts=N/${baseFps}/TB`;
      const fitsEstimate = async (i: number) => {
        const size = await encodeWebp(base, join(dir, `amostra-${i}.webp`), stepFilter(fit, LADDER[i]!, w, h, select), LADDER[i]![1], 60_000);
        return size * seconds / (3 * win) <= limit * 0.85;
      };
      // Duas rodadas de duas amostras em paralelo (7 degraus):
      //   1ª: degraus 1 e 4. Se o 1 cabe, pronto (vídeos leves param aqui).
      //   2ª: degraus 2 e 3 (se o 4 cabe) ou 5 e 6 (se não); o 7 é o último recurso.
      first = await timed('estimar', async () => {
        const check = (steps: number[]) => Promise.all(steps.map(fitsEstimate));
        const [top, middle] = await check([0, 3]);
        if (top) return 0;
        const [a, b] = await check(middle ? [1, 2] : [4, 5]);
        if (middle) return a ? 1 : b ? 2 : 3;
        return a ? 4 : b ? 5 : 6;
      });
    }

    // 3. Codificação final no degrau escolhido; se a estimativa errou, desce um degrau.
    let sticker: Buffer | undefined;
    for (let i = first; i < LADDER.length && !sticker; i++) {
      const output = join(dir, `final-${i}.webp`), step = LADDER[i]!;
      const size = await timed(`codificar (degrau ${i + 1})`, () => encodeWebp(base, output, stepFilter(fit, step, w, h), step[1]));
      if (size <= limit) sticker = withMetadata(await readFile(output), options.meta);
    }
    if (!sticker) throw new ConversionError('Não consegui deixar a animação abaixo de 500 KB. Tente um trecho mais curto.');

    const webp = inspectWebp(sticker);
    if (!webp.animated || webp.frames < 2) throw new ConversionError('Esse vídeo é curto ou parado demais para virar animação.');
    if (webp.width !== STICKER_SIZE || webp.height !== STICKER_SIZE) throw new ToolError(`Figurinha saiu com ${webp.width}×${webp.height}.`);

    const audio = await audioTask;
    return {
      sticker, animated: true, durationMs: webp.durationMs,
      trimmed: (info.durationSec ?? 0) > startSec + seconds + 0.05, hasAudio: info.hasAudio,
      audio: audio?.audio, audioSilent: audio?.silent, audioError: audio?.error,
    };
  });
}


/** Retorna a duração de uma faixa de áudio enviada pelo usuário. */
export async function getAudioDuration(input: Buffer): Promise<number> {
  checkInput(input);
  return withTempDir(async dir => {
    const source=join(dir,'audio-probe');
    await writeFile(source,input);
    const info=await probe(source);
    if(!info.hasAudio) throw new ConversionError('Não encontrei uma faixa de áudio nesse arquivo.');
    return Math.min(MAX_SECONDS,info.durationSec??MAX_SECONDS);
  });
}

/** Converte áudio enviado separadamente para Ogg/Opus mono, limitado a 10 segundos. */
export async function createAudioTrack(input: Buffer, maxSeconds = MAX_SECONDS, loopAudio = false): Promise<{ audio: Buffer; durationMs: number; silent: boolean }> {
  checkInput(input);
  return withTempDir(async dir => {
    const source=join(dir,'audio-entrada'), output=join(dir,'audio.ogg');
    await writeFile(source,input);
    const info=await probe(source);
    if(!info.hasAudio) throw new ConversionError('Não encontrei uma faixa de áudio nesse arquivo.');
    const sourceSeconds=info.durationSec??MAX_SECONDS;
    const seconds=Math.min(MAX_SECONDS,maxSeconds,loopAudio?maxSeconds:sourceSeconds);
    if(seconds<0.2) throw new ConversionError('O áudio é curto demais.');
    const result=await extractAudio(source,seconds,output,0,loopAudio&&sourceSeconds+0.02<seconds);
    return {audio:result.audio,durationMs:Math.round(seconds*1000),silent:result.silent};
  });
}

/** Transforma imagem parada em WebP animado para receber áudio como figurinha sonora. */
export async function createImageSoundSticker(input: Buffer, meta?: StickerMetadata): Promise<StickerResult> {
  checkInput(input);
  return withTempDir(async dir => {
    const source=join(dir,'imagem-entrada'),output=join(dir,'imagem-animada.webp');
    await writeFile(source,input);
    const info=await probe(source);
    if(!info.hasVideo) throw new ConversionError('Não consegui ler essa imagem.');
    const filter='fps=10,scale=512:512:force_original_aspect_ratio=increase:flags=lanczos,crop=512:512,setsar=1';
    await ffmpeg(['-loglevel','error','-loop','1','-framerate','10','-t','10','-i',source,'-an','-vf',filter,'-c:v','libwebp_anim','-lossless','0','-quality','65','-compression_level','4','-loop','0','-f','webp',output],60000);
    const sticker=withMetadata(await readFile(output),meta);
    if(sticker.length>MAX_ANIMATED_BYTES) throw new ConversionError('A imagem ficou grande demais. Tente outra imagem.');
    const webp=inspectWebp(sticker);
    if(!webp.animated||webp.frames<2) throw new ConversionError('Não consegui animar essa imagem.');
    return {sticker,animated:true,durationMs:webp.durationMs,trimmed:false,hasAudio:false};
  });
}
