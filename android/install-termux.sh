#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

echo "StickerSom Android • correção experimental de vinculação"
echo "Este teste roda localmente no Android via Termux. Use um número secundário se possível."
echo

pkg update -y
pkg install -y nodejs-lts ffmpeg git python

WORKDIR="$HOME/stickersom-sound-sender"
if [ -d "$WORKDIR/.git" ]; then
  git -C "$WORKDIR" fetch origin
  git -C "$WORKDIR" reset --hard origin/main
else
  git clone https://github.com/coelhobugado/whatsapp-figurinhas-com-som.git "$WORKDIR"
fi
cd "$WORKDIR"

python - <<'PY'
from pathlib import Path
p = Path("src/bot.ts")
s = p.read_text()

# A pairing-code attempt writes a temporary creds.me before WhatsApp confirms
# the link. If the process is restarted mid-pairing, discard that incomplete auth.
if "import { mkdir } from 'node:fs/promises';" in s:
    s = s.replace(
        "import { mkdir } from 'node:fs/promises';",
        "import { mkdir, rm } from 'node:fs/promises';",
        1,
    )
elif "import { mkdir, rm } from 'node:fs/promises';" not in s:
    raise SystemExit("Não reconheci o import de fs/promises. Nenhuma alteração foi feita.")

old_auth = """  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);"""
new_auth = """  let auth = await useMultiFileAuthState(AUTH_DIR);
  if (!auth.state.creds.registered && auth.state.creds.me) {
    logError('Vinculação anterior incompleta. Limpando apenas a sessão local para gerar outro código.');
    await rm(AUTH_DIR, { recursive: true, force: true });
    await mkdir(AUTH_DIR, { recursive: true });
    auth = await useMultiFileAuthState(AUTH_DIR);
  }
  const { state, saveCreds } = auth;"""
if old_auth in s:
    s = s.replace(old_auth, new_auth, 1)
elif new_auth not in s:
    raise SystemExit("Não encontrei o ponto de inicialização da sessão. Nenhuma alteração foi feita.")

needle0 = "  current.ev.on('connection.update',"
s = s.replace(needle0, "  let pairingCodeRequested = false;\n" + needle0, 1)

needle = "    if (qr) {\n      setQr(qr);"
replacement = """    if (qr) {
      const pairingNumber = (process.env.PAIRING_NUMBER || '').replace(/\\D/g, '');
      if (pairingNumber) {
        if (!pairingCodeRequested) {
          pairingCodeRequested = true;
          (async () => {
            try {
              const code = await current.requestPairingCode(pairingNumber);
              console.log('\\nNovo código de vinculação do StickerSom: ' + code);
              console.log('No WhatsApp: Configurações > Aparelhos conectados > Conectar aparelho > Conectar com número de telefone.\\n');
            } catch (error) {
              pairingCodeRequested = false;
              console.error('Não foi possível gerar o código de vinculação:', error);
            }
          })();
        }
      } else {
        setQr(qr);"""
if needle in s:
    s = s.replace(needle, replacement, 1)
elif replacement not in s:
    raise SystemExit("Não encontrei o bloco QR original. Nenhuma alteração foi feita.")

needle2 = "      qrcode.generate(qr, { small: true });\n    }"
replacement2 = "      qrcode.generate(qr, { small: true });\n      }\n    }"
if needle2 in s:
    s = s.replace(needle2, replacement2, 1)
elif replacement2 not in s:
    raise SystemExit("Não encontrei o fechamento esperado do bloco QR. Nenhuma alteração foi feita.")

p.write_text(s)
print("Correção aplicada: o código será solicitado uma vez por conexão, inclusive após reconexão.")
PY


# Ponte local usada pelo aplicativo Android (não abre porta na rede).
curl -fL https://raw.githubusercontent.com/gjngngvb-byte/Wens-Sticker-Som/main/android/mobile-api.ts -o src/mobile-api.ts

python - <<'PY'
from pathlib import Path

bot = Path("src/bot.ts")
s = bot.read_text()
imp = "import { sendSoundSticker } from './sound-sticker.js';"
if "import { startMobileApi } from './mobile-api.js';" not in s:
    if imp not in s: raise SystemExit("Não encontrei o import do envio sonoro no bot.")
    s = s.replace(imp, imp + "\\nimport { startMobileApi } from './mobile-api.js';", 1)
needle = "      markConnected();"
if "startMobileApi(() => socket);" not in s:
    if needle not in s: raise SystemExit("Não encontrei o ponto de conexão do bot.")
    s = s.replace(needle, needle + "\\n      startMobileApi(() => socket);", 1)
bot.write_text(s)

p = Path("src/convert.ts")
s = p.read_text()
replacements = [
("  withAudio?: boolean;","  withAudio?: boolean;\\n  /** Início do trecho, em segundos. */\\n  startSec?: number;\\n  /** Duração solicitada, em segundos (máximo 10). */\\n  durationSec?: number;"),
("async function extractAudio(source: string, seconds: number, output: string): Promise<{ audio: Buffer; silent: boolean }> {","async function extractAudio(source: string, seconds: number, output: string, startSec = 0): Promise<{ audio: Buffer; silent: boolean }> {"),
("const { stderr } = await ffmpeg(['-loglevel', 'info', '-t', seconds.toFixed(3), '-i', source,","const { stderr } = await ffmpeg(['-loglevel', 'info', '-ss', startSec.toFixed(3), '-t', seconds.toFixed(3), '-i', source,"),
("    const seconds = Math.min(MAX_SECONDS, info.durationSec ?? MAX_SECONDS);","    const startSec = Math.max(0, options.startSec ?? 0);\\n    const available = Math.max(0.2, (info.durationSec ?? MAX_SECONDS) - startSec);\\n    const seconds = Math.min(MAX_SECONDS, options.durationSec ?? MAX_SECONDS, available);"),
("timed('áudio', () => extractAudio(source, seconds, join(dir, 'audio.ogg')))","timed('áudio', () => extractAudio(source, seconds, join(dir, 'audio.ogg'), startSec))"),
("await timed('decodificar', () => ffmpeg(['-loglevel', 'error', '-t', seconds.toFixed(3), '-i', source,","await timed('decodificar', () => ffmpeg(['-loglevel', 'error', '-ss', startSec.toFixed(3), '-t', seconds.toFixed(3), '-i', source,"),
("(info.durationSec ?? 0) > MAX_SECONDS + 0.05","(info.durationSec ?? 0) - startSec > seconds + 0.05"),
]
for old,new in replacements:
    if old not in s:
        if new not in s: raise SystemExit("Não reconheci trecho do conversor: " + old[:80])
    else: s=s.replace(old,new,1)
p.write_text(s)
print("API local e recorte do vídeo habilitados.")
PY

npm install

echo
read -r -p "Digite seu número WhatsApp com DDI e DDD (ex.: 5511999999999): " WA_NUMBER
WA_NUMBER="$(printf '%s' "$WA_NUMBER" | tr -cd '0-9')"
if [ -z "$WA_NUMBER" ]; then
  echo "Número inválido."
  exit 1
fi

cat > .env <<EOF
PAIRING_NUMBER=$WA_NUMBER
STICKER_PACK_NAME=StickerSom
STICKER_PUBLISHER=StickerSom
ALLOWED_NUMBERS=$WA_NUMBER
EOF

echo
echo "Correção instalada. Iniciando o emissor..."
echo "Digite o código somente no WhatsApp. Não compartilhe o código com ninguém."
echo "Para encerrar: Ctrl+C. Para iniciar novamente: cd $WORKDIR && npm start"
npm start
