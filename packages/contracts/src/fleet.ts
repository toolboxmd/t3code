import * as Schema from "effect/Schema";
import { EnvironmentId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Fleet pane contracts for externally launched native agents.
 *
 * First slice covers one Codex dispatcher reached through its own native
 * WebSocket app-server endpoint. The endpoint is configured per Codex
 * provider instance (see `CodexSettings.nativeEndpoint`); T3 attaches
 * read-only and never takes over the native session lifecycle.
 *
 * Identity rule: a fleet agent is keyed by environment plus stable native
 * identity (`environmentId`, driver `codex`, instance id, native thread
 * id). Reconnects reuse the same key; no duplicate rows or events.
 *
 * @module fleet
 */

/** WebSocket URL of an externally launched Codex native app-server. */
export const FleetCodexNativeEndpoint = Schema.Struct({
  url: TrimmedNonEmptyString,
});
export type FleetCodexNativeEndpoint = typeof FleetCodexNativeEndpoint.Type;

const FLEET_NATIVE_ENDPOINT_PATTERN = /^wss?:\/\/.+/;

/** Non-empty ws:// or wss:// URL. */
export const FleetCodexNativeEndpointUrl = TrimmedNonEmptyString.check(
  Schema.isPattern(FLEET_NATIVE_ENDPOINT_PATTERN),
);
export type FleetCodexNativeEndpointUrl = typeof FleetCodexNativeEndpointUrl.Type;

/** True for values T3 may dial as a native Codex endpoint. */
export function isFleetNativeEndpointUrl(value: string): boolean {
  return FLEET_NATIVE_ENDPOINT_PATTERN.test(value.trim());
}

const decodeEndpointUrl = Schema.decodeUnknownOption(FleetCodexNativeEndpointUrl);

/**
 * Decode a configured endpoint value. Empty or missing values decode to
 * null so an unconfigured instance stays disabled without an error;
 * anything else must be a ws:// or wss:// URL.
 */
export function decodeFleetEndpointConfig(raw: unknown):
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Endpoint"; readonly endpoint: FleetCodexNativeEndpoint }
  | {
      readonly _tag: "Invalid";
    } {
  if (raw === null || raw === undefined) return { _tag: "Missing" };
  if (typeof raw !== "string" || raw.trim().length === 0) return { _tag: "Missing" };
  const decoded = decodeEndpointUrl(raw.trim());
  if (decoded._tag === "None") return { _tag: "Invalid" };
  return { _tag: "Endpoint", endpoint: { url: decoded.value } };
}

/** Lifecycle of a native session as the harness reports it. */
export const FleetNativeThreadStatus = Schema.Literals(["active", "idle", "ended", "unknown"]);
export type FleetNativeThreadStatus = typeof FleetNativeThreadStatus.Type;

/**
 * One externally launched native agent visible in the fleet pane.
 * Role and model stay null unless the harness reports them; T3 never
 * guesses.
 */
export const FleetAgent = Schema.Struct({
  environmentId: EnvironmentId,
  provider: Schema.Literal("codex"),
  instanceId: ProviderInstanceId,
  /** Stable native session identity (Codex thread id). */
  nativeThreadId: TrimmedNonEmptyString,
  status: FleetNativeThreadStatus,
  model: Schema.NullOr(TrimmedNonEmptyString),
  role: Schema.NullOr(TrimmedNonEmptyString),
  cwd: Schema.NullOr(Schema.String),
  lastSeenAt: IsoDateTime,
});
export type FleetAgent = typeof FleetAgent.Type;

/**
 * Stable pane identity for a fleet agent. Reconnects and rediscovery
 * produce the same key, so rows, history, and events deduplicate.
 */
export function fleetAgentId(
  agent: Pick<FleetAgent, "environmentId" | "provider" | "instanceId" | "nativeThreadId">,
): string {
  return `${agent.environmentId}/${agent.provider}/${agent.instanceId}/${agent.nativeThreadId}`;
}

/** How a user message reaches the native session. */
export const FleetDeliveryKind = Schema.Literals([
  /** Active turn: steered in place with turn/steer and expectedTurnId. */
  "steered-active",
  /** Idle session with known identity and ownership: native turn/start. */
  "queued-followup",
  /** Send outcome unknown: surfaced, never auto resent. */
  "uncertain",
  /** Rejected before send (for example unknown ownership, notLoaded session). */
  "refused",
  /** The harness reported a send failure. */
  "failed",
]);
export type FleetDeliveryKind = typeof FleetDeliveryKind.Type;

export const FleetMessageDelivery = Schema.Struct({
  kind: FleetDeliveryKind,
  /** Present for refused, uncertain, and failed outcomes. */
  reason: Schema.NullOr(Schema.String),
  at: IsoDateTime,
});
export type FleetMessageDelivery = typeof FleetMessageDelivery.Type;

/**
 * One native transcript or live event, keyed for dedupe. History comes
 * from native read APIs; live rows come from attached notifications.
 * Both carry harness-assigned ids so reconnects merge without doubles.
 */
export const FleetNativeEvent = Schema.Struct({
  id: TrimmedNonEmptyString,
  nativeThreadId: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  at: IsoDateTime,
  text: Schema.NullOr(Schema.String),
});
export type FleetNativeEvent = typeof FleetNativeEvent.Type;
