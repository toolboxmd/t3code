/**
 * FleetSessions - protocol normalization and delivery decisions for the
 * fleet pane's first slice: one externally launched Codex dispatcher reached
 * through its own native WebSocket app-server.
 *
 * Recorded native evidence (Codex 0.156.1, `/tmp/t3-fleet-spec/probe`) pins
 * the shapes used here:
 *
 * - discovery reads `thread/loaded/list`, whose result is
 *   `{data: string[], nextCursor: string | null}`: bare thread ids, paged.
 *   Each id then needs its own `thread/read` for metadata.
 * - history lives at `thread/read` result `thread.turns`, not top level.
 * - a thread whose status is `notLoaded` is reported, never attached or
 *   messaged, even when no `loaded` boolean is present.
 * - attach is metadata-only `thread/resume` with `excludeTurns: true` and no
 *   settings payload, for live notifications only.
 * - an active turn is messaged with `turn/steer` plus `expectedTurnId`; an
 *   idle follow-up uses native `turn/start` only when identity and ownership
 *   are known.
 * - viewing or detaching never stops the native agent, mutates permissions,
 *   or resumes a `notLoaded` session into another backend.
 *
 * This module is pure: decode, normalize, decide. The live socket lives in
 * `CodexNativeWs.ts`; connection lifecycle and fan-out live in
 * `FleetService.ts`.
 *
 * @module fleet/FleetSessions
 */
import {
  decodeFleetEndpointConfig,
  fleetAgentId,
  FleetError,
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

export class FleetNativeDecodeError extends Schema.TaggedError<FleetNativeDecodeError>()(
  "FleetNativeDecodeError",
  {
    operation: Schema.Literals(["decode-loaded-list", "decode-thread-read", "decode-notification"]),
  },
) {}

/**
 * Native app-server sends the fleet slice performs. Failures of any kind
 * become explicit `uncertain` delivery in `executeSend`: surfaced, never
 * auto resent.
 */
export interface FleetNativeTransport {
  readonly steerTurn: (params: {
    readonly threadId: string;
    readonly expectedTurnId: string;
    readonly text: string;
  }) => Effect.Effect<unknown, FleetError>;
  readonly startTurn: (params: {
    readonly threadId: string;
    readonly text: string;
  }) => Effect.Effect<unknown, FleetError>;
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
    return yield* new FleetNativeDecodeError({ operation: "decode-loaded-list" });
  }
  return Option.some(decoded.endpoint);
});

