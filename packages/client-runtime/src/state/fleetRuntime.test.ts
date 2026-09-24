import { describe, expect, it } from "vite-plus/test";
import type {
  EnvironmentId,
  FleetAgent,
  FleetMessageDelivery,
  FleetNativeEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";

import {
  aggregateFleetAgents,
  appendFleetEvents,
  emptyFleetState,
  fleetDeliveryLabel,
  fleetPanelRows,
  ingestEnvironmentSnapshot,
  markEnvironmentOffline,
  mergeFleetEventLists,
  removeEnvironment,
  removeFleetAgent,
  setFleetEndpointNotice,
  upsertFleetAgent,
  type FleetEnvironmentSnapshot,
} from "./fleetRuntime.ts";

const SEEN_AT = "2026-09-24T18:13:42.000Z";
const THREAD_ID = "01a0d431-b396-7023-a2aa-bc7ed6c6bc0c";

function agent(
  environmentId: string,
  nativeThreadId: string = THREAD_ID,
  overrides: Partial<FleetAgent> = {},
): FleetAgent {
  return {
    environmentId: environmentId as EnvironmentId,
    provider: "codex",
    instanceId: "codex" as ProviderInstanceId,
    nativeThreadId,
    status: "idle",
    model: "gpt-5.6-luna",
    role: null,
    cwd: "/tmp/t3-fleet-spec/probe",
    lastSeenAt: SEEN_AT,
    ...overrides,
  };
}

function event(id: string, nativeThreadId: string = THREAD_ID): FleetNativeEvent {
  return {
    id,
    nativeThreadId,
    kind: "item/completed",
    at: SEEN_AT,
    text: null,
  };
}

function snapshot(
  environmentId: string,
  agents: ReadonlyArray<FleetAgent>,
  events: ReadonlyArray<FleetNativeEvent> = [],
): FleetEnvironmentSnapshot {
  return { environmentId, agents, events };
}

describe("fleetRuntime aggregation", () => {
  it("aggregates agents by environment under stable identity", () => {
    const state = aggregateFleetAgents([
      snapshot("env-a", [agent("env-a")]),
      snapshot("env-b", [agent("env-b")]),
    ]);
    const rows = fleetPanelRows(state);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.id).sort()).toEqual(
      [`env-a/codex/codex/${THREAD_ID}`, `env-b/codex/codex/${THREAD_ID}`].sort(),
    );
  });

  it("keeps environments distinct for the same native thread", () => {
    const state = aggregateFleetAgents([
      snapshot("env-a", [agent("env-a")]),
      snapshot("env-b", [agent("env-b")]),
    ]);
    expect(Object.keys(state.agents)).toHaveLength(2);
  });

  it("ignores agents that do not belong to the snapshot environment", () => {
    const state = ingestEnvironmentSnapshot(emptyFleetState(), snapshot("env-a", [agent("env-b")]));
    expect(fleetPanelRows(state)).toHaveLength(0);
  });
});

describe("fleetRuntime reconnect deduplication", () => {
  it("re-ingesting a snapshot does not duplicate agents or events", () => {
    const first = ingestEnvironmentSnapshot(
      emptyFleetState(),
      snapshot("env-a", [agent("env-a")], [event("evt-1"), event("evt-2")]),
    );
    const second = ingestEnvironmentSnapshot(
      first,
      snapshot("env-a", [agent("env-a")], [event("evt-1"), event("evt-2")]),
    );
    expect(Object.keys(second.agents)).toEqual(Object.keys(first.agents));
    expect(second.eventsByAgent[`env-a/codex/codex/${THREAD_ID}`]).toHaveLength(2);
  });

  it("preserves row order across reconnects", () => {
    const first = aggregateFleetAgents([
      snapshot("env-a", [agent("env-a", "thread-1"), agent("env-a", "thread-2")]),
    ]);
    const second = ingestEnvironmentSnapshot(
      first,
      snapshot("env-a", [agent("env-a", "thread-2"), agent("env-a", "thread-1")]),
    );
    expect(fleetPanelRows(second).map((row) => row.nativeThreadId)).toEqual(
      fleetPanelRows(first).map((row) => row.nativeThreadId),
    );
  });

  it("drops events for unknown agents instead of creating rows", () => {
    const state = ingestEnvironmentSnapshot(
      emptyFleetState(),
      snapshot("env-a", [], [event("evt-1")]),
    );
    expect(fleetPanelRows(state)).toHaveLength(0);
    expect(appendFleetEvents(state, "env-a/codex/codex/missing", [event("evt-1")])).toBe(state);
  });
});

