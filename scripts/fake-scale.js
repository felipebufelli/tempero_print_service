// Balança falsa pra testar o fluxo de comida por kilo sem balança de verdade.
//
// Sobe um servidor TCP que se comporta como uma balança de rede:
//   - modo "enq" (padrão): responde cada ENQ (0x05) com STX + peso em gramas
//     (5 dígitos, padrão Toledo/Filizola) + ETX;
//   - modo "continuous": manda "ST,GS,+  0.452kg\r\n" a cada 300 ms sozinha.
//
// Uso:
//   node scripts/fake-scale.js [porta] [enq|continuous]
// Depois cadastre no Temperô (Integrações > Balança) uma balança de Rede com
// IP 127.0.0.1 e a mesma porta, no PC onde o agente está rodando.
//
// No terminal, digite o peso BRUTO em gramas e Enter (ex.: 552). "0" = prato
// retirado. Para gerar outra comanda, volte pra 0 (ou pra tara) antes do
// próximo prato — o agente só dispara uma vez por prato.
const net = require("node:net");
const readline = require("node:readline");

const port = Number(process.argv[2] || 4001);
const mode = process.argv[3] === "continuous" ? "continuous" : "enq";
let grams = 0;

const frame = () =>
  mode === "enq"
    ? Buffer.concat([Buffer.from([0x02]), Buffer.from(String(grams).padStart(5, "0")), Buffer.from([0x03])])
    : Buffer.from(`ST,GS,+${(grams / 1000).toFixed(3).padStart(8)}kg\r\n`);

net
  .createServer((socket) => {
    console.log("agente conectado");
    let timer = null;
    if (mode === "continuous") timer = setInterval(() => socket.write(frame()), 300);
    else socket.on("data", (data) => data.includes(0x05) && socket.write(frame()));
    socket.on("close", () => {
      if (timer) clearInterval(timer);
      console.log("agente desconectado");
    });
    socket.on("error", () => {});
  })
  .listen(port, () => {
    console.log(`Balança falsa (${mode}) em 127.0.0.1:${port}`);
    console.log("Digite o peso em gramas e Enter (0 = sem prato):");
  });

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const value = Number(line.trim().replace(",", "."));
  if (!Number.isFinite(value) || value < 0) return console.log("Peso inválido");
  grams = Math.round(value);
  console.log(`Peso atual: ${(grams / 1000).toFixed(3)} kg`);
});
