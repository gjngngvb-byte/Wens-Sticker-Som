#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

echo "StickerSom Android • instalação experimental"
echo "Este teste roda localmente no seu Android via Termux."
echo "Ele conecta como aparelho vinculado do WhatsApp. Use um número secundário se possível."
echo

pkg update -y
pkg install -y nodejs-lts ffmpeg git python

WORKDIR="$HOME/stickersom-sound-sender"
if [ -d "$WORKDIR/.git" ]; then
  git -C "$WORKDIR" pull --ff-only
else
  git clone https://github.com/coelhobugado/whatsapp-figurinhas-com-som.git "$WORKDIR"
fi
cd "$WORKDIR"

python - <<'PY'
from pathlib import Path
p = Path("src/bot.ts")
s = p.read_text()
needle = "    if (qr) {\n      setQr(qr);"
replacement = """    if (qr) {
      const pairingNumber = (process.env.PAIRING_NUMBER || '').replace(/\\D/g, '');
      if (pairingNumber) {
        if (!(globalThis as any).__stickersomPairingRequested) {
          (globalThis as any).__stickersomPairingRequested = true;
          current.requestPairingCode(pairingNumber)
            .then(code => {
              console.log('\\nCódigo de vinculação do StickerSom: ' + code);
              console.log('No WhatsApp: Configurações > Aparelhos conectados > Conectar aparelho > Conectar com número de telefone.\\n');
            })
            .catch(error => console.error('Não foi possível gerar o código de vinculação:', error));
        }
      } else {
        setQr(qr);"""
if needle not in s:
    raise SystemExit("Não encontrei o trecho esperado do bot. Nenhuma alteração foi feita.")
s = s.replace(needle, replacement, 1)
needle2 = "      qrcode.generate(qr, { small: true });\n    }"
replacement2 = "      qrcode.generate(qr, { small: true });\n      }\n    }"
if needle2 not in s:
    raise SystemExit("Não encontrei o fechamento esperado do bloco QR. Nenhuma alteração foi feita.")
s = s.replace(needle2, replacement2, 1)
p.write_text(s)
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
echo "Instalação concluída. Iniciando o emissor..."
echo "Quando aparecer o código, digite-o no WhatsApp em Aparelhos conectados."
echo "Para encerrar: Ctrl+C. Para iniciar novamente: cd $WORKDIR && npm start"
npm start
