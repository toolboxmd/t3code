/**
 * FleetSessions behavioral tests.
 *
 * Shapes replay the recorded native evidence (Codex 0.156.1,
 * `/tmp/t3-fleet-spec/probe`): `thread/loaded/list` returns bare ids with a
 * page cursor, `thread/read` nests turns inside `thread.turns`, resume is
 * metadata-only with `excludeTurns: true`, steering carries
 * `expectedTurnId`, and live traffic arrives as item/turn/status
 * notifications with per-item deltas.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  type EnvironmentId,
  type FleetNativeEvent,
  FleetError,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  activeTurnOf,
  applyAgentMessageDelta,
  attachMetadataOnly,
  buildResumeParams,
  buildSteerInput,
  decideSend,
  decodeLoadedThreadIds,
  decodeReadTurns,
  dedupeFleetEvents,
  deltaEventOf,
  detachFleetAgent,
  discoverFleetAgents,
  executeSend,
  fleetAgentId,
  historyEventsOf,
  isAttachableStatus,
  isNotLoadedStatus,
  mergeFleetEvents,
  nativeItemText,
  nativeItemToEvent,
  rawThreadStatusText,
  resolveFleetEndpoint,
  threadLoadStateOf,
  toFleetStatus,
  type FleetNativeTransport,
  type NativeTurn,
} from "./FleetSessions.ts";

const ENVIRONMENT_ID = "env-local" as EnvironmentId;
const INSTANCE_ID = "codex" as ProviderInstanceId;
const NATIVE_THREAD_ID = "01a0d431-b396-7023-a2aa-bc7ed6c6bc0c";
const ACTIVE_TURN_ID = "01a0d431-b3c1-70e1-957e-88bc5fe51d2b";
const SEEN_AT = "2026-09-24T18:13:42.000Z";

const loadedListPage = (overrides: Record<string, unknown> = {}) => ({
  data: [NATIVE_THREAD_ID],
  nextCursor: null,
  ...overrides,
});

const nativeThread = (overrides: Record<string, unknown> = {}) => ({
  id: NATIVE_THREAD_ID,
  status: { type: "idle" },
  model: "gpt-5.6-luna",
  agentRole: null,
  name: null,
  cwd: "/tmp/t3-fleet-spec/probe",
  turns: [],
  ...overrides,
});

const threadRead = (overrides: Record<string, unknown> = {}) => ({
  thread: nativeThread(overrides),
});

const userMessageItem = {
  type: "userMessage",
  id: "01a0d431-baf4-7592-a25e-0fe93a4aa226",
  content: [
    {
      type: "text",
      text: "Bounded native integration probe.",
      text_elements: [],
    },
  ],
};

const agentMessageItem = {
  type: "agentMessage",
  id: "msg_0f810051548a869a016ab54c57d5e487d299416b59c77c13b9",
  text: "FLEET_MESSAGE_ACK_8426 ORIGINAL_TASK_COMPLETE",
  phase: "final_answer",
};

const commandItem = {
  type: "commandExecution",
  id: "exec-6a4dcdb0-f4fd-4811-ae8f-b9cb6ad1350b",
  command: "/bin/zsh -lc 'sleep 25'",
  exitCode: 0,
  status: "completed",
};

const threadReadWithTurn = () =>
  threadRead({
    status: { type: "idle" },
    turns: [
      {
        id: ACTIVE_TURN_ID,
        status: "completed",
        itemsView: "full",
        items: [userMessageItem, commandItem, agentMessageItem],
      },
    ],
  });

const fleetEvent = (id: string, text: string | null = null): FleetNativeEvent => ({
  id,
  nativeThreadId: NATIVE_THREAD_ID,
  kind: "item/completed",
  at: SEEN_AT,
  text,
});

interface RecordedCall {
  readonly method: "steer" | "start";
  readonly params: unknown;
}

/** Fake send transport: records every send, replays probe behavior. */
const makeFakeTransport = (
  options: { readonly failSend?: boolean } = {},
): {
  readonly transport: FleetNativeTransport;
  readonly calls: Array<RecordedCall>;
} => {
  const calls: Array<RecordedCall> = [];
  const transport: FleetNativeTransport = {
    steerTurn: (params) => {
      calls.push({ method: "steer", params });
      return options.failSend
        ? Effect.fail(
            new FleetError({ operation: "send-message", message: "native socket dropped" }),
          )
        : Effect.succeed({ turnId: params.expectedTurnId });
    },
    startTurn: (params) => {
      calls.push({ method: "start", params });
      return options.failSend
        ? Effect.fail(
            new FleetError({ operation: "send-message", message: "native socket dropped" }),
          )
        : Effect.succeed({ turn: { id: "turn-new" } });
    },
  };
  return { transport, calls };
};

