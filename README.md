# StickerSom 🔊

Site para criar figurinhas animadas com áudio e recebê-las como **Sound Sticker nativa** no WhatsApp.

## Fluxo

1. A pessoa seleciona um vídeo no site e escolhe um trecho de até 10 segundos.
2. O servidor usa FFmpeg para gerar WebP animado e áudio Ogg/Opus.
3. O site cria um código temporário de uso único.
4. A pessoa abre a conversa da conta StickerSom e envia o código.
5. O bot recupera os arquivos e envia a mensagem especial usando `sendSoundSticker()`.

O visitante não precisa parear o próprio WhatsApp. A conta StickerSom fica conectada no servidor.

## Servidor

- Node.js 22+
- FFmpeg com `libwebp_anim`, `libopus` e `libx264`
- Baileys 7.0.0-rc14
- Porta HTTP definida por `PORT`
- Sessão WhatsApp em `AUTH_DIR` (padrão: `/var/data/stickersom-session` se existir `/var/data`)

### Desenvolvimento

```bash
npm install
npm start
```

Abra `http://localhost:3000/pair` para parear a conta de serviço pelo QR Code.

### Deploy no Render

O Blueprint `render.yaml` configura um serviço Docker persistente com disco para preservar a sessão WhatsApp entre reinicializações. Revise o plano e os custos no Render antes de aprovar a criação.

## Limites e segurança

- Vídeos de até 16 MB; trechos de até 10 segundos.
- Códigos de resgate expiram em 15 minutos e são de uso único.
- Os arquivos ficam apenas em memória no servidor e desaparecem após entrega ou reinicialização.
- O formato de Sound Sticker usa campos protobuf não documentados e engenharia reversa. Pode deixar de funcionar após atualizações do WhatsApp.
- Baileys é um cliente não oficial. O uso pode contrariar os termos do WhatsApp e causar restrições na conta. Use uma conta de serviço, não sua conta pessoal.
- O destinatário precisa ter uma versão do WhatsApp que suporte figurinhas sonoras.
