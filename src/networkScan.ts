import net from "node:net";
import os from "node:os";

export type FoundPrinter = { ip: string; port: number };

// 9100 é a porta raw ESC/POS padrão — a mesma que o resto do sistema já
// assume como default ao cadastrar uma impressora na tela Impressoras.
const SCAN_PORT = 9100;
const CONNECT_TIMEOUT_MS = 400;
const CONCURRENCY = 40;

// Assume /24 (255.255.255.0), de longe o caso mais comum em rede doméstica/
// pequeno comércio — cobre o cenário real sem precisar calcular CIDR a
// partir da máscara de sub-rede de verdade.
function localSubnetPrefixes(): string[] {
  const nets = os.networkInterfaces();
  const prefixes = new Set<string>();
  for (const addrs of Object.values(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) {
        const parts = addr.address.split(".");
        prefixes.add(`${parts[0]}.${parts[1]}.${parts[2]}.`);
      }
    }
  }
  return [...prefixes];
}

function probe(ip: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let done = false;
    const finish = (result: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, ip);
  });
}

// Varre toda a(s) sub-rede(s) local(is) procurando quem responde na porta
// 9100 — candidato a impressora térmica. Chama `onFound` assim que acha
// cada uma (a varredura inteira de um /24 leva poucos segundos com essa
// concorrência, mas mostrar achado por achado dá feedback mais cedo).
export async function scanForPrinters(onFound: (printer: FoundPrinter) => void): Promise<void> {
  const prefixes = localSubnetPrefixes();
  const hosts: string[] = [];
  for (const prefix of prefixes) {
    for (let i = 1; i <= 254; i++) hosts.push(`${prefix}${i}`);
  }

  let index = 0;
  async function worker(): Promise<void> {
    while (index < hosts.length) {
      const ip = hosts[index++];
      const found = await probe(ip, SCAN_PORT);
      if (found) onFound({ ip, port: SCAN_PORT });
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
}
