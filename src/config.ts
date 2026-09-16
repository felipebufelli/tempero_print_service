import Store from "electron-store";

export type AgentConfig = {
  backendUrl: string;
  token: string | null;
};

const DEFAULT_BACKEND_URL = "https://temperoapi-production.up.railway.app";

export const store = new Store<AgentConfig>({
  defaults: {
    backendUrl: DEFAULT_BACKEND_URL,
    token: null,
  },
});

export function getConfig(): AgentConfig {
  return { backendUrl: store.get("backendUrl"), token: store.get("token") };
}

export function setToken(token: string): void {
  store.set("token", token);
}

export function setBackendUrl(url: string): void {
  store.set("backendUrl", url);
}
