<#
  Manda um arquivo binário direto pro spooler do Windows como dado "RAW"
  (sem o Windows tentar interpretar/converter o conteúdo) — necessário
  porque o arquivo já vem pronto em ESC/POS, montado pelo backend.

  Existe como script em vez de módulo nativo (tipo "printer"/node-gyp) de
  propósito: essa é a única parte do agente que precisa falar com a API de
  impressão do Windows, e fazer isso via P/Invoke direto no winspool.drv
  evita depender de Visual Studio Build Tools tanto em quem desenvolve
  quanto em quem instala o agente no restaurante — PowerShell e .NET já
  vêm em qualquer Windows com o app.
#>
param(
  [Parameter(Mandatory = $true)][string]$PrinterName,
  [Parameter(Mandatory = $true)][string]$FilePath
)

$ErrorActionPreference = "Stop"

Add-Type -Namespace TemperoRawPrint -Name Native -MemberDefinition @"
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct DOCINFOW {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
}

[DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool OpenPrinter(string pPrinterName, out IntPtr phPrinter, IntPtr pDefault);

[DllImport("winspool.drv", SetLastError = true)]
public static extern bool ClosePrinter(IntPtr hPrinter);

[DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool StartDocPrinter(IntPtr hPrinter, int level, ref DOCINFOW pDocInfo);

[DllImport("winspool.drv", SetLastError = true)]
public static extern bool EndDocPrinter(IntPtr hPrinter);

[DllImport("winspool.drv", SetLastError = true)]
public static extern bool StartPagePrinter(IntPtr hPrinter);

[DllImport("winspool.drv", SetLastError = true)]
public static extern bool EndPagePrinter(IntPtr hPrinter);

[DllImport("winspool.drv", SetLastError = true)]
public static extern bool WritePrinter(IntPtr hPrinter, byte[] pBytes, int dwCount, out int dwWritten);
"@

function Fail($message) {
    $code = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw "$message (código Win32 $code)"
}

$bytes = [System.IO.File]::ReadAllBytes($FilePath)

$hPrinter = [IntPtr]::Zero
if (-not [TemperoRawPrint.Native]::OpenPrinter($PrinterName, [ref]$hPrinter, [IntPtr]::Zero)) {
    Fail "Não foi possível abrir a impressora '$PrinterName'"
}

try {
    $docInfo = New-Object TemperoRawPrint.Native+DOCINFOW
    $docInfo.pDocName = "Tempero"
    $docInfo.pOutputFile = $null
    $docInfo.pDataType = "RAW"

    if (-not [TemperoRawPrint.Native]::StartDocPrinter($hPrinter, 1, [ref]$docInfo)) {
        Fail "Falha ao iniciar o trabalho de impressão"
    }

    try {
        if (-not [TemperoRawPrint.Native]::StartPagePrinter($hPrinter)) {
            Fail "Falha ao iniciar a página de impressão"
        }

        try {
            $written = 0
            if (-not [TemperoRawPrint.Native]::WritePrinter($hPrinter, $bytes, $bytes.Length, [ref]$written)) {
                Fail "Falha ao escrever na impressora"
            }
            if ($written -ne $bytes.Length) {
                throw "Só $written de $($bytes.Length) bytes foram escritos"
            }
        }
        finally {
            [TemperoRawPrint.Native]::EndPagePrinter($hPrinter) | Out-Null
        }
    }
    finally {
        [TemperoRawPrint.Native]::EndDocPrinter($hPrinter) | Out-Null
    }
}
finally {
    [TemperoRawPrint.Native]::ClosePrinter($hPrinter) | Out-Null
}
