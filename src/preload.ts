import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  getConfig: () => ipcRenderer.invoke("config:get"),
  saveToken: (token: string) => ipcRenderer.invoke("config:save-token", token),
  saveBackendUrl: (url: string) => ipcRenderer.invoke("config:save-backend-url", url),
  getState: () => ipcRenderer.invoke("connection:get-state"),
  onStateChange: (callback: (state: string) => void) => {
    ipcRenderer.on("connection:state", (_e, state: string) => callback(state));
  },
  onError: (callback: (message: string) => void) => {
    ipcRenderer.on("connection:error", (_e, message: string) => callback(message));
  },
  scanPrinters: () => ipcRenderer.send("network:scan-printers"),
  onPrinterFound: (callback: (printer: { ip: string; port: number }) => void) => {
    ipcRenderer.on("network:printer-found", (_e, printer) => callback(printer));
  },
  onScanDone: (callback: () => void) => {
    ipcRenderer.on("network:scan-done", () => callback());
  },
});
