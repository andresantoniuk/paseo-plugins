import {
  type AgentEntry,
  bucketOf,
  type HostScope,
  hostOf,
  stateLabel,
  title,
  waitingSince,
} from "./monitor";

export type OverviewItem = {
  id: string;
  title: string;
  state: string;
  detail: string;
  needsAttention: boolean;
  since: number;
  host: HostScope | null;
};

/** Running agents and agents needing attention, longest-waiting attention first. */
export function overviewItems(entries: readonly AgentEntry[]): OverviewItem[] {
  const attention: OverviewItem[] = [];
  const running: OverviewItem[] = [];
  for (const entry of entries) {
    const bucket = bucketOf(entry.agent);
    if (bucket !== "attention" && bucket !== "running") continue;
    const item: OverviewItem = {
      id: entry.agent.id,
      title: title(entry),
      state: stateLabel(entry.agent),
      detail: entry.agent.model
        ? `${entry.agent.provider} · ${entry.agent.model}`
        : entry.agent.provider,
      needsAttention: bucket === "attention",
      since: waitingSince(entry.agent),
      host: hostOf(entry) ?? null,
    };
    (bucket === "attention" ? attention : running).push(item);
  }
  attention.sort((left, right) => left.since - right.since);
  running.sort((left, right) => left.title.localeCompare(right.title));
  return [...attention, ...running];
}

/** Move the selection with wrapping. Returns -1 when there is nothing to select. */
export function moveSelection(index: number, count: number, delta: number): number {
  if (count <= 0) return -1;
  if (index < 0) return delta >= 0 ? 0 : count - 1;
  return (((index + delta) % count) + count) % count;
}

/** Digit keys 1-9 select the visible badge; anything else is not a jump. */
export function digitIndex(key: string): number | null {
  if (/^[1-9]$/.test(key)) return Number(key) - 1;
  return null;
}
