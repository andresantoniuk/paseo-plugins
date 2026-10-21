/**
 * A pending request to focus an agent's card in the graph, set by the sidebar
 * quick access just before opening the monitor. Module state survives screen
 * reuse: opening the same screen again does not always deliver fresh params,
 * but it always runs in this same client bundle.
 */
let pendingAgentId: string | null = null;

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
