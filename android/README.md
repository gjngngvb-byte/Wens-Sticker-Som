# StickerSom para Android (teste experimental)

Este modo não usa WhatsApp Web no navegador. O processamento roda localmente no Android pelo Termux, e o WhatsApp é conectado como um aparelho vinculado usando código numérico (sem precisar escanear QR na mesma tela).

## Instalação

1. Instale **Termux** pela página oficial do projeto: https://termux.dev/
2. Abra o Termux e execute:

```sh
pkg install -y curl
curl -L https://raw.githubusercontent.com/gjngngvb-byte/Wens-Sticker-Som/main/android/install-termux.sh -o install-stickersom.sh
bash install-stickersom.sh
```

3. Informe seu número com DDI e DDD quando solicitado.
4. O Termux mostrará um código de vinculação.
5. No WhatsApp Android, abra **Configurações → Aparelhos conectados → Conectar aparelho → Conectar com número de telefone** e informe o código.

## Como testar

Depois que o bot conectar, envie um vídeo com a legenda `!som` para uma conversa com você mesmo. O bot deverá responder no mesmo chat com uma figurinha sonora. Para usar uma conversa diferente, encaminhe o vídeo para o número vinculado ou envie o vídeo com `!som` na conversa desejada.

## Limitações e segurança

- **Teste experimental, não oficial.** O envio usa engenharia reversa do protocolo WhatsApp via Baileys. Uma atualização do WhatsApp pode interromper o funcionamento.
- A conexão aparece em **Aparelhos conectados**. Você pode revogá-la a qualquer momento nessa tela.
- Automação por cliente não oficial pode violar os termos do WhatsApp e causar restrições ou bloqueio da conta. Para o primeiro teste, prefira um número secundário.
- Não compartilhe o código de vinculação, a pasta de sessão ou arquivos de autenticação.
- O telefone precisa permanecer ligado e o Termux pode precisar de exclusão da otimização de bateria para manter o processo ativo.
- Este método não transforma o StickerSom em um aplicativo APK independente; é um teste Android local pelo Termux. O editor visual do site continua separado.