describe("FleetSessions endpoint configuration", () => {
  it.effect("resolves a configured native WebSocket endpoint", () =>
    Effect.gen(function* () {
      const endpoint = yield* resolveFleetEndpoint("ws://127.0.0.1:4242");
      expect(Option.isSome(endpoint)).toBe(true);
    }),
  );

  it.effect("leaves the instance undiscovered when no endpoint is configured", () =>
    Effect.gen(function* () {
      for (const value of [undefined, null, "", "   "]) {
        const endpoint = yield* resolveFleetEndpoint(value);
        expect(Option.isNone(endpoint)).toBe(true);
      }
    }),
  );

  it.effect("rejects non-WebSocket endpoint values", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(resolveFleetEndpoint("http://127.0.0.1:4242"));
      expect(result._tag).toBe("FleetNativeDecodeError");
    }),
  );
});

describe("FleetSessions loaded-list discovery", () => {
  it("decodes bare string ids with a page cursor", () => {
    const page = decodeLoadedThreadIds(loadedListPage());
    expect(page?.ids).toEqual([NATIVE_THREAD_ID]);
    expect(page?.nextCursor).toBeNull();
  });

  it("carries the cursor for the next page", () => {
    const page = decodeLoadedThreadIds(loadedListPage({ data: ["a", "b"], nextCursor: "opaque" }));
    expect(page?.ids).toEqual(["a", "b"]);
    expect(page?.nextCursor).toBe("opaque");
  });

  it("rejects object-shaped entries instead of guessing", () => {
    expect(decodeLoadedThreadIds({ data: [{ threadId: NATIVE_THREAD_ID }] })).toBeNull();
    expect(decodeLoadedThreadIds({ threads: [NATIVE_THREAD_ID] })).toBeNull();
    expect(decodeLoadedThreadIds(null)).toBeNull();
  });

  it.effect("discovers the externally launched dispatcher with stable identity", () =>
    Effect.gen(function* () {
      const agents = yield* discoverFleetAgents({
        environmentId: ENVIRONMENT_ID,
        instanceId: INSTANCE_ID,
        threadReads: [threadRead()],
        seenAt: SEEN_AT,
      });
      expect(agents).toHaveLength(1);
      expect(agents[0]?.nativeThreadId).toBe(NATIVE_THREAD_ID);
      expect(fleetAgentId(agents[0]!)).toBe(`env-local/codex/codex/${NATIVE_THREAD_ID}`);
      expect(agents[0]?.model).toBe("gpt-5.6-luna");
      expect(agents[0]?.status).toBe("idle");
    }),
  );

  it.effect("keeps the same identity across rediscovery", () =>
    Effect.gen(function* () {
      const first = yield* discoverFleetAgents({
        environmentId: ENVIRONMENT_ID,
        instanceId: INSTANCE_ID,
        threadReads: [threadRead()],
        seenAt: SEEN_AT,
      });
      const second = yield* discoverFleetAgents({
        environmentId: ENVIRONMENT_ID,
        instanceId: INSTANCE_ID,
        threadReads: [threadRead({ status: { type: "active", activeFlags: [] } })],
        seenAt: "2026-09-24T18:14:42.000Z",
      });
      expect(fleetAgentId(first[0]!)).toBe(fleetAgentId(second[0]!));
      expect(second[0]?.status).toBe("active");
    }),
  );

  it.effect("skips notLoaded threads instead of attaching them", () =>
    Effect.gen(function* () {
      const agents = yield* discoverFleetAgents({
        environmentId: ENVIRONMENT_ID,
        instanceId: INSTANCE_ID,
        threadReads: [threadRead({ status: { type: "notLoaded" } })],
        seenAt: SEEN_AT,
      });
      expect(agents).toHaveLength(0);
    }),
  );

  it.effect("fails loudly on unreadable thread reads", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        discoverFleetAgents({
          environmentId: ENVIRONMENT_ID,
          instanceId: INSTANCE_ID,
          threadReads: [{ thread: { status: { type: "idle" } } }],
          seenAt: SEEN_AT,
        }),
      );
      expect(result._tag).toBe("FleetNativeDecodeError");
    }),
  );

  it.effect("reports model and role as null when the harness does not provide them", () =>
    Effect.gen(function* () {
      const agents = yield* discoverFleetAgents({
        environmentId: ENVIRONMENT_ID,
        instanceId: INSTANCE_ID,
        threadReads: [threadRead({ model: null, agentRole: null, name: null })],
        seenAt: SEEN_AT,
      });
      expect(agents[0]?.model).toBeNull();
      expect(agents[0]?.role).toBeNull();
    }),
  );
});