describe("fleetRuntime event continuity", () => {
  it("merges history reads with live events without doubles", () => {
    const withHistory = ingestEnvironmentSnapshot(
      emptyFleetState(),
      snapshot("env-a", [agent("env-a")], [event("evt-1"), event("evt-2")]),
    );
    const withLive = appendFleetEvents(withHistory, `env-a/codex/codex/${THREAD_ID}`, [
      event("evt-2"),
      event("evt-3"),
    ]);
    expect(
      withLive.eventsByAgent[`env-a/codex/codex/${THREAD_ID}`]?.map((entry) => entry.id),
    ).toEqual(["evt-1", "evt-2", "evt-3"]);
    expect(fleetPanelRows(withLive)[0]?.eventCount).toBe(3);
  });

  it("removes a disconnected environment without marking its agents ended", () => {
    const state = aggregateFleetAgents([
      snapshot("env-a", [agent("env-a")]),
      snapshot("env-b", [agent("env-b")]),
    ]);
    const remaining = removeEnvironment(state, "env-a");
    const rows = fleetPanelRows(remaining);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.environmentId).toBe("env-b");
  });
});

describe("fleetRuntime delivery states", () => {
  it("labels active steering and queued follow-ups distinctly", () => {
    const steered: FleetMessageDelivery = {
      kind: "steered-active",
      reason: null,
      at: SEEN_AT,
    };
    const queued: FleetMessageDelivery = {
      kind: "queued-followup",
      reason: null,
      at: SEEN_AT,
    };
    expect(fleetDeliveryLabel(steered)).toContain("running turn");
    expect(fleetDeliveryLabel(queued)).toContain("follow-up");
    expect(fleetDeliveryLabel(steered)).not.toBe(fleetDeliveryLabel(queued));
  });

  it("surfaces uncertain delivery instead of claiming success", () => {
    const uncertain: FleetMessageDelivery = {
      kind: "uncertain",
      reason: "The native server did not confirm delivery.",
      at: SEEN_AT,
    };
    expect(fleetDeliveryLabel(uncertain)).toContain("not resent");
  });

  it("reports refusals and failures with their reasons", () => {
    const refused: FleetMessageDelivery = {
      kind: "refused",
      reason: "Ownership unknown.",
      at: SEEN_AT,
    };
    const failed: FleetMessageDelivery = { kind: "failed", reason: "Socket closed.", at: SEEN_AT };
    expect(fleetDeliveryLabel(refused)).toBe("Ownership unknown.");
    expect(fleetDeliveryLabel(failed)).toBe("Socket closed.");
  });
});

describe("fleetRuntime panel rows", () => {
  it("titles rows by native session identity with harness detail when known", () => {
    const state = aggregateFleetAgents([snapshot("env-a", [agent("env-a")])]);
    const rows = fleetPanelRows(state);
    expect(rows[0]?.title).toBe(THREAD_ID);
    expect(rows[0]?.detail).toBe("gpt-5.6-luna");
    expect(rows[0]?.environmentId).toBe("env-a");
    expect(rows[0]?.status).toBe("idle");
  });

  it("leaves detail null when the harness reports neither role nor model", () => {
    const state = aggregateFleetAgents([
      snapshot("env-a", [agent("env-a", THREAD_ID, { role: null, model: null })]),
    ]);
    expect(fleetPanelRows(state)[0]?.detail).toBeNull();
  });
});

