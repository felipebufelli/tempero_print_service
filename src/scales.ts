import net from "node:net";
import path from "node:path";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { splitFrames, parseFrame, StabilityDetector } from "./scaleParser";

// Mesmo esquema do PRINT_SCRIPT_PATH em connection.ts — o powershell.exe não
// enxerga dentro do app.asar, então usa a cópia desempacotada.
const SERIAL_SCRIPT_PATH = path.join(__dirname, "..", "assets", "scale-serial.ps1").replace("app.asar", "app.asar.unpacked");

// Mandada pelo backend (mensagem "scales-config") ao conectar e sempre que
// uma balança muda — ver tempero_api/src/services/scales.ts.
export type ScaleConfig = {
  id: string;
  connection_type: "serial" | "network";
  serial_port: string | null;
  baud_rate: number;
  ip_address: string | null;
  port: number | null;
  protocol: "enq" | "continuous";
  tare_grams: number;
  min_weight_grams: number;
};

export type ScaleReading = { grams: number | null; stable: boolean; connected: boolean; error: string | null };

const POLL_MS = 300;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;
// Sem nenhum byte por esse tempo a leitura deixa de valer (cabo solto,
// balança desligada) — o "Ler peso" da tela mostra desconectada.
const STALE_MS = 3000;

// Prato estabilizou: o agente avisa o backend (connection.ts manda
// "scale-weight"), que gera a comanda.
type WeightListener = (scaleId: string, grossGrams: number) => void;

class ScaleRunner {
  private child: ChildProcess | null = null;
  private socket: net.Socket | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = RECONNECT_MIN_MS;
  private stopped = false;
  private buffer = "";
  private detector: StabilityDetector;
  private lastGrams: number | null = null;
  private lastDataAt = 0;
  private lastError: string | null = null;

  constructor(
    readonly config: ScaleConfig,
    private onWeight: WeightListener
  ) {
    this.detector = new StabilityDetector(config.tare_grams, config.min_weight_grams);
  }

  start(): void {
    this.stopped = false;
    if (this.config.connection_type === "serial") this.openSerial();
    else this.openNetwork();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.closeConnection();
  }

  reading(): ScaleReading {
    const connected = Date.now() - this.lastDataAt < STALE_MS;
    return {
      grams: connected ? this.lastGrams : null,
      stable: connected && this.detector.isStable(Date.now()),
      connected,
      error: connected ? null : this.lastError ?? "Sem resposta da balança",
    };
  }

  private closeConnection(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.child?.kill();
    this.child = null;
    this.socket?.destroy();
    this.socket = null;
  }

  private scheduleReconnect(error: string): void {
    this.lastError = error;
    this.closeConnection();
    if (this.stopped) return;
    console.warn(`[balanca ${this.config.id}] ${error} — tentando de novo em ${this.reconnectDelay / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
      this.start();
    }, this.reconnectDelay);
  }

  // Serial via PowerShell (assets/scale-serial.ps1) — mesmo motivo do
  // print-raw.ps1: sem módulo nativo. O script devolve cada leitura em hex.
  private openSerial(): void {
    const args = [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      SERIAL_SCRIPT_PATH,
      "-PortName",
      this.config.serial_port ?? "",
      "-BaudRate",
      String(this.config.baud_rate),
      "-PollMs",
      String(this.config.protocol === "enq" ? POLL_MS : 0),
      "-ParentPid",
      String(process.pid),
    ];
    const child = spawn("powershell.exe", args, { windowsHide: true });
    this.child = child;

    let stdoutRest = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = (stdoutRest + chunk.toString()).split(/\r?\n/);
      stdoutRest = lines.pop() ?? "";
      for (const line of lines) {
        const hex = line.trim();
        if (!hex) continue;
        const bytes = Buffer.from(hex.split("-").map((h) => parseInt(h, 16)));
        this.handleData(bytes);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", (err) => {
      if (this.child === child) this.scheduleReconnect(`Não foi possível executar o PowerShell: ${err.message}`);
    });
    child.on("close", (code) => {
      if (this.child !== child) return;
      const message = stderr.trim().split(/\r?\n/)[0] || `leitor serial saiu com código ${code}`;
      this.scheduleReconnect(`Porta ${this.config.serial_port}: ${message}`);
    });
  }

  private openNetwork(): void {
    const socket = net.createConnection({ host: this.config.ip_address ?? "", port: this.config.port ?? 0 });
    this.socket = socket;
    socket.setTimeout(10_000);

    socket.on("connect", () => {
      if (this.config.protocol === "enq") {
        this.pollTimer = setInterval(() => socket.write(Buffer.from([0x05])), POLL_MS);
      }
    });
    socket.on("data", (bytes) => this.handleData(bytes));
    socket.on("timeout", () => {
      if (this.socket === socket) this.scheduleReconnect("Balança de rede sem resposta");
    });
    socket.on("error", (err) => {
      if (this.socket === socket) this.scheduleReconnect(`Balança de rede: ${err.message}`);
    });
    socket.on("close", () => {
      if (this.socket === socket) this.scheduleReconnect("Conexão com a balança de rede fechada");
    });
  }

  private handleData(bytes: Buffer): void {
    const { frames, rest } = splitFrames(this.buffer + bytes.toString("latin1"));
    this.buffer = rest;
    for (const frame of frames) {
      const parsed = parseFrame(frame);
      if (!parsed) continue;
      const now = Date.now();
      this.lastDataAt = now;
      this.reconnectDelay = RECONNECT_MIN_MS;
      this.lastError = null;
      this.lastGrams = "invalid" in parsed ? null : parsed.grams;
      const trigger = this.detector.push(parsed, now);
      if (trigger != null) this.onWeight(this.config.id, trigger);
    }
  }
}

const runners = new Map<string, ScaleRunner>();
let weightListener: WeightListener = () => {};

export function setWeightListener(listener: WeightListener): void {
  weightListener = listener;
}

// Abre/fecha as conexões conforme a lista nova. Balança com configuração
// idêntica continua rodando (não perde o estado "prato já enviado" — senão
// qualquer edição de outra balança geraria comanda de novo pro prato parado).
export function applyScalesConfig(configs: ScaleConfig[]): void {
  const next = new Map(configs.map((c) => [c.id, c]));
  for (const [id, runner] of runners) {
    const config = next.get(id);
    if (!config || JSON.stringify(config) !== JSON.stringify(runner.config)) {
      runner.stop();
      runners.delete(id);
    }
  }
  for (const config of configs) {
    if (runners.has(config.id)) continue;
    const runner = new ScaleRunner(config, (id, grams) => weightListener(id, grams));
    runners.set(config.id, runner);
    runner.start();
  }
}

export function stopAllScales(): void {
  for (const runner of runners.values()) runner.stop();
  runners.clear();
}

export function readScale(scaleId: string): ScaleReading {
  const runner = runners.get(scaleId);
  if (!runner) return { grams: null, stable: false, connected: false, error: "Balança não está aberta neste agente" };
  return runner.reading();
}

// Portas COM que o Windows enxerga — seletor da balança serial no painel.
export function listSerialPorts(callback: (ports: string[]) => void): void {
  execFile(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "[System.IO.Ports.SerialPort]::GetPortNames()"],
    { windowsHide: true },
    (err, stdout) => {
      const ports = err
        ? []
        : Array.from(
            new Set(
              stdout
                .split(/\r?\n/)
                .map((s) => s.trim())
                .filter(Boolean)
            )
          ).sort();
      callback(ports);
    }
  );
}
