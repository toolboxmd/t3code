/**
 * FleetSessions - first fleet-pane slice for one externally launched Codex dispatcher.
 *
 * T3 talks to the dispatcher's own native WebSocket app-server, configured
 * per Codex provider instance (`CodexSettings.nativeEndpoint`). The session
 * keeps running under its original owner; T3 only attaches, reads, and
 * steers:
 *
 * - discovery reads `thread/loaded/list` on the configured endpoint;
 * - attach is metadata-only `thread/resume` with `excludeTurns: true` and
 *   no settings changes, for live notifications only;
 * - history comes from native read APIs (`thread/read`);
 * - an active turn is messaged with `turn/steer` plus `expectedTurnId`;
 * - an idle follow-up uses native `turn/start`, but only when identity and
 *   ownership are known;
 * - viewing or detaching never stops the native agent, mutates permissions,
 *   or resumes a `notLoaded` session into another backend.
 *
 * The transport is injected so tests run against a shared.mjs-style fake
 * instead of sockets. Live WebSocket dialing stays with the coordinator's
 * integrated verification.
 *
 * @module fleet/FleetSessions
 */
import {
  decodeFleetEndpointConfig,
  fleetAgentId,
  type EnvironmentId,
  type FleetAgent,
  type FleetCodexNativeEndpoint,
  type FleetMessageDelivery,
  type FleetNativeEvent,
  type FleetNativeThreadStatus,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export { fleetAgentId };

/** Untrusted native thread entry, as `thread/loaded/list` may report it. */
const NativeLoadedThread = Schema.Struct({
  id: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  loaded: Schema.optional(Schema.Boolean),
  status: Schema.optional(
    Schema.Union([Schema.String, Schema.Struct({ type: Schema.optional(Schema.String) })]),
  ),
  model: Schema.optional(Schema.String),
  agentRole: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
});
export type NativeLoadedThread = typeof NativeLoadedThread.Type;

const decodeNativeLoadedThread = Schema.decodeUnknownOption(NativeLoadedThread);

const NativeThreadReadResult = Schema.Struct({
  thread: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      status: Schema.optional(Schema.Struct({ type: Schema.optional(Schema.String) })),
      model: Schema.optional(Schema.String),
      agentRole: Schema.optional(Schema.String),
      cwd: Schema.optional(Schema.String),
    }),
  ),
  turns: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        status: Schema.optional(Schema.String),
      }),
    ),
  ),
});
export type NativeThreadReadResult = typeof NativeThreadReadResult.Type;

export class FleetNativeDecodeError extends Schema.TaggedError<FleetNativeDecodeError>()(
  "FleetNativeDecodeError",
  {
    operation: Schema.Literals(["decode-loaded-thread", "decode-thread-read"]),
  },
) {}

/**
 * Native app-server calls the fleet slice needs. Implemented against the
 * real WebSocket endpoint in production; faked in tests with
 * shared.mjs-style behavior.
 */
export interface FleetNativeTransport {
  readonly listLoadedThreads: () => Effect.Effect<ReadonlyArray<unknown>, FleetNativeDecodeError>;
  readonly resumeThread: (params: {
    readonly threadId: string;
    readonly excludeTurns: boolean;
  }) => Effect.Effect<unknown, FleetNativeDecodeError>;
  readonly readThread: (params: {
    readonly threadId: string;
  }) => Effect.Effect<NativeThreadReadResult, FleetNativeDecodeError>;
  readonly steerTurn: (params: {
    readonly threadId: string;
    readonly expectedTurnId: string;
    readonly text: string;
  }) => Effect.Effect<unknown, FleetNativeDecodeError>;
  readonly startTurn: (params: {
    readonly threadId: string;
    readonly text: string;
  }) => Effect.Effect<unknown, FleetNativeDecodeError>;
}

/** Metadata-only attach params. Never carries settings changes. */
export function buildResumeParams(threadId: string): {
  readonly threadId: string;
  readonly excludeTurns: true;
} {
  return { threadId, excludeTurns: true };
}

/** Native turn/steer input for one text message. */
export function buildSteerInput(text: string): ReadonlyArray<{
  readonly type: "text";
  readonly text: string;
  readonly text_elements: ReadonlyArray<never>;
}> {
  return [{ type: "text", text, text_elements: [] }];
}