const LoadedListResponse = Schema.Struct({
  data: Schema.Array(Schema.String),
  nextCursor: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeLoadedList = Schema.decodeUnknownOption(LoadedListResponse);

/** Decode `thread/loaded/list` result: bare ids plus an opaque page cursor. */
export function decodeLoadedThreadIds(raw: unknown): {
  readonly ids: ReadonlyArray<string>;
  readonly nextCursor: string | null;
} | null {
  const decoded = decodeLoadedList(raw);
  if (Option.isNone(decoded)) return null;
  return {
    ids: decoded.value.data.filter((id) => id.trim().length > 0),
    nextCursor: decoded.value.nextCursor ?? null,
  };
}

const NativeTurnItem = Schema.Struct({
  id: Schema.String,
  type: Schema.String,
});
const decodeTurnItem = Schema.decodeUnknownOption(NativeTurnItem);

const NativeTurn = Schema.Struct({
  id: Schema.String,
  status: Schema.optional(Schema.String),
  items: Schema.optional(Schema.Array(Schema.Unknown)),
  itemsView: Schema.optional(Schema.String),
});
export type NativeTurn = typeof NativeTurn.Type;

const NativeThread = Schema.Struct({
  id: Schema.String,
  status: Schema.optional(Schema.Unknown),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  agentRole: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  turns: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type NativeThread = typeof NativeThread.Type;

const ThreadReadResponse = Schema.Struct({
  thread: NativeThread,
});
const decodeThreadRead = Schema.decodeUnknownOption(ThreadReadResponse);

/** Raw status word from a native thread, whatever envelope it arrives in. */
export function rawThreadStatusText(status: unknown): string | null {
  if (typeof status === "string") return status;
  if (status !== null && typeof status === "object") {
    const type = (status as { readonly type?: unknown }).type;
    if (typeof type === "string") return type;
  }
  return null;
}

/** True for the explicit `notLoaded` harness status. */
export function isNotLoadedStatus(status: unknown): boolean {
  const text = rawThreadStatusText(status);
  return text !== null && text.trim().toLowerCase() === "notloaded";
}

/** Map a harness status word onto the fleet status without guessing. */
export function toFleetStatus(status: string | null): FleetNativeThreadStatus {
  if (status === null) return "unknown";
  const normalized = status.trim().toLowerCase();
  if (normalized === "notloaded") return "unknown";
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
 * Load evidence for one thread: a `thread/read` (or resume) result proves
 * the session is loaded in this backend. `notLoaded` is never attachable,
 * even when no `loaded` boolean is present anywhere.
 */
export type FleetThreadLoadState = "loaded" | "notLoaded" | "unknown";

export function threadLoadStateOf(status: unknown): FleetThreadLoadState {
  if (isNotLoadedStatus(status)) return "notLoaded";
  if (rawThreadStatusText(status) !== null) return "loaded";
  return "unknown";
}

/**
 * True when T3 may attach metadata-only for live notifications: the session
 * proved loaded and the harness reports it idle or active. Anything else is
 * reported, never auto-resumed into another backend.
 */
export function isAttachableStatus(status: unknown): boolean {
  const text = rawThreadStatusText(status);
  if (text === null) return false;
  const normalized = text.trim().toLowerCase();
  return normalized === "idle" || normalized === "active";
}

function nonEmpty(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Discover fleet agents from per-thread `thread/read` results. Ids come
 * from `thread/loaded/list`; entries that decode as `notLoaded`, or that
 * lack a stable native thread id, are skipped instead of attached.
 */
export const discoverFleetAgents = Effect.fn("FleetSessions.discoverFleetAgents")(
  function* (input: {
    readonly environmentId: EnvironmentId;
    readonly instanceId: ProviderInstanceId;
    readonly threadReads: ReadonlyArray<unknown>;
    readonly seenAt: string;
  }): Effect.fn.Return<ReadonlyArray<FleetAgent>, FleetNativeDecodeError> {
    const agents: Array<FleetAgent> = [];
    for (const raw of input.threadReads) {
      const decoded = decodeThreadRead(raw);
      if (Option.isNone(decoded)) {
        return yield* new FleetNativeDecodeError({ operation: "decode-thread-read" });
      }
      const thread = decoded.value.thread;
      if (threadLoadStateOf(thread.status) === "notLoaded") continue;
      const role = nonEmpty(thread.agentRole) ?? nonEmpty(thread.name);
      const model = nonEmpty(thread.model);
      const cwd = thread.cwd === undefined || thread.cwd === null ? null : thread.cwd;
      agents.push({
        environmentId: input.environmentId,
        provider: "codex",
        instanceId: input.instanceId,
        nativeThreadId: thread.id,
        status: toFleetStatus(rawThreadStatusText(thread.status)),
        model,
        role,
        cwd,
        lastSeenAt: input.seenAt,
      });
    }
    return agents;
  },
);

/** Decode one `thread/read` result turn list (turns live inside `thread`). */
export function decodeReadTurns(raw: unknown): ReadonlyArray<NativeTurn> | null {
  const decoded = decodeThreadRead(raw);
  if (Option.isNone(decoded)) return null;
  const turns: Array<NativeTurn> = [];
  for (const rawTurn of decoded.value.thread.turns ?? []) {
    const turn = Schema.decodeUnknownOption(NativeTurn)(rawTurn);
    if (Option.isNone(turn)) return null;
    turns.push(turn.value);
  }
  return turns;
}

/** Latest running turn, if the harness reports one. */
export function activeTurnOf(turns: ReadonlyArray<NativeTurn>): string | null {
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn === undefined) continue;
    if (turn.status !== undefined && turn.status.trim().toLowerCase() === "inprogress") {
      return turn.id;
    }
  }
  return null;
}

function textOfContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: Array<string> = [];
  for (const block of content) {
    if (block !== null && typeof block === "object") {
      const record = block as { readonly type?: unknown; readonly text?: unknown };
      if (record.type === "text" && typeof record.text === "string" && record.text.length > 0) {
        parts.push(record.text);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/** Best-effort transcript text for one native thread item. */
export function nativeItemText(item: unknown): string | null {
  if (item === null || typeof item !== "object") return null;
  const record = item as {
    readonly type?: unknown;
    readonly text?: unknown;
    readonly content?: unknown;
    readonly command?: unknown;
    readonly exitCode?: unknown;
    readonly summary?: unknown;
  };
  switch (record.type) {
    case "userMessage":
      return textOfContent(record.content);
    case "agentMessage":
      return typeof record.text === "string" && record.text.length > 0 ? record.text : null;
    case "reasoning":
      return textOfContent(record.summary) ?? textOfContent(record.content);
    case "commandExecution": {
      if (typeof record.command !== "string" || record.command.length === 0) return null;
      return typeof record.exitCode === "number"
        ? `${record.command} (exit ${record.exitCode})`
        : record.command;
    }
    default:
      return textOfContent(record.content);
  }
}

function eventAt(value: unknown, fallback: string): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    // @effect-diagnostics-next-line globalDate:off - epoch-millis to ISO for event display; no DateTime.fromEpochMillis in this Effect version.
    return new Date(value).toISOString();
  }
  return fallback;
}

/**
 * Normalize one native thread item (history or live) into a fleet event.
 * The event id is the harness item id, so a reconnect that re-reads history
 * upserts over live rows instead of duplicating them.
 */
export function nativeItemToEvent(input: {
  readonly nativeThreadId: string;
  readonly item: unknown;
  readonly at: string;
}): FleetNativeEvent | null {
  const decoded = decodeTurnItem(input.item);
  if (Option.isNone(decoded)) return null;
  const record = input.item as { readonly completedAtMs?: unknown; readonly startedAtMs?: unknown };
  return {
    id: decoded.value.id,
    nativeThreadId: input.nativeThreadId,
    kind: decoded.value.type,
    at: eventAt(record.completedAtMs ?? record.startedAtMs, input.at),
    text: nativeItemText(input.item),
  };
}

/** History events for every item of every turn in a `thread/read` result. */
export function historyEventsOf(input: {
  readonly nativeThreadId: string;
  readonly threadRead: unknown;
  readonly at: string;
}): ReadonlyArray<FleetNativeEvent> | null {
  const decoded = decodeThreadRead(input.threadRead);
  if (Option.isNone(decoded)) return null;
  const events: Array<FleetNativeEvent> = [];
  const seen = new Set<string>();
  seen.add(`turn:${decoded.value.thread.id}-header`);
  for (const rawTurn of decoded.value.thread.turns ?? []) {
    const turn = Schema.decodeUnknownOption(NativeTurn)(rawTurn);
    if (Option.isNone(turn)) return null;
    const itemsView = turn.value.itemsView?.trim().toLowerCase();
    if (itemsView === "notloaded") continue;
    events.push({
      id: `turn:${turn.value.id}`,
      nativeThreadId: input.nativeThreadId,
      kind: `turn/${turn.value.status ?? "unknown"}`,
      at: input.at,
      text: null,
    });
    for (const rawItem of turn.value.items ?? []) {
      const event = nativeItemToEvent({
        nativeThreadId: input.nativeThreadId,
        item: rawItem,
        at: input.at,
      });
      if (event === null) return null;
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
    }
  }
  return events;
}

/**
 * Accumulate one `item/agentMessage/delta` payload. Deltas stream per item
 * id; the accumulated text replaces the previous value under the same event
 * id so completion updates never lose earlier deltas (no first-ID-wins).
 */
export function applyAgentMessageDelta(
  accumulated: ReadonlyMap<string, string>,
  params: { readonly itemId: string; readonly delta: string },
): Map<string, string> {
  const next = new Map(accumulated);
  next.set(params.itemId, `${next.get(params.itemId) ?? ""}${params.delta}`);
  return next;
}

/** Fleet event for the accumulated text of one streaming agent message. */
export function deltaEventOf(input: {
  readonly nativeThreadId: string;
  readonly itemId: string;
  readonly text: string;
  readonly at: string;
}): FleetNativeEvent {
  return {
    id: input.itemId,
    nativeThreadId: input.nativeThreadId,
    kind: "agentMessage/delta",
    at: input.at,
    text: input.text.length > 0 ? input.text : null,
  };
}

/**
 * Merge native history (from `thread/read`) with live notification events.
 * Same-id rows upsert in place: live completions and accumulated deltas
 * replace their earlier value at the original position, so a reconnect that
 * re-reads history never duplicates rows and never drops newer text.
 */
export function mergeFleetEvents(
  history: ReadonlyArray<FleetNativeEvent>,
  live: ReadonlyArray<FleetNativeEvent>,
): ReadonlyArray<FleetNativeEvent> {
  const merged = [...history];
  const indexById = new Map(merged.map((event, index) => [event.id, index] as const));
  for (const event of live) {
    const index = indexById.get(event.id);
    if (index === undefined) {
      indexById.set(event.id, merged.length);
      merged.push(event);
    } else {
      merged[index] = event;
    }
  }
  return merged;
}

/**
 * Remove duplicate events by harness-assigned id. The latest value wins at
 * the first position, so replayed completions replace stale placeholders.
 */
export function dedupeFleetEvents(
  events: ReadonlyArray<FleetNativeEvent>,
): ReadonlyArray<FleetNativeEvent> {
  const latest = new Map<string, FleetNativeEvent>();
  const order: Array<string> = [];
  for (const event of events) {
    if (!latest.has(event.id)) order.push(event.id);
    latest.set(event.id, event);
  }
  return order.map((id) => latest.get(id) as FleetNativeEvent);
}

/**
 * Attach metadata-only for live notifications. Returns the exact
 * `thread/resume` params to send: `excludeTurns: true` and no settings
 * payload. Refuses `notLoaded` (or unknown-load) threads instead of
 * resuming them into another backend.
 */
export const attachMetadataOnly = Effect.fn("FleetSessions.attachMetadataOnly")(function* (input: {
  readonly threadId: string;
  readonly status: unknown;
}): Effect.fn.Return<
  {
    readonly resumed: true;
    readonly threadId: string;
    readonly params: ReturnType<typeof buildResumeParams>;
  },
  FleetNativeDecodeError
> {
  if (threadLoadStateOf(input.status) !== "loaded" || !isAttachableStatus(input.status)) {
    return yield* new FleetNativeDecodeError({ operation: "decode-thread-read" });
  }
  return { resumed: true, threadId: input.threadId, params: buildResumeParams(input.threadId) };
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
 * explicit refusal, never a blind send. `notLoaded` is always refused,
 * even when the display status alone looks usable.
 */
export function decideSend(input: {
  readonly threadId: string;
  readonly status: FleetNativeThreadStatus;
  readonly loadState: FleetThreadLoadState;
  readonly activeTurnId: string | null;
  readonly ownershipKnown: boolean;
  readonly text: string;
}): FleetSendDecision {
  if (input.loadState !== "loaded") {
    return {
      _tag: "Refused",
      reason:
        input.loadState === "notLoaded"
          ? "Native session is not loaded in this backend. No message was sent."
          : "Native session load state is unknown. No message was sent.",
    };
  }
  if (input.status === "active") {
    if (input.activeTurnId === null) {
      return {
        _tag: "Refused",
        reason: "Native turn is active but its id is unknown. Read the thread before sending.",
      };
    }
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
