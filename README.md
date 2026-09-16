# tempero_print_service

Agente local de impressão do Temperô. Fica rodando dentro da rede do restaurante (ícone na bandeja do Windows), mantém uma conexão de saída (WebSocket) com o backend no Railway, e repassa pra impressora térmica local os cupons que o backend manda — pedido novo e comprovante de fechamento de caixa.

O backend nunca conecta nele — é o agente que liga pro backend e deixa a conexão aberta; o backend só escreve nessa conexão já existente quando tem um trabalho de impressão. Ver `tempero_api/src/ws/printAgentServer.ts` e `services/printAgentRegistry.ts` no repositório da API pro lado de lá.

## Como rodar em desenvolvimento

```bash
npm install
npm start
```

Isso compila o TypeScript e abre o app — sem janela visível por padrão, só o ícone na bandeja do Windows. Clique nele com o botão direito pra ver o menu (Status, Configurações, Testar conexão, Sair).

Na primeira vez (sem token salvo), a tela de configuração abre sozinha. Gere um código de pareamento na tela **Impressoras** do Temperô (bloco "Agente de impressão local") e cole ali.

## Pendências antes de distribuir de verdade

- **Ícone do instalador** — `assets/icon.ico` existe e já é usado na bandeja e na janela de configurações (`main.ts`), mas só tem uma camada de 32x32. O NSIS (instalador Windows que o electron-builder usa) exige pelo menos uma camada de 256x256 pro ícone do instalador/desinstalador/atalho — por isso `build.win.icon` está comentado/removido do `package.json` por enquanto (`npm run dist` usa o ícone padrão do Electron nesse ponto específico). Assim que houver um `.ico` com uma camada 256x256 (a maioria dos conversores gera isso automaticamente a partir de uma imagem de origem grande, tipo 512x512 ou 1024x1024), voltar a apontar `build.win.icon` pra `assets/icon.ico`.
- **Assinatura de código** — não configurada nessa primeira versão. O Windows vai avisar "aplicativo de fonte desconhecida" no instalador até isso ser resolvido (exige certificado pago).

## Gerar o instalador

```bash
npm run dist
```

Produz o instalador Windows (`.exe`, NSIS) em `release/` — configurado explicitamente em `package.json` → `build.directories.output`, separado da pasta `dist/` (que é só o TypeScript compilado). As duas pastas não podem ser a mesma: o electron-builder lê `files: ["dist/**/*"]` como os arquivos do app enquanto escreve o pacote final, e se os dois caminhos coincidirem ele acaba tentando empacotar o próprio `.exe` que ainda está escrevendo — no Windows isso trava o arquivo no meio da escrita (erro `UNKNOWN: unknown error, open '...\Tempero Print Service.exe'` na etapa `addWinAsarIntegrity`).
