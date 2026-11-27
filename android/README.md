# StickerSom Android

O projeto tem duas partes: o **app Android** (editor visual) e o **motor local no Termux** (conexão WhatsApp e envio da figurinha sonora). Os dois precisam estar no mesmo aparelho.

## 1. Instalar/atualizar o motor no Termux

Instale o Termux pela fonte oficial: https://termux.dev/

No Termux, execute:

```sh
pkg install -y curl
curl -fL https://raw.githubusercontent.com/gjngngvb-byte/Wens-Sticker-Som/main/android/install-termux.sh -o install-stickersom.sh
bash install-stickersom.sh
```

O instalador preserva a pasta de sessão existente. Se o WhatsApp já estiver conectado, não é necessário vincular novamente. Mantenha o processo do bot aberto no Termux. Quando aparecer `[StickerSom] API local pronta`, o app já pode conversar com o motor.

## 2. Instalar o aplicativo

O APK de teste é gerado automaticamente pelo GitHub Actions. Abra a aba **Actions** deste repositório, selecione **Build StickerSom APK**, abra a execução mais recente concluída e baixe o artefato **StickerSom-debug-apk**. Extraia o ZIP e instale `app-debug.apk` no Android.

## 3. Criar uma figurinha sonora

1. Abra o StickerSom e escolha um vídeo.
2. Ajuste o início e a duração do trecho (até 10 segundos).
3. Informe o número de destino com DDI + DDD.
4. Toque em **Gerar figurinha sonora**.

O app envia o vídeo diretamente ao motor local em `127.0.0.1`; a mídia não passa por um servidor StickerSom. O motor converte para WebP animado e áudio Ogg/Opus e envia a mensagem sonora pelo WhatsApp conectado.

## Requisitos e limites

- Android 6.0 ou superior.
- Termux e o bot precisam permanecer ativos no mesmo aparelho.
- Vídeo de até 16 MB; trecho de até 10 segundos.
- O número de destino deve incluir código do país, DDD e telefone.
- O destinatário precisa ter uma versão do WhatsApp capaz de reproduzir figurinhas sonoras.
- O envio usa um protocolo não oficial via Baileys e engenharia reversa. Pode parar de funcionar após atualizações e pode gerar restrições na conta. É experimental; considere usar um número secundário.

## Privacidade e segurança

A API escuta apenas em `127.0.0.1`, não na rede Wi-Fi. Não compartilhe o código de vinculação, a pasta `sessao` ou os arquivos de autenticação. Revogue o aparelho vinculado em **WhatsApp → Aparelhos conectados** quando quiser.