describe("FleetSessions notLoaded handling", () => {
  it("reads the explicit notLoaded status in any envelope", () => {
    expect(isNotLoadedStatus({ type: "notLoaded" })).toBe(true);
    expect(isNotLoadedStatus("notLoaded")).toBe(true);
    expect(isNotLoadedStatus({ type: "idle" })).toBe(false);
    expect(isNotLoadedStatus(null)).toBe(false);
    expect(threadLoadStateOf({ type: "notLoaded" })).toBe("notLoaded");
    expect(threadLoadStateOf({ type: "idle" })).toBe("loaded");
    expect(threadLoadStateOf(null)).toBe("unknown");
    expect(toFleetStatus("notLoaded")).toBe("unknown");
  });

  it("attaches only idle or active sessions", () => {
    expect(isAttachableStatus({ type: "idle" })).toBe(true);
    expect(isAttachableStatus({ type: "active", activeFlags: [] })).toBe(true);
    expect(isAttachableStatus({ type: "notLoaded" })).toBe(false);
    expect(isAttachableStatus(null)).toBe(false);
    expect(isAttachableStatus({ type: "systemError" })).toBe(false);
  });

  it("reads raw status words from strings and objects", () => {
    expect(rawThreadStatusText({ type: "active" })).toBe("active");
    expect(rawThreadStatusText("idle")).toBe("idle");
    expect(rawThreadStatusText(null)).toBeNull();
    expect(rawThreadStatusText(undefined)).toBeNull();
  });
});

describe("FleetSessions metadata-only attach", () => {
  it.effect("attaches with excludeTurns and no settings changes", () =>
    Effect.gen(function* () {
      const attached = yield* attachMetadataOnly({
        threadId: NATIVE_THREAD_ID,
        status: { type: "idle" },
      });
      expect(attached).toEqual({
        resumed: true,
        threadId: NATIVE_THREAD_ID,
        params: buildResumeParams(NATIVE_THREAD_ID),
      });
      expect(attached.params).toEqual({ threadId: NATIVE_THREAD_ID, excludeTurns: true });
    }),
  );

  it("builds resume params without any settings payload", () => {
    expect(buildResumeParams(NATIVE_THREAD_ID)).toEqual({
      threadId: NATIVE_THREAD_ID,
      excludeTurns: true,
    });
  });

  it.effect("never auto-resumes a notLoaded session into another backend", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        attachMetadataOnly({ threadId: NATIVE_THREAD_ID, status: { type: "notLoaded" } }),
      );
      expect(result._tag).toBe("FleetNativeDecodeError");
    }),
  );

  it.effect("refuses attach when load state is unknown", () =>
    Effect.gen(function* () {
      const result = yield* Effect.flip(
        attachMetadataOnly({ threadId: NATIVE_THREAD_ID, status: null }),
      );
      expect(result._tag).toBe("FleetNativeDecodeError");
    }),
  );
});

