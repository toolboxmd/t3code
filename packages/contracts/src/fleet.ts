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

/** Fleet RPC failure. The native session is never touched on failure. */
export class FleetError extends Schema.TaggedError<FleetError>()("FleetError", {
  operation: Schema.Literals([
    "list-agents",
    "read-thread",
    "send-message",
    "subscribe",
    "connect-endpoint",
  ]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Empty for now; kept as a struct so filters can be added without a new method. */
export const FleetListAgentsInput = Schema.Struct({});
export type FleetListAgentsInput = typeof FleetListAgentsInput.Type;

/**
 * Agents visible on this environment right now. The endpoint URL itself is
 * never included: native endpoints stay environment-local and never leak
 * through remote links.
 */
export const FleetAgentListResult = Schema.Struct({
  agents: Schema.Array(FleetAgent),
  scannedAt: IsoDateTime,
});
export type FleetAgentListResult = typeof FleetAgentListResult.Type;

export const FleetReadThreadInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  nativeThreadId: TrimmedNonEmptyString,
});
export type FleetReadThreadInput = typeof FleetReadThreadInput.Type;

/**
 * Transcript history for one native session, read with native read APIs.
 * `activeTurnId` is the running turn when the harness reports one; the
 * composer steers against it with `expectedTurnId`.
 */
export const FleetThreadHistoryResult = Schema.Struct({
  agent: FleetAgent,
  events: Schema.Array(FleetNativeEvent),
  activeTurnId: Schema.NullOr(TrimmedNonEmptyString),
  fetchedAt: IsoDateTime,
});
export type FleetThreadHistoryResult = typeof FleetThreadHistoryResult.Type;

export const FleetSendMessageInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  nativeThreadId: TrimmedNonEmptyString,
  text: TrimmedNonEmptyString,
  /** Running turn the sender saw; steer requires it to still match. */
  expectedActiveTurnId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /** Sender confirms this idle session is ours to continue. */
  ownershipKnown: Schema.Boolean,
});
export type FleetSendMessageInput = typeof FleetSendMessageInput.Type;

export const FleetAgentUpdatedEvent = Schema.Struct({
  kind: Schema.Literal("agent-updated"),
  agent: FleetAgent,
});
export type FleetAgentUpdatedEvent = typeof FleetAgentUpdatedEvent.Type;

export const FleetEventsAppendedEvent = Schema.Struct({
  kind: Schema.Literal("events-appended"),
  agentId: TrimmedNonEmptyString,
  events: Schema.Array(FleetNativeEvent),
});
export type FleetEventsAppendedEvent = typeof FleetEventsAppendedEvent.Type;

export const FleetAgentRemovedEvent = Schema.Struct({
  kind: Schema.Literal("agent-removed"),
  agentId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  nativeThreadId: TrimmedNonEmptyString,
});
export type FleetAgentRemovedEvent = typeof FleetAgentRemovedEvent.Type;

export const FleetEndpointUnreachableEvent = Schema.Struct({
  kind: Schema.Literal("endpoint-unreachable"),
  instanceId: ProviderInstanceId,
  message: TrimmedNonEmptyString,
});
export type FleetEndpointUnreachableEvent = typeof FleetEndpointUnreachableEvent.Type;

/** Live fleet updates for one environment. Scoped; disposed when unused. */
export const FleetStreamEvent = Schema.Union([
  FleetAgentUpdatedEvent,
  FleetEventsAppendedEvent,
  FleetAgentRemovedEvent,
  FleetEndpointUnreachableEvent,
]);
export type FleetStreamEvent = typeof FleetStreamEvent.Type;

export const FleetSubscribeInput = Schema.Struct({});
export type FleetSubscribeInput = typeof FleetSubscribeInput.Type;
