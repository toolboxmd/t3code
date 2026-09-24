/**
 * Fleet runtime model: aggregates native agents across connected
 * environments for the fleet pane.
 *
 * Each environment supplies its own native sessions; this module combines
 * them under the stable contract identity
 * (`environmentId/codex/instanceId/nativeThreadId`) so reconnects reuse
 * rows, history merges with live events without doubles, and delivery
 * states stay truthful per harness semantics.
 *
 * Pure functions over plain data: no atoms, no sockets. The pane renders
 * `fleetPanelRows`; networking stays with the existing environment
 * connections.
 */
import {
  fleetAgentId,
  type FleetAgent,
  type FleetMessageDelivery,
  type FleetNativeEvent,
} from "@t3tools/contracts";

export interface FleetEnvironmentSnapshot {
  readonly environmentId: string;
  readonly agents: ReadonlyArray<FleetAgent>;
  readonly events: ReadonlyArray<FleetNativeEvent>;
}

export interface FleetState {
  /** Keyed by stable fleet agent id; insertion order is first-seen order. */
  readonly agents: Readonly<Record<string, FleetAgent>>;
  /** Keyed by stable fleet agent id; history first, then live, deduped. */
  readonly eventsByAgent: Readonly<Record<string, ReadonlyArray<FleetNativeEvent>>>;
}

export interface FleetPanelRow {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly environmentId: string;
  readonly provider: FleetAgent["provider"];
  readonly instanceId: string;
  readonly nativeThreadId: string;
  readonly status: FleetAgent["status"];
  readonly eventCount: number;
  readonly lastSeenAt: string;
}

export function emptyFleetState(): FleetState {
  return { agents: {}, eventsByAgent: {} };
}

function mergeEvents(
  current: ReadonlyArray<FleetNativeEvent> | undefined,
  incoming: ReadonlyArray<FleetNativeEvent>,
): ReadonlyArray<FleetNativeEvent> {
  const seen = new Set((current ?? []).map((event) => event.id));
  const merged = [...(current ?? [])];
  for (const event of incoming) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged;
}

/**
 * Fold one environment snapshot into state. Re-ingesting the same
 * snapshot (reconnect, rescan) updates `lastSeenAt` in place without
 * duplicating agents, rows, or events.
 */
export function ingestEnvironmentSnapshot(
  state: FleetState,
  snapshot: FleetEnvironmentSnapshot,
): FleetState {
  const agents: Record<string, FleetAgent> = { ...state.agents };
  const eventsByAgent: Record<string, ReadonlyArray<FleetNativeEvent>> = {
    ...state.eventsByAgent,
  };
  for (const agent of snapshot.agents) {
    if (agent.environmentId !== snapshot.environmentId) continue;
    agents[fleetAgentId(agent)] = agent;
  }
  const incomingByAgent = new Map<string, Array<FleetNativeEvent>>();
  for (const event of snapshot.events) {
    const owner = snapshot.agents.find((agent) => agent.nativeThreadId === event.nativeThreadId);
    if (owner === undefined) continue;
    const key = fleetAgentId(owner);
    const list = incomingByAgent.get(key) ?? [];
    list.push(event);
    incomingByAgent.set(key, list);
  }
  for (const [key, incoming] of incomingByAgent) {
    eventsByAgent[key] = mergeEvents(eventsByAgent[key], incoming);
  }
  return { agents, eventsByAgent };
}

/** Combine snapshots from every connected environment. */
export function aggregateFleetAgents(
  snapshots: ReadonlyArray<FleetEnvironmentSnapshot>,
): FleetState {
  return snapshots.reduce(ingestEnvironmentSnapshot, emptyFleetState());
}

/**
 * Drop everything one environment supplied. A disconnected or
 * unreachable environment disappears from the pane instead of being
 * reported as ended or idle.
 */
export function removeEnvironment(state: FleetState, environmentId: string): FleetState {
  const agents: Record<string, FleetAgent> = {};
  const eventsByAgent: Record<string, ReadonlyArray<FleetNativeEvent>> = {};
  for (const [key, agent] of Object.entries(state.agents)) {
    if (agent.environmentId === environmentId) continue;
    agents[key] = agent;
    const events = state.eventsByAgent[key];
    if (events !== undefined) eventsByAgent[key] = events;
  }
  return { agents, eventsByAgent };
}

/** Append live notification events to one agent, deduped by event id. */
export function appendFleetEvents(
  state: FleetState,
  agentId: string,
  events: ReadonlyArray<FleetNativeEvent>,
): FleetState {
  if (state.agents[agentId] === undefined) return state;
  return {
    ...state,
    eventsByAgent: {
      ...state.eventsByAgent,
      [agentId]: mergeEvents(state.eventsByAgent[agentId], events),
    },
  };
}

/** Pane rows in stable first-seen order. Titles use native identity only. */
export function fleetPanelRows(state: FleetState): ReadonlyArray<FleetPanelRow> {
  return Object.entries(state.agents).map(([id, agent]) => {
    const detail = [agent.role, agent.model].filter(
      (value): value is string => value !== null && value.trim().length > 0,
    );
    return {
      id,
      title: agent.nativeThreadId,
      detail: detail.length > 0 ? detail.join(" · ") : null,
      environmentId: agent.environmentId,
      provider: agent.provider,
      instanceId: agent.instanceId,
      nativeThreadId: agent.nativeThreadId,
      status: agent.status,
      eventCount: state.eventsByAgent[id]?.length ?? 0,
      lastSeenAt: agent.lastSeenAt,
    };
  });
}

/** User-visible delivery wording. Uncertain stays uncertain. */
export function fleetDeliveryLabel(delivery: FleetMessageDelivery): string {
  switch (delivery.kind) {
    case "steered-active":
      return "Steered into the running turn";
    case "queued-followup":
      return "Queued as a follow-up turn";
    case "uncertain":
      return "Uncertain delivery, not resent";
    case "refused":
      return delivery.reason ?? "Not sent";
    case "failed":
      return delivery.reason ?? "Send failed";
  }
}
