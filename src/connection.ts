import net from "node:net";
import WebSocket from "ws";
import { getConfig } from "./config";

export type ConnectionState = "disconnected" | "connecting" | "connected";

type PrintJob = { type: "print"; jobId: string; ip: string; port: number; buffer: string };

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
    let msg: PrintJob;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === "print") handlePrintJob(msg);
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

// Repassa o buffer recebido do backend pro IP:porta local da impressora —
// essa é a parte que só funciona porque o agente está na mesma rede dela.
function handlePrintJob(job: PrintJob): void {
  const buffer = Buffer.from(job.buffer, "base64");
  const socket = net.createConnection({ host: job.ip, port: job.port, timeout: PRINT_SOCKET_TIMEOUT_MS });

  const sendResult = (ok: boolean, error?: string) => {
    ws?.send(JSON.stringify({ type: "result", jobId: job.jobId, ok, error }));
  };

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
