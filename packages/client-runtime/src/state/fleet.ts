import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Fleet atoms for one environment's externally launched native agents.
 * Each connected environment exposes its own Codex sessions through its
 * own T3 server; the pane aggregates snapshots by stable
 * environment/provider/instance/native-thread identity. The native endpoint
 * URL itself never crosses the wire: it stays environment-local on the
 * server that dials it.
 */
export function createFleetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Agents visible on one environment right now. */
    agentList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:fleet:agent-list",
      tag: WS_METHODS.fleetListAgents,
      staleTimeMs: 15_000,
      idleTtlMs: 60_000,
    }),
    /** Transcript history + running turn for one native session. */
    threadHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:fleet:thread-history",
      tag: WS_METHODS.fleetReadThread,
      staleTimeMs: 10_000,
      idleTtlMs: 60_000,
    }),
    /** Live agent, event, and endpoint updates for one environment. */
    subscription: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:fleet:subscription",
      tag: WS_METHODS.fleetSubscribe,
      idleTtlMs: 60_000,
    }),
    /** Message one native session: active steer or guarded idle follow-up. */
    sendMessage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:fleet:send-message",
      tag: WS_METHODS.fleetSendMessage,
    }),
  };
}