/**
 * Resolve the configured native endpoint. Empty or missing values mean
 * the instance has no fleet endpoint; anything else must be ws:// or
 * wss://.
 */
export const resolveFleetEndpoint = Effect.fn("FleetSessions.resolveFleetEndpoint")(function* (
  nativeEndpoint: string | null | undefined,
): Effect.fn.Return<Option.Option<FleetCodexNativeEndpoint>, FleetNativeDecodeError> {
  const decoded = decodeFleetEndpointConfig(nativeEndpoint ?? null);
  if (decoded._tag === "Missing") return Option.none();
  if (decoded._tag === "Invalid") {
    return yield* new FleetNativeDecodeError({ operation: "decode-loaded-thread" });
  }
  return Option.some(decoded.endpoint);
});

function nativeThreadIdOf(entry: NativeLoadedThread): string | null {
  for (const candidate of [entry.threadId, entry.id, entry.sessionId]) {
    if (candidate !== undefined && candidate.trim().length > 0) return candidate.trim();
  }
  return null;
}

function statusTextOf(status: NativeLoadedThread["status"]): string | null {
  if (status === undefined) return null;
  if (typeof status === "string") return status;
  return status.type ?? null;
}

/** Map a harness status word onto the fleet status without guessing. */
export function toFleetStatus(status: string | null): FleetNativeThreadStatus {
  if (status === null) return "unknown";
  const normalized = status.trim().toLowerCase();
  if (normalized === "running" || normalized === "active" || normalized === "working") {
    return "active";
  }
  if (normalized === "idle") return "idle";
  if (
    normalized === "ended" ||
    normalized === "completed" ||
    normalized === "archived" ||
    normalized === "closed"
  ) {
    return "ended";
  }
  return "unknown";
}

/**
 * True when the entry names a loaded session T3 may attach to. A
 * `notLoaded` session is never auto-resumed into another backend; it is
 * reported, not attached.
 */
export function isAttachableThread(entry: NativeLoadedThread): boolean {
  if (entry.loaded === false) return false;
  return nativeThreadIdOf(entry) !== null;
}

/**
 * Discover fleet agents from one environment's loaded native sessions.
 * Entries without a stable native thread id are skipped; role and model
 * stay null unless the harness reports them.
 */
export const discoverFleetAgents = Effect.fn("FleetSessions.discoverFleetAgents")(
  function* (input: {
    readonly environmentId: EnvironmentId;
    readonly instanceId: ProviderInstanceId;
    readonly loadedThreads: ReadonlyArray<unknown>;
    readonly seenAt: string;
  }): Effect.fn.Return<ReadonlyArray<FleetAgent>, FleetNativeDecodeError> {
    const agents: Array<FleetAgent> = [];
    for (const raw of input.loadedThreads) {
      const decoded = decodeNativeLoadedThread(raw);
      if (Option.isNone(decoded)) {
        return yield* new FleetNativeDecodeError({ operation: "decode-loaded-thread" });
      }
      const entry = decoded.value;
      const nativeThreadId = nativeThreadIdOf(entry);
      if (nativeThreadId === null) continue;
      const model = entry.model?.trim();
      const role = entry.agentRole?.trim();
      const cwd = entry.cwd?.trim();
      agents.push({
        environmentId: input.environmentId,
        provider: "codex",
        instanceId: input.instanceId,
        nativeThreadId,
        status: toFleetStatus(statusTextOf(entry.status)),
        model: model !== undefined && model.length > 0 ? model : null,
        role: role !== undefined && role.length > 0 ? role : null,
        cwd: cwd !== undefined && cwd.length > 0 ? cwd : null,
        lastSeenAt: input.seenAt,
      });
    }
    return agents;
  },
);

/**
 * Attach metadata-only for live notifications. Sends exactly
 * `thread/resume` with `excludeTurns: true` and no settings payload.
 * Refuses `notLoaded` entries instead of resuming them elsewhere.
 */
export const attachMetadataOnly = Effect.fn("FleetSessions.attachMetadataOnly")(function* (
  transport: FleetNativeTransport,
  entry: NativeLoadedThread,
): Effect.fn.Return<{ readonly resumed: true; readonly threadId: string }, FleetNativeDecodeError> {
  if (!isAttachableThread(entry)) {
    return yield* new FleetNativeDecodeError({ operation: "decode-loaded-thread" });
  }
  const threadId = nativeThreadIdOf(entry);
  if (threadId === null) {
    return yield* new FleetNativeDecodeError({ operation: "decode-loaded-thread" });
  }
  yield* transport.resumeThread(buildResumeParams(threadId));
  return { resumed: true, threadId };
});

