import { apiPath } from "./api";

export type GatewayProtocol = "anthropic" | "openai";
export interface GatewayRoute {
  id: string;
  name: string;
  agent: string;
  protocol: GatewayProtocol;
  mode: "auto" | "provider";
  providerId: string;
  model: string;
  baseUrl: string;
  connected: boolean;
  drifted: boolean;
  issue: string;
  canConnect: boolean;
  agentMissing: boolean;
}
export type RouteDraft = Pick<GatewayRoute, "name" | "agent" | "protocol" | "mode" | "providerId" | "model"> & { id?: string };
export interface GatewayAgent { id: string; name: string; icon?: string; canConnect: boolean; }
export interface GatewayState {
  agents: GatewayAgent[];
  baseUrl: string;
  defaultModel: string;
  providers: Array<{ id: string; name: string; models: string[]; kind: GatewayProtocol }>;
  routes: GatewayRoute[];
}
async function request<T>(path = "", body?: unknown): Promise<T> {
  const response = await fetch(apiPath(`/api/model-gateway${path}`), body === undefined ? undefined : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
export const fetchGateway = () => request<GatewayState>();
export const saveRoute = (draft: RouteDraft) => request<GatewayState>("/routes", draft);
export const routeAction = (action: "connect" | "disconnect" | "delete", id: string) => request<GatewayState>(`/${action}`, { id });
export const fetchConnection = (id: string) => request<{ baseUrl: string; apiKey: string }>("/connection", { id });
