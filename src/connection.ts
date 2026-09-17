import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { spawn, execFile } from "node:child_process";
import WebSocket from "ws";
import { getConfig } from "./config";

// Empacotado em assets/ (ver package.json → build.files) — mesmo padrão do
// ICON_PATH em main.ts: __dirname aqui é dist/, então "../assets" é a pasta
// assets/ na raiz do projeto tanto em dev quanto no app instalado.
//
// O .replace() é necessário porque o electron-builder empacota tudo dentro
// de um app.asar (um arquivo só, que o Node/Electron sabe ler de forma
// transparente) — mas quem abre esse script é o powershell.exe, um processo
// externo que não entende asar, então o caminho de dentro dele "não existe"
// pra ele. `asarUnpack` no package.json (build.asarUnpack) copia esse
// arquivo específico pra fora, numa pasta app.asar.unpacked ao lado do
// app.asar, e é esse o caminho que precisa ser usado aqui. Em dev (sem
// asar nenhum) __dirname nunca contém "app.asar", então o replace vira
// no-op e o caminho original é usado normalmente.
const PRINT_SCRIPT_PATH = path.join(__dirname, "..", "assets", "print-raw.ps1").replace("app.asar", "app.asar.unpacked");

export type ConnectionState = "disconnected" | "connecting" | "connected";

// Rede é resolvida abrindo TCP direto pro IP:porta; USB é a impressora
// instalada localmente no Windows, identificada pelo nome com que o SO a
// enxerga — não passa IP nenhum porque não tem.
type PrintTarget = { kind: "network"; ip: string; port: number } | { kind: "usb"; printerName: string };
type PrintJob = { type: "print"; jobId: string; buffer: string; target: PrintTarget };
type ListPrintersRequest = { type: "list-printers"; requestId: string };

const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const PRINT_SOCKET_TIMEOUT_MS = 5000;

let ws: WebSocket | null = null;
let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer: NodeJS.Timeout | null = null;
let manuallyStopped = false;
let onStateChange: (state: ConnectionState) => void = () => {};
let onConnectionError: (message: string) => void = () => {};

export function setStateListener(listener: (state: ConnectionState) => void): void {
  onStateChange = listener;
}

// Última falha legível — pra tela de configuração conseguir mostrar "por que"
// além do badge de status (ex.: URL inválida, token recusado).
export function setErrorListener(listener: (message: string) => void): void {
  onConnectionError = listener;
}

export function start(): void {
  manuallyStopped = false;
  connect();
}

export function stop(): void {
  manuallyStopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  ws?.close();
  ws = null;
}

// Chamado depois de salvar um token novo na tela de configuração — força
// reconectar já, em vez de esperar o backoff em andamento.
export function reconnectNow(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  ws?.close();
  reconnectDelay = RECONNECT_MIN_MS;
  connect();
}

// A URL guardada é a origem HTTP(S) normal do backend (mesma usada por
// qualquer chamada de API) — WebSocket precisa do esquema ws(s), então troca
// aqui em vez de exigir que quem configura o agente já saiba disso.
function toWebSocketOrigin(url: string): string {
  return url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
}

function connect(): void {
  const { backendUrl, token } = getConfig();
  if (!token) {
    onStateChange("disconnected");
    return;
  }

  onStateChange("connecting");
  const url = `${toWebSocketOrigin(backendUrl)}/api/print-agent/ws?token=${encodeURIComponent(token)}`;
  try {
    ws = new WebSocket(url);
  } catch (err) {
    // URL malformada (ex.: erro de digitação no endereço do backend) não
    // pode travar o resto do app — reporta e deixa o backoff tentar de novo
    // (não vai adiantar até a URL ser corrigida, mas não trava a UI).
    onConnectionError(`Endereço do backend inválido: ${(err as Error).message}`);
    onStateChange("disconnected");
    scheduleReconnect();
    return;
  }

  ws.on("open", () => {
    reconnectDelay = RECONNECT_MIN_MS;
    onStateChange("connected");
  });

  ws.on("message", (raw) => {
    let msg: PrintJob | ListPrintersRequest;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "print") handlePrintJob(msg);
    else if (msg.type === "list-printers") handleListPrinters(msg.requestId);
  });

  ws.on("close", (code) => {
    if (code === 4001) onConnectionError("Código de pareamento inválido — gere um novo na tela Impressoras.");
    onStateChange("disconnected");
    scheduleReconnect();
  });

  ws.on("error", (err) => {
    onConnectionError(err.message);
    // "close" dispara logo em seguida — reconexão é tratada lá, não aqui.
  });
}

