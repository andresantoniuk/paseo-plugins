/**
 * A pending request to focus an agent's card in the graph, set by the sidebar
 * quick access just before opening the monitor. Module state survives screen
 * reuse: opening the same screen again does not always deliver fresh params,
 * but it always runs in this same client bundle.
 */
let pendingAgentId: string | null = null;

/**
 * A pending request to open an agent's own screen instead of the graph. The
 * sidebar popover cannot navigate (it only receives `openScreen`), so it leaves
 * the request here and the monitor screen consumes it once.
 */
export type AgentOpenRequest = {
  agentId: string;
  serverId?: string;
};
let pendingOpen: AgentOpenRequest | null = null;

export function requestAgentFocus(agentId: string): void {
  pendingAgentId = agentId;
}

export function peekAgentFocus(): string | null {
  return pendingAgentId;
}

export function takeAgentFocus(): string | null {
  const id = pendingAgentId;
  pendingAgentId = null;
  return id;
}

export function requestAgentOpen(request: AgentOpenRequest): void {
  pendingOpen = { ...request };
}

export function peekAgentOpen(): AgentOpenRequest | null {
  return pendingOpen;
}

export function takeAgentOpen(): AgentOpenRequest | null {
  const request = pendingOpen;
  pendingOpen = null;
  return request;
}