export type FleetSendDecision =
  | {
      readonly _tag: "Steer";
      readonly params: {
        readonly threadId: string;
        readonly expectedTurnId: string;
        readonly input: ReturnType<typeof buildSteerInput>;
      };
    }
  | {
      readonly _tag: "Followup";
      readonly params: { readonly threadId: string; readonly text: string };
    }
  | { readonly _tag: "Refused"; readonly reason: string };

/**
 * Choose how a user message reaches the native session:
 * an active turn is steered in place; an idle session starts a follow-up
 * turn only when identity and ownership are known; anything else is an
 * explicit refusal, never a blind send.
 */
export function decideSend(input: {
  readonly threadId: string;
  readonly status: FleetNativeThreadStatus;
  readonly activeTurnId: string | null;
  readonly ownershipKnown: boolean;
  readonly text: string;
}): FleetSendDecision {
  if (input.activeTurnId !== null && input.status === "active") {
    return {
      _tag: "Steer",
      params: {
        threadId: input.threadId,
        expectedTurnId: input.activeTurnId,
        input: buildSteerInput(input.text),
      },
    };
  }
  if (input.status === "idle") {
    if (!input.ownershipKnown) {
      return {
        _tag: "Refused",
        reason:
          "Idle session ownership is unknown. Confirm identity before starting a follow-up turn.",
      };
    }
    return { _tag: "Followup", params: { threadId: input.threadId, text: input.text } };
  }
  if (input.status === "ended") {
    return { _tag: "Refused", reason: "Native session has ended. No message was sent." };
  }
  return {
    _tag: "Refused",
    reason: "Native session state is unknown. No message was sent.",
  };
}

/**
 * Carry out a send decision against the native transport. Transport
 * failures become explicit `uncertain` delivery: surfaced, never auto
 * resent. Retrying is a separate manual decision by the user.
 */
export const executeSend = Effect.fn("FleetSessions.executeSend")(function* (
  transport: FleetNativeTransport,
  decision: FleetSendDecision,
  at: string,
): Effect.fn.Return<FleetMessageDelivery, never> {
  if (decision._tag === "Refused") {
    return { kind: "refused", reason: decision.reason, at };
  }
  const result = yield* (
    decision._tag === "Steer"
      ? transport.steerTurn({
          threadId: decision.params.threadId,
          expectedTurnId: decision.params.expectedTurnId,
          text: decision.params.input[0]?.text ?? "",
        })
      : transport.startTurn(decision.params)
  ).pipe(Effect.option);
  if (Option.isNone(result)) {
    return {
      kind: "uncertain",
      reason:
        "The native server did not confirm delivery. The message may or may not have landed; it was not resent.",
      at,
    };
  }
  return {
    kind: decision._tag === "Steer" ? "steered-active" : "queued-followup",
    reason: null,
    at,
  };
});

/**
 * Merge native history (from `thread/read`) with live notification events.
 * History order wins; live events append once by harness-assigned id, so a
 * reconnect that re-reads history never duplicates rows.
 */
export function mergeFleetEvents(
  history: ReadonlyArray<FleetNativeEvent>,
  live: ReadonlyArray<FleetNativeEvent>,
): ReadonlyArray<FleetNativeEvent> {
  const seen = new Set(history.map((event) => event.id));
  const merged = [...history];
  for (const event of live) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged;
}

/** Remove duplicate events by harness-assigned id, keeping first order. */
export function dedupeFleetEvents(
  events: ReadonlyArray<FleetNativeEvent>,
): ReadonlyArray<FleetNativeEvent> {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.id)) return false;
    seen.add(event.id);
    return true;
  });
}

/**
 * Detach a fleet agent from T3 viewing. Detach sends nothing to the
 * native backend: no stop, no close, no archive, no permission change.
 * The native session keeps running under its original owner.
 */
export function detachFleetAgent(agent: FleetAgent): {
  readonly detached: true;
  readonly agentId: string;
  readonly nativeThreadId: string;
} {
  return { detached: true, agentId: fleetAgentId(agent), nativeThreadId: agent.nativeThreadId };
}
