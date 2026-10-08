# Lê uma balança serial (porta COM) e repassa os bytes recebidos pro agente
# (tempero_print_service/src/scales.ts) pelo stdout, uma linha por leitura,
# em hexadecimal separado por "-" (ex.: 02-30-30-34-35-32-03) — texto puro,
# sem risco de corromper bytes de controle (STX/ETX) na travessia do pipe.
#
# Mesmo motivo do print-raw.ps1: System.IO.Ports já vem no .NET de qualquer
# Windows, então o agente não depende de módulo nativo (serialport/node-gyp).
#
# -PollMs > 0: protocolo "enq" (Toledo/Filizola/Urano) — manda ENQ (0x05) a
# cada PollMs e lê a resposta. -PollMs 0: balança contínua, só lê.
param(
  [Parameter(Mandatory = $true)][string]$PortName,
  [int]$BaudRate = 9600,
  [int]$PollMs = 0,
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Stop'
# Mensagens de erro (stderr) em UTF-8 — sem isso saem no codepage do console
# ("n�o existe") quando o agente mostra o motivo no painel.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$port = New-Object System.IO.Ports.SerialPort $PortName, $BaudRate, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
$port.ReadTimeout = 500
$port.WriteTimeout = 500
# Vários conversores USB-serial (e algumas balanças) só transmitem com DTR/RTS
# ligados.
$port.DtrEnable = $true
$port.RtsEnable = $true
try {
  $port.Open()
}
catch {
  $inner = if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message }
  [Console]::Error.WriteLine($inner)
  exit 1
}

$enq = [byte[]](5)
$interval = if ($PollMs -gt 0) { $PollMs } else { 100 }
$tick = 0

try {
  while ($true) {
    if ($PollMs -gt 0) { $port.Write($enq, 0, 1) }
    Start-Sleep -Milliseconds $interval

    $available = $port.BytesToRead
    if ($available -gt 0) {
      $buffer = New-Object byte[] $available
      $read = $port.Read($buffer, 0, $available)
      [Console]::Out.WriteLine([BitConverter]::ToString($buffer, 0, $read))
      [Console]::Out.Flush()
    }

    # Se o agente morrer sem matar este processo, não fica preso segurando a
    # porta COM pra sempre.
    $tick++
    if ($ParentPid -gt 0 -and ($tick % 20) -eq 0) {
      if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { break }
    }
  }
}
finally {
  $port.Close()
}