describe("fleetRuntime offline environments", () => {
  it("keeps disconnected rows visible as offline instead of ended or idle", () => {
    const online = aggregateFleetAgents([snapshot("env-a", [agent("env-a")])]);
    expect(fleetPanelRows(online)[0]?.online).toBe(true);
    const offline = markEnvironmentOffline(online, "env-a");
    const rows = fleetPanelRows(offline);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.online).toBe(false);
    expect(rows[0]?.status).toBe("idle");
  });

  it("marks the environment online again on the next snapshot", () => {
    const offline = markEnvironmentOffline(
      aggregateFleetAgents([snapshot("env-a", [agent("env-a")])]),
      "env-a",
    );
    const back = ingestEnvironmentSnapshot(offline, snapshot("env-a", [agent("env-a")]));
    expect(fleetPanelRows(back)[0]?.online).toBe(true);
  });

  it("removes rows only when the environment is removed, not on disconnect", () => {
    const offline = markEnvironmentOffline(
      aggregateFleetAgents([snapshot("env-a", [agent("env-a")])]),
      "env-a",
    );
    expect(fleetPanelRows(offline)).toHaveLength(1);
    expect(fleetPanelRows(removeEnvironment(offline, "env-a"))).toHaveLength(0);
  });
});

describe("fleetRuntime live updates", () => {
  it("upserts one agent without disturbing row order or events", () => {
    const first = upsertFleetAgent(emptyFleetState(), agent("env-a"));
    const second = upsertFleetAgent(
      appendFleetEvents(first, "env-a/codex/codex/" + THREAD_ID, [event("evt-1")]),
      agent("env-a", THREAD_ID, { status: "active" }),
    );
    const rows = fleetPanelRows(second);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("active");
    expect(rows[0]?.eventCount).toBe(1);
  });

  it("removes one agent while keeping its environment siblings", () => {
    const state = aggregateFleetAgents([
      snapshot("env-a", [agent("env-a", "thread-1"), agent("env-a", "thread-2")]),
    ]);
    const removed = removeFleetAgent(state, "env-a/codex/codex/thread-1");
    expect(fleetPanelRows(removed).map((row) => row.nativeThreadId)).toEqual(["thread-2"]);
  });

  it("records and clears native endpoint notices per instance", () => {
    const noticed = setFleetEndpointNotice(emptyFleetState(), "codex", "unreachable");
    expect(noticed.endpointNotices["codex"]).toBe("unreachable");
    expect(setFleetEndpointNotice(noticed, "codex", null).endpointNotices["codex"]).toBeUndefined();
  });

  it("upserts same-id live rows in place so deltas never duplicate", () => {
    const history = [
      event("evt-1"),
      { ...event("msg-1"), kind: "agentMessage/delta", text: "FLEET" },
    ];
    const live = [
      { ...event("msg-1"), kind: "agentMessage/delta", text: "FLEET_MESSAGE_ACK_8426" },
    ];
    const merged = mergeFleetEventLists(history, live);
    expect(merged.map((entry) => entry.id)).toEqual(["evt-1", "msg-1"]);
    expect(merged[1]?.text).toBe("FLEET_MESSAGE_ACK_8426");
  });

  it("re-ingesting a reconnect snapshot neither duplicates rows nor events", () => {
    const first = ingestEnvironmentSnapshot(
      emptyFleetState(),
      snapshot("env-a", [agent("env-a")], [event("evt-1")]),
    );
    const second = ingestEnvironmentSnapshot(
      first,
      snapshot("env-a", [agent("env-a")], [event("evt-1")]),
    );
    expect(fleetPanelRows(second)).toHaveLength(1);
    const key = "env-a/codex/codex/" + THREAD_ID;
    expect(second.eventsByAgent[key]).toHaveLength(1);
  });
});
