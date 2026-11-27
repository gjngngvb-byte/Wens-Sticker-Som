import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';

/** Erro com mensagem pronta para mostrar ao usuário no WhatsApp. */
export class ConversionError extends Error {}

/** Falha interna de uma ferramenta (FFmpeg/ffprobe). A mensagem é técnica, só para o log. */
export class ToolError extends Error {}

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

export type RunResult = { stdout: string; stderr: string };

/** Roda um executável sem shell, com tempo limite. */
export function runFull(file: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) { resolve({ stdout, stderr }); return; }
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') reject(new ToolError(`"${file}" não foi encontrado. Instale o FFmpeg e coloque-o no PATH.`));
        else if ((error as { killed?: boolean }).killed) reject(new ToolError(`${file} passou do tempo limite (${timeoutMs / 1000} s).`));
        else reject(new ToolError(`${file} falhou: ${String(stderr || error.message).trim().slice(-500)}`));
      });
  });
}

export const ffmpeg = (args: string[], timeoutMs?: number) =>
  runFull(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], timeoutMs);

/** Executa tarefas com no máximo `limit` ao mesmo tempo, mantendo a ordem dos resultados. */
export async function mapLimit<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await work(items[i]!, i); }
  });
  await Promise.all(workers);
  return results;
}

/** Quantos processos do FFmpeg rodar em paralelo (o encoder de WebP usa um núcleo cada). */
export const PARALLEL = Math.max(1, Math.min(4, availableParallelism()));

/** Cria uma pasta temporária, entrega para `work` e apaga tudo no final. */
export async function withTempDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'figurinha-som-'));
  try { return await work(dir); }
  finally { await rm(dir, { recursive: true, force: true, maxRetries: 3 }); }
}

export type MediaInfo = { hasVideo: boolean; hasAudio: boolean; durationSec?: number; width?: number; height?: number; fps?: number };

export async function probe(path: string): Promise<MediaInfo> {
  let out: string;
  try {
    out = (await runFull(FFPROBE, ['-v', 'error', '-show_entries',
      'format=duration:stream=codec_type,width,height,avg_frame_rate', '-of', 'json', path], 20_000)).stdout;
  } catch (error) {
    if (error instanceof ToolError && /não foi encontrado/.test(error.message)) throw error;
    throw new ConversionError('Não consegui ler esse arquivo. Ele pode estar corrompido ou num formato não suportado.');
  }
  const data = JSON.parse(out) as {
    streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string }[];
    format?: { duration?: string };
  };
  const video = data.streams?.find(s => s.codec_type === 'video');
  const duration = Number(data.format?.duration);
  const [num, den] = (video?.avg_frame_rate ?? '').split('/').map(Number);
  const fps = num && den ? num / den : undefined;
  return {
    hasVideo: !!video,
    hasAudio: !!data.streams?.some(s => s.codec_type === 'audio'),
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : undefined,
    width: video?.width,
    height: video?.height,
    fps: fps && Number.isFinite(fps) && fps > 0 && fps < 1000 ? fps : undefined,
  };
}

/**
 * Confere na inicialização se o FFmpeg instalado tem o que o bot precisa.
 * Devolve a lista de problemas (vazia = tudo certo).
 */
export async function checkTools(): Promise<string[]> {
  const problems: string[] = [];
  try {
    const { stdout } = await runFull(FFMPEG, ['-hide_banner', '-encoders'], 20_000);
    for (const encoder of ['libwebp_anim', 'libwebp', 'libopus', 'libx264'])
      if (!new RegExp(`\\s${encoder}\\s`).test(stdout)) problems.push(`O FFmpeg instalado não tem o encoder "${encoder}".`);
  } catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
  try { await runFull(FFPROBE, ['-version'], 20_000); }
  catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
  return problems;
}
