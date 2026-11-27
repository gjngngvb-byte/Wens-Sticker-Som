# StickerSom 🎵

Aplicação web para criar vídeos curtos com som a partir de imagens, GIFs ou vídeos.

## Modos disponíveis

1. **Imagem/GIF + áudio:** combina uma imagem ou GIF com uma faixa de áudio.
2. **Vídeo + áudio:** usa o vídeo enviado e adiciona uma faixa de áudio externa.
3. **Vídeo com som original:** preserva o áudio do próprio vídeo.

## Executar

Não há etapa de build nem dependências. Abra `index.html` em um navegador moderno ou publique o repositório com GitHub Pages.

## Como funciona

O processamento acontece localmente no navegador. A prévia usa elementos de mídia HTML e a exportação usa Canvas Capture Stream, Web Audio API e MediaRecorder. O resultado atual é um arquivo **WebM com áudio**, não um pacote de figurinha nativa do WhatsApp.

## Compatibilidade WhatsApp

O suporte a figurinhas com áudio não é universal em todos os aparelhos/versões do WhatsApp. O projeto não promete instalação direta como sticker nativo. A exportação atual permite baixar e compartilhar o vídeo gerado. Uma integração nativa exigirá validar o formato e as APIs oficialmente suportados pelo WhatsApp no momento da implementação.

## Próximos passos

- Validar formato oficial de sticker com áudio e fluxo de importação, caso disponível.
- Adicionar corte e sincronização de áudio.
- Adicionar conversão/transcodificação para formatos adicionais.
- Testar exportação em Safari/iOS e navegadores Android.

## Privacidade

Os arquivos são processados no próprio navegador e não são enviados a um servidor nesta versão.
