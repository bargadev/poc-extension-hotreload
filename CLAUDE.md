# poc-extension-hotreload — instruções do projeto

Extensão MV3 que injeta uma sidebar no Google Meet com transcrição + notas, com
hot-reload via WebSocket em dev.

## Referência de engenharia reversa: Tactiq

Repo privado local: `../tactiq-extension-reference/` (GitHub privado:
`bargadev/tactiq-extension-reference`). É o bundle **proprietário** da extensão Tactiq,
extraído só como **referência de leitura** — NÃO copiar código verbatim pro nosso repo,
NÃO tornar público, NÃO redistribuir.

Usamos como referência para descobrir como o Tactiq captura a legenda do Meet **sem
overlay nativo ativo**. Arquivos-chave lá:
- `googlemeet.inline.js` — o hook de WebRTC (roda no mundo MAIN).
- `rtcinjector.js` — injeta o inline em `document_start`.
- `manifest.json` — registro de content scripts / web_accessible_resources.

Nossas anotações da análise (não versionadas, gitignored): `TACTIQ_NOTES.md` na raiz.

## Descoberta principal

Tactiq **não lê o DOM** da legenda: ele **intercepta os data channels WebRTC** do Meet
(`captions`, `media-session`, `collections`, `meet_messages`) e decodifica um protobuf.
Por isso captura com o botão CC "off" e sem o overlay dos 304px. Detalhes e schema
protobuf em `TACTIQ_NOTES.md`.

Nossa implementação atual (`src/sidebar/useTranscription.ts`) ainda usa a abordagem DOM
(exige a legenda nativa ligada). A migração pro WebRTC está em PoC na branch
`poc/webrtc-caption-sniff` (`extension/rtc-sniffer.js`).

## Limitação conhecida
O toggle CC do Meet é gated em `event.isTrusted` — não dá pra ligar via content script.
O seletor de **idioma**, porém, aceita clique sintético. Ver memória do projeto.
