import path from "node:path";
import { app, BrowserWindow, Menu, Tray, ipcMain } from "electron";
import { getConfig, setToken, setBackendUrl } from "./config";
import { start as startConnection, reconnectNow, setStateListener, setErrorListener, type ConnectionState } from "./connection";
import { scanForPrinters } from "./networkScan";

let tray: Tray | null = null;
let settingsWindow: BrowserWindow | null = null;
let currentState: ConnectionState = "disconnected";
let lastError: string | null = null;

const stateLabel: Record<ConnectionState, string> = {
  connected: "Conectado",
  connecting: "Conectando...",
  disconnected: "Não conectado",
};

// Um único ícone (o .ico de verdade fornecido em assets/) pra bandeja e pra
// janela — o estado (conectado/conectando/desconectado) aparece no tooltip e
// no menu, não trocando de imagem. As duas variantes PNG (tray-connected/
// tray-disconnected) eram placeholders de 1x1 pixel — por isso "não
// aparecia" ícone nenhum antes, mesmo com um .ico de verdade na pasta: nada
// no código chegava a referenciar esse arquivo.
const ICON_PATH = path.join(__dirname, "..", "assets", "icon.ico");

function rebuildTrayMenu(): void {
  if (!tray) return;
  tray.setToolTip(`Tempero Print Service — ${stateLabel[currentState]}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Status: ${stateLabel[currentState]}`, enabled: false },
      { type: "separator" },
      { label: "Configurações...", click: openSettingsWindow },
      { label: "Testar conexão", click: () => reconnectNow() },
      { type: "separator" },
      { label: "Sair", click: () => app.quit() },
    ])
  );
}

function openSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 640,
    resizable: true,
    title: "Tempero Print Service — Configurações",
    icon: ICON_PATH,
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadFile(path.join(__dirname, "settings-window", "index.html"));
  settingsWindow.on("closed", () => (settingsWindow = null));
}

app.whenReady().then(() => {
  app.setLoginItemSettings({ openAtLogin: true });

  tray = new Tray(ICON_PATH);
  rebuildTrayMenu();

  setStateListener((state) => {
    currentState = state;
    if (state === "connected" || state === "connecting") lastError = null;
    rebuildTrayMenu();
    settingsWindow?.webContents.send("connection:state", state);
  });
  setErrorListener((message) => {
    lastError = message;
    settingsWindow?.webContents.send("connection:error", message);
  });

  startConnection();

  // Primeira instalação: sem token ainda, abre a tela de configuração direto
  // pra não deixar o operador procurando o ícone da bandeja sem saber o que fazer.
  if (!getConfig().token) openSettingsWindow();
});

// Sem listener em "window-all-closed" de propósito: por padrão o Electron só
// encerra o processo se algo chamar app.quit() — como só fazemos isso no
// item "Sair" do menu da bandeja, o app fica vivo mesmo sem nenhuma janela
// aberta, que é o comportamento esperado de um agente em segundo plano.

// Cada handler devolve { ok, error? } em vez de deixar uma exceção rejeitar
// a Promise crua — o clique de "Salvar" travava sem feedback nenhum quando
// connect() lançava (URL inválida), já que o handler original não pegava
// esse erro. Agora qualquer falha aqui vira uma resposta normal que o
// renderer sabe mostrar.
ipcMain.handle("config:get", () => ({ ...getConfig(), lastError }));

ipcMain.handle("config:save-token", (_e, token: string) => {
  try {
    setToken(token);
    reconnectNow();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle("config:save-backend-url", (_e, url: string) => {
  try {
    setBackendUrl(url);
    reconnectNow();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
});

ipcMain.handle("connection:get-state", () => currentState);

// Fire-and-forget (não é handle/invoke) porque a varredura streama achados
// aos poucos em vez de devolver tudo de uma vez — feedback mais cedo pro
// operador, já que um /24 inteiro pode levar alguns segundos.
ipcMain.on("network:scan-printers", (event) => {
  scanForPrinters((printer) => {
    event.sender.send("network:printer-found", printer);
  }).then(() => {
    event.sender.send("network:scan-done");
  });
});