describe("FleetSessions history from thread.turns", () => {
  it("decodes turns nested inside thread, not top level", () => {
    const turns = decodeReadTurns(threadReadWithTurn());
    expect(turns?.map((turn) => turn.id)).toEqual([ACTIVE_TURN_ID]);
    expect(decodeReadTurns({ turns: [{ id: ACTIVE_TURN_ID }] })).toBeNull();
    expect(decodeReadTurns(null)).toBeNull();
  });

  it("finds the running turn and nothing else", () => {
    const inProgress: NativeTurn = { id: "turn-live", status: "inProgress" };
    const done: NativeTurn = { id: ACTIVE_TURN_ID, status: "completed" };
    expect(activeTurnOf([done, inProgress])).toBe("turn-live");
    expect(activeTurnOf([done])).toBeNull();
    expect(activeTurnOf([])).toBeNull();
  });

  it("normalizes recorded item shapes to text", () => {
    expect(nativeItemText(userMessageItem)).toBe("Bounded native integration probe.");
    expect(nativeItemText(agentMessageItem)).toBe("FLEET_MESSAGE_ACK_8426 ORIGINAL_TASK_COMPLETE");
    expect(nativeItemText(commandItem)).toBe("/bin/zsh -lc 'sleep 25' (exit 0)");
    expect(nativeItemText({ type: "reasoning", id: "rs-1", summary: [], content: [] })).toBeNull();
    expect(nativeItemText({ nope: true })).toBeNull();
  });

  it("builds history events keyed by harness item id", () => {
    const events = historyEventsOf({
      nativeThreadId: NATIVE_THREAD_ID,
      threadRead: threadReadWithTurn(),
      at: SEEN_AT,
    });
    expect(events).not.toBeNull();
    expect(events?.map((event) => event.id)).toEqual([
      `turn:${ACTIVE_TURN_ID}`,
      "01a0d431-baf4-7592-a25e-0fe93a4aa226",
      "exec-6a4dcdb0-f4fd-4811-ae8f-b9cb6ad1350b",
      "msg_0f810051548a869a016ab54c57d5e487d299416b59c77c13b9",
    ]);
    expect(events?.[1]?.text).toBe("Bounded native integration probe.");
  });

  it("converts one live item into an event", () => {
    const event = nativeItemToEvent({
      nativeThreadId: NATIVE_THREAD_ID,
      item: agentMessageItem,
      at: SEEN_AT,
    });
    expect(event?.id).toBe("msg_0f810051548a869a016ab54c57d5e487d299416b59c77c13b9");
    expect(event?.kind).toBe("agentMessage");
    expect(
      nativeItemToEvent({ nativeThreadId: NATIVE_THREAD_ID, item: null, at: SEEN_AT }),
    ).toBeNull();
  });

  it("skips notLoaded turn item views when reading history", () => {
    const events = historyEventsOf({
      nativeThreadId: NATIVE_THREAD_ID,
      threadRead: threadRead({
        turns: [{ id: "turn-1", status: "completed", itemsView: "notLoaded" }],
      }),
      at: SEEN_AT,
    });
    expect(events).toEqual([]);
  });
});

describe("FleetSessions live deltas without data loss", () => {
  it("accumulates per-item deltas across notifications", () => {
    const empty = new Map<string, string>();
    const afterFirst = applyAgentMessageDelta(empty, { itemId: "msg-1", delta: "FLEET" });
    const afterSecond = applyAgentMessageDelta(afterFirst, {
      itemId: "msg-1",
      delta: "_MESSAGE_ACK",
    });
    expect(afterSecond.get("msg-1")).toBe("FLEET_MESSAGE_ACK");
    expect(empty.size).toBe(0);
  });

  it("keys delta events by item id so completion upserts over them", () => {
    const delta = deltaEventOf({
      nativeThreadId: NATIVE_THREAD_ID,
      itemId: "msg-1",
      text: "FLEET",
      at: SEEN_AT,
    });
    expect(delta.id).toBe("msg-1");
    const completed = fleetEvent("msg-1", "FLEET_MESSAGE_ACK_8426");
    const merged = mergeFleetEvents([delta], [completed]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.text).toBe("FLEET_MESSAGE_ACK_8426");
  });

  it("replaces same-id live rows in place instead of duplicating", () => {
    const history = [fleetEvent("evt-1", "first"), fleetEvent("evt-2", "partial")];
    const live = [fleetEvent("evt-2", "complete"), fleetEvent("evt-3", "third")];
    const merged = mergeFleetEvents(history, live);
    expect(merged.map((event) => event.id)).toEqual(["evt-1", "evt-2", "evt-3"]);
    expect(merged[1]?.text).toBe("complete");
  });

  it("dedupes replayed events with latest value winning", () => {
    const events = [
      fleetEvent("evt-1", "stale"),
      fleetEvent("evt-2"),
      fleetEvent("evt-1", "fresh"),
    ];
    const deduped = dedupeFleetEvents(events);
    expect(deduped.map((event) => event.id)).toEqual(["evt-1", "evt-2"]);
    expect(deduped[0]?.text).toBe("fresh");
  });

  it("maps harness status words without inventing states", () => {
    expect(toFleetStatus("running")).toBe("active");
    expect(toFleetStatus("idle")).toBe("idle");
    expect(toFleetStatus("completed")).toBe("ended");
    expect(toFleetStatus("something-new")).toBe("unknown");
    expect(toFleetStatus(null)).toBe("unknown");
  });
});