function scheduleReconnect(): void {
  if (manuallyStopped) return;
  reconnectTimer = setTimeout(() => {
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
    connect();
  }, reconnectDelay);
}

// Repassa o buffer recebido do backend pro destino certo — TCP local pro
// IP:porta (rede) ou spooler do Windows pelo nome da impressora (USB). Rede
// só funciona porque o agente está na mesma rede dela; USB só funciona
// porque a impressora está fisicamente plugada nesse PC.
function handlePrintJob(job: PrintJob): void {
  const sendResult = (ok: boolean, error?: string) => {
    ws?.send(JSON.stringify({ type: "result", jobId: job.jobId, ok, error }));
  };

  if (job.target.kind === "usb") {
    printToUsb(job.target.printerName, Buffer.from(job.buffer, "base64"), sendResult);
  } else {
    printToNetwork(job.target.ip, job.target.port, Buffer.from(job.buffer, "base64"), sendResult);
  }
}

function printToNetwork(ip: string, port: number, buffer: Buffer, sendResult: (ok: boolean, error?: string) => void): void {
  const socket = net.createConnection({ host: ip, port, timeout: PRINT_SOCKET_TIMEOUT_MS });

  socket.on("connect", () => socket.end(buffer));
  socket.on("close", (hadError) => {
    if (!hadError) sendResult(true);
  });
  socket.on("timeout", () => {
    socket.destroy();
    sendResult(false, "Tempo esgotado ao conectar na impressora");
  });
  socket.on("error", (err) => sendResult(false, err.message));
}

// Manda os bytes pro spooler do Windows via um script PowerShell que fala
// direto com winspool.drv (assets/print-raw.ps1) — de propósito, em vez de
// um módulo nativo tipo "printer"/node-gyp: PowerShell já vem em qualquer
// Windows, então nem quem desenvolve nem quem instala o agente no
// restaurante precisa de Visual Studio Build Tools só por causa disso. O
// buffer vai por arquivo temporário (não por stdin/argv) pra não correr
// risco de corromper bytes binários na travessia do processo.
function printToUsb(printerName: string, buffer: Buffer, sendResult: (ok: boolean, error?: string) => void): void {
  const tempFile = path.join(os.tmpdir(), `tempero-print-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.bin`);

  fs.writeFile(tempFile, buffer, (writeErr) => {
    if (writeErr) {
      sendResult(false, `Não foi possível preparar o arquivo de impressão: ${writeErr.message}`);
      return;
    }

    const cleanup = () => fs.unlink(tempFile, () => {});
    const ps = spawn(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        PRINT_SCRIPT_PATH,
        "-PrinterName",
        printerName,
        "-FilePath",
        tempFile,
      ],
      { windowsHide: true }
    );

    let stderr = "";
    ps.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    ps.on("error", (err) => {
      cleanup();
      sendResult(false, `Não foi possível executar o PowerShell: ${err.message}`);
    });
    ps.on("close", (code) => {
      cleanup();
      if (code === 0) sendResult(true);
      else sendResult(false, stderr.trim() || `PowerShell saiu com código ${code}`);
    });
  });
}

// Responde ao backend com as impressoras que o Windows desse PC enxerga —
// usado pra popular o seletor de impressora USB na tela Impressoras, sem o
// operador ter que digitar o nome exato de cabeça. Win32_Printer via CIM
// (em vez do cmdlet Get-Printer) porque é a API mais antiga/universal —
// disponível mesmo em instalações mais enxutas do Windows.
function handleListPrinters(requestId: string): void {
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance -ClassName Win32_Printer | Select-Object -ExpandProperty Name"],
    { windowsHide: true },
    (err, stdout) => {
      const names = err
        ? []
        : stdout
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
      ws?.send(JSON.stringify({ type: "printers-list", requestId, printers: names }));
    }
  );
}
