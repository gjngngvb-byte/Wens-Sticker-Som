# StickerSom 🎵

Editor web que prepara vídeos curtos em MP4 com áudio para usar no fluxo de criação de figurinhas sonoras do WhatsApp, quando esse recurso estiver liberado na conta.

## O que faz
1. **Imagem ou GIF + áudio:** transforma imagem/GIF em vídeo curto com uma faixa de áudio.
2. **Vídeo + som extra:** mistura o som original do vídeo (65%) com uma faixa externa ajustável.
3. **Vídeo com som original:** preserva o áudio do próprio vídeo.

Saída MP4 H.264/AAC, 512 × 512, duração configurável de 2 a 10 segundos. A conversão ocorre no navegador com MediaRecorder e FFmpeg.wasm. Na primeira conversão, o navegador baixa os módulos FFmpeg do CDN; depois podem ficar em cache.

## Como usar com o WhatsApp
1. Gere e baixe o MP4 no StickerSom.
2. No WhatsApp, abra uma conversa e toque em Figurinhas → Criar.
3. Escolha o MP4 e ajuste o recorte.
4. Se sua conta já tiver a opção de som, mantenha o áudio original ou escolha outro áudio.
5. Crie e envie a figurinha.

## Limitação importante
O WhatsApp está liberando figurinhas com som gradualmente. O formato sonoro é novo e não há uma API pública documentada para que um site externo empacote e instale diretamente esse tipo de figurinha. A documentação pública de stickers de terceiros cobre stickers estáticos e animados, sem especificar áudio. Portanto, este site prepara o vídeo-fonte para o editor nativo, mas não promete contornar a disponibilidade da função na conta do usuário. Se a opção de som não aparecer, o MP4 ainda pode ser enviado como vídeo comum.

## Executar
Abra `index.html` em um servidor estático ou publique o repositório. Não há backend; os arquivos são processados localmente.

## Privacidade
A mídia não é enviada para um servidor do StickerSom. Os módulos FFmpeg são baixados do CDN jsDelivr na primeira conversão.
