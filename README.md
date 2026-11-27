# StickerSom 🔊

O StickerSom cria e envia **figurinhas nativas do WhatsApp com som** usando um motor experimental baseado em Baileys e FFmpeg.

## Android

O repositório inclui um app Android nativo para escolher vídeos, pré-visualizar, selecionar um trecho de até 10 segundos e enviar uma figurinha sonora para um número do WhatsApp. O motor de conversão e a sessão WhatsApp rodam localmente no Termux, no mesmo aparelho.

Consulte [android/README.md](android/README.md) para instalar o motor, obter o APK e usar o app.

## Limitações

O envio de figurinhas sonoras usa engenharia reversa de um formato não documentado oficialmente. Compatibilidade e funcionamento podem mudar com atualizações do WhatsApp. O destinatário precisa suportar a reprodução de figurinhas sonoras. A automação por cliente não oficial pode violar os termos do WhatsApp e resultar em restrições na conta.

O antigo editor web prepara arquivos de vídeo, mas não é necessário para o fluxo Android nativo.
