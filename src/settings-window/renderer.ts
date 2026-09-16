type SaveResult = { ok: boolean; error?: string };
type FoundPrinter = { ip: string; port: number };

type Api = {
  getConfig: () => Promise<{ backendUrl: string; token: string | null; lastError: string | null }>;
  saveToken: (token: string) => Promise<SaveResult>;
  saveBackendUrl: (url: string) => Promise<SaveResult>;
  getState: () => Promise<string>;
  onStateChange: (callback: (state: string) => void) => void;
  onError: (callback: (message: string) => void) => void;
  scanPrinters: () => void;
  onPrinterFound: (callback: (printer: FoundPrinter) => void) => void;
  onScanDone: (callback: () => void) => void;
};

// Tudo dentro de um try/catch visível: se algo aqui falhar (ex.: window.api
// não existir por algum motivo), o erro aparece na própria janela em vez de
// só no console do DevTools — foi exatamente esse tipo de falha silenciosa
// que fez o botão "Salvar" parecer não fazer nada antes dessa correção.
try {
  const api = (window as unknown as { api: Api }).api;
  if (!api) throw new Error("Ponte com o processo principal não carregou (window.api ausente).");

  const statusEl = document.getElementById("status") as HTMLSpanElement;
  const errorEl = document.getElementById("error") as HTMLDivElement;
  const tokenEl = document.getElementById("token") as HTMLInputElement;
  const backendUrlEl = document.getElementById("backendUrl") as HTMLInputElement;
  const saveEl = document.getElementById("save") as HTMLButtonElement;
  const saveUrlEl = document.getElementById("saveUrl") as HTMLButtonElement;
  const advancedToggleEl = document.getElementById("advancedToggle") as HTMLButtonElement;
  const advancedEl = document.getElementById("advanced") as HTMLDivElement;
  const scanEl = document.getElementById("scan") as HTMLButtonElement;
  const scanStatusEl = document.getElementById("scanStatus") as HTMLDivElement;
  const scanResultsEl = document.getElementById("scanResults") as HTMLDivElement;

  const stateLabel: Record<string, string> = {
    connected: "Conectado",
    connecting: "Conectando...",
    disconnected: "Não conectado",
  };

  function renderState(state: string): void {
    statusEl.textContent = stateLabel[state] ?? state;
    statusEl.className = `status ${state}`;
  }

  function showError(message: string | null): void {
    errorEl.textContent = message ?? "";
    errorEl.classList.toggle("visible", !!message);
  }

  api.getConfig().then((config) => {
    if (config.token) tokenEl.value = config.token;
    backendUrlEl.value = config.backendUrl;
    showError(config.lastError);
  });
  api.getState().then(renderState);
  api.onStateChange(renderState);
  api.onError(showError);

  async function withButton(button: HTMLButtonElement, action: () => Promise<SaveResult>): Promise<void> {
    button.disabled = true;
    try {
      const result = await action();
      showError(result.ok ? null : result.error ?? "Erro desconhecido");
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      button.disabled = false;
    }
  }

  saveEl.addEventListener("click", () => {
    const token = tokenEl.value.trim();
    if (!token) return;
    void withButton(saveEl, () => api.saveToken(token));
  });

  saveUrlEl.addEventListener("click", () => {
    const url = backendUrlEl.value.trim();
    if (!url) return;
    void withButton(saveUrlEl, () => api.saveBackendUrl(url));
  });

  // Escondido por padrão — o time do restaurante só mexe no código de
  // pareamento; o endereço do backend fica disponível pra quem precisar
  // testar/depurar, sem aparecer de cara pra quem só vai colar o código.
  advancedToggleEl.addEventListener("click", () => {
    advancedEl.classList.toggle("visible");
  });

  function addPrinterRow(printer: FoundPrinter): void {
    const row = document.createElement("div");
    row.className = "scan-row";

    const label = document.createElement("span");
    label.className = "mono";
    label.textContent = `${printer.ip}:${printer.port}`;

    const copyBtn = document.createElement("button");
    copyBtn.className = "secondary";
    copyBtn.textContent = "Copiar IP";
    copyBtn.addEventListener("click", () => {
      navigator.clipboard.writeText(printer.ip);
      copyBtn.textContent = "Copiado!";
      setTimeout(() => (copyBtn.textContent = "Copiar IP"), 1500);
    });

    row.appendChild(label);
    row.appendChild(copyBtn);
    scanResultsEl.appendChild(row);
  }

  api.onPrinterFound(addPrinterRow);
  api.onScanDone(() => {
    scanEl.disabled = false;
    scanEl.textContent = "Buscar";
    if (scanResultsEl.children.length === 0) {
      scanStatusEl.textContent = "Nenhum equipamento respondeu na porta 9100 nessa rede.";
    } else {
      scanStatusEl.textContent = `${scanResultsEl.children.length} encontrada(s).`;
    }
  });

  scanEl.addEventListener("click", () => {
    scanResultsEl.innerHTML = "";
    scanStatusEl.textContent = "Buscando...";
    scanEl.disabled = true;
    scanEl.textContent = "Buscando...";
    api.scanPrinters();
  });
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  document.body.innerHTML = `<div style="color:#93321f;font-family:sans-serif;padding:16px;">Erro ao carregar a tela: ${message}</div>`;
}
