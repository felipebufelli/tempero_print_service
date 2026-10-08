// Interpretação dos bytes que a balança manda — separado de scales.ts (que
// cuida de conexão/processo) pra dar pra testar sem balança nenhuma.
//
// Formatos cobertos:
//   - Toledo/Filizola/Urano em modo pedido (ENQ): STX + peso + ETX, peso em
//     5-6 dígitos sem vírgula com 3 casas implícitas ("00452" = 0,452 kg).
//     Instável vem como "IIIII", sobrecarga "SSSSS", negativo "NNNNN".
//   - Balanças contínuas: linhas terminadas em CR/LF tipo "ST,GS,+  0.452kg"
//     ou "PESO:   0,452 kg". "US" no começo = instável (padrão A&D e afins).

export type ParsedReading = { grams: number; stable: boolean | null } | { invalid: "unstable" | "overload" | "negative" };

const STX = "\x02";
const ETX = "\x03";

// Divide o buffer acumulado em quadros completos — STX..ETX ou linhas
// CR/LF — e devolve o resto (quadro ainda incompleto) pra próxima leitura.
export function splitFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  for (;;) {
    const stx = rest.indexOf(STX);
    const etx = stx >= 0 ? rest.indexOf(ETX, stx + 1) : -1;
    const eol = rest.search(/[\r\n]/);

    if (stx >= 0 && etx > stx && (eol < 0 || stx < eol)) {
      frames.push(rest.slice(stx + 1, etx));
      rest = rest.slice(etx + 1);
      continue;
    }
    if (eol >= 0 && (stx < 0 || eol < stx)) {
      const line = rest.slice(0, eol);
      if (line.trim()) frames.push(line);
      rest = rest.slice(eol + 1);
      continue;
    }
    break;
  }
  // Lixo sem fim de quadro nunca vira leitura — corta pra não crescer
  // indefinidamente se a balança estiver configurada em outro protocolo.
  if (rest.length > 256) rest = rest.slice(-64);
  return { frames, rest };
}

export function parseFrame(frame: string): ParsedReading | null {
  const text = frame.replace(/[\x00-\x1f]/g, " ").trim();
  if (!text) return null;
  if (/^I{3,}$/i.test(text)) return { invalid: "unstable" };
  if (/^S{3,}$/i.test(text)) return { invalid: "overload" };
  if (/^N{3,}$/i.test(text)) return { invalid: "negative" };

  const match = text.match(/([-+])?\s*(\d+(?:[.,]\d+)?)\s*(kg|g)?/i);
  if (!match) return null;
  const [, sign, number, unit] = match;
  const hasDecimal = /[.,]/.test(number);
  const value = Number(number.replace(",", "."));
  if (!Number.isFinite(value)) return null;

  let grams: number;
  if (unit?.toLowerCase() === "g") grams = value;
  else if (unit?.toLowerCase() === "kg" || hasDecimal) grams = value * 1000;
  // Sem vírgula e sem unidade: 3 casas implícitas em kg = o número já é em
  // gramas (padrão Toledo/Filizola "00452").
  else grams = value;

  if (sign === "-") return { invalid: "negative" };

  const stable = /^US\b/i.test(text) ? false : /^ST\b/i.test(text) ? true : null;
  return { grams: Math.round(grams), stable };
}

// Decide quando um prato "estabilizou" a partir das leituras sucessivas.
// O peso é considerado estável quando todas as leituras dos últimos
// STABLE_WINDOW_MS ficaram dentro de ±TOLERANCE_G (e a balança não disse
// explicitamente que está instável).
//
// Disparo único por prato: depois de disparar, só rearma quando o peso
// líquido volta pra perto de zero (prato retirado) — senão o mesmo prato
// parado na balança geraria uma comanda a cada leitura. Também nasce
// desarmado: se o agente (re)iniciar com um prato já em cima da balança, não
// gera comanda duplicada daquele prato.
export const STABLE_WINDOW_MS = 1200;
export const TOLERANCE_G = 4;

export class StabilityDetector {
  private samples: { at: number; grams: number }[] = [];
  private armed = false;

  constructor(
    private tareGrams: number,
    private minWeightGrams: number
  ) {}

  // Devolve o peso bruto a ser enviado quando o prato acabou de estabilizar
  // (uma vez só por prato), ou null.
  push(reading: ParsedReading, now: number): number | null {
    if ("invalid" in reading || reading.stable === false) {
      this.samples = [];
      return null;
    }
    this.samples.push({ at: now, grams: reading.grams });
    this.samples = this.samples.filter((s) => now - s.at <= STABLE_WINDOW_MS * 2);

    const net = reading.grams - this.tareGrams;
    if (net < this.minWeightGrams / 2) {
      this.armed = true;
      return null;
    }
    if (!this.armed || net < this.minWeightGrams || !this.isStable(now)) return null;

    this.armed = false;
    return reading.grams;
  }

  isStable(now: number): boolean {
    if (this.samples.length === 0) return false;
    const window = this.samples.filter((s) => now - s.at <= STABLE_WINDOW_MS);
    if (window.length === 0 || now - this.samples[0].at < STABLE_WINDOW_MS) return false;
    const values = window.map((s) => s.grams);
    return Math.max(...values) - Math.min(...values) <= TOLERANCE_G;
  }
}