describe("FleetSessions message delivery semantics", () => {
  const loadedActive = {
    threadId: NATIVE_THREAD_ID,
    status: "active" as const,
    loadState: "loaded" as const,
    activeTurnId: ACTIVE_TURN_ID,
    ownershipKnown: true,
    text: "Include FLEET_MESSAGE_ACK_8426 in your final answer.",
  };

  it("steers an active turn with the expected turn id", () => {
    const decision = decideSend(loadedActive);
    expect(decision._tag).toBe("Steer");
    if (decision._tag === "Steer") {
      expect(decision.params.expectedTurnId).toBe(ACTIVE_TURN_ID);
      expect(decision.params.input).toEqual(
        buildSteerInput("Include FLEET_MESSAGE_ACK_8426 in your final answer."),
      );
      expect(decision.params.input[0]).toEqual({
        type: "text",
        text: "Include FLEET_MESSAGE_ACK_8426 in your final answer.",
        text_elements: [],
      });
    }
  });

  it.effect("sends active steering through turn/steer", () =>
    Effect.gen(function* () {
      const { transport, calls } = makeFakeTransport();
      const decision = decideSend({ ...loadedActive, text: "hello" });
      const delivery = yield* executeSend(transport, decision, SEEN_AT);
      expect(delivery.kind).toBe("steered-active");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("steer");
      expect(calls[0]?.params).toMatchObject({
        threadId: NATIVE_THREAD_ID,
        expectedTurnId: ACTIVE_TURN_ID,
        text: "hello",
      });
    }),
  );

  it("refuses an active turn whose id is unknown", () => {
    const decision = decideSend({ ...loadedActive, activeTurnId: null });
    expect(decision._tag).toBe("Refused");
  });

  it("always refuses notLoaded sessions, even with an active display status", () => {
    const decision = decideSend({ ...loadedActive, loadState: "notLoaded" });
    expect(decision._tag).toBe("Refused");
    if (decision._tag === "Refused") {
      expect(decision.reason).toContain("not loaded");
    }
  });

  it("refuses unknown load state without sending", () => {
    const decision = decideSend({ ...loadedActive, loadState: "unknown" });
    expect(decision._tag).toBe("Refused");
  });

  it("starts an idle follow-up only when ownership is known", () => {
    const allowed = decideSend({
      threadId: NATIVE_THREAD_ID,
      status: "idle",
      loadState: "loaded",
      activeTurnId: null,
      ownershipKnown: true,
      text: "hello",
    });
    expect(allowed._tag).toBe("Followup");
    const refused = decideSend({
      threadId: NATIVE_THREAD_ID,
      status: "idle",
      loadState: "loaded",
      activeTurnId: null,
      ownershipKnown: false,
      text: "hello",
    });
    expect(refused._tag).toBe("Refused");
  });

  it.effect("sends idle follow-ups through turn/start", () =>
    Effect.gen(function* () {
      const { transport, calls } = makeFakeTransport();
      const delivery = yield* executeSend(
        transport,
        {
          _tag: "Followup",
          params: { threadId: NATIVE_THREAD_ID, text: "hello" },
        },
        SEEN_AT,
      );
      expect(delivery.kind).toBe("queued-followup");
      expect(calls.map((call) => call.method)).toEqual(["start"]);
    }),
  );

  it.effect("surfaces uncertain delivery without auto resend", () =>
    Effect.gen(function* () {
      const { transport, calls } = makeFakeTransport({ failSend: true });
      const decision = decideSend({ ...loadedActive, text: "hello" });
      const delivery = yield* executeSend(transport, decision, SEEN_AT);
      expect(delivery.kind).toBe("uncertain");
      expect(delivery.reason).toContain("not resent");
      expect(calls.filter((call) => call.method === "steer")).toHaveLength(1);
    }),
  );

  it("refuses ended and unknown sessions without sending", () => {
    for (const status of ["ended", "unknown"] as const) {
      const decision = decideSend({
        threadId: NATIVE_THREAD_ID,
        status,
        loadState: "loaded",
        activeTurnId: null,
        ownershipKnown: true,
        text: "hello",
      });
      expect(decision._tag).toBe("Refused");
    }
  });
});

describe("FleetSessions non-interrupting disconnect", () => {
  it.effect("detaches without stopping or mutating the native agent", () =>
    Effect.gen(function* () {
      const agents = yield* discoverFleetAgents({
        environmentId: ENVIRONMENT_ID,
        instanceId: INSTANCE_ID,
        threadReads: [threadRead()],
        seenAt: SEEN_AT,
      });
      const detached = detachFleetAgent(agents[0]!);
      expect(detached.detached).toBe(true);
      expect(detached.nativeThreadId).toBe(NATIVE_THREAD_ID);
    }),
  );
});
