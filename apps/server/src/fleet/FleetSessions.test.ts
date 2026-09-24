/**
 * FleetSessions behavioral tests.
 *
 * The fake transport replays the proven native sequence from the
 * shared.mjs probe (Codex 0.156.1): `thread/loaded/list` reports the
 * externally started thread, metadata-only `thread/resume` with
 * `excludeTurns: true` attaches the observer, `turn/steer` with the
 * original `expectedTurnId` lands while the turn runs, and `thread/read`
 * recovers the same history after reconnect.
 */
import { describe, expect, it } from "@effect/vitest";
import {
  type EnvironmentId,
  type FleetNativeEvent,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  attachMetadataOnly,
  buildResumeParams,
  buildSteerInput,
  decideSend,
  dedupeFleetEvents,
  detachFleetAgent,
  discoverFleetAgents,
  executeSend,
  fleetAgentId,
  isAttachableThread,
  mergeFleetEvents,
  resolveFleetEndpoint,
  toFleetStatus,
  type FleetNativeTransport,
  type NativeLoadedThread,
} from "./FleetSessions.ts";

const ENVIRONMENT_ID = "env-local" as EnvironmentId;
const INSTANCE_ID = "codex" as ProviderInstanceId;
const NATIVE_THREAD_ID = "01a0d431-b396-7023-a2aa-bc7ed6c6bc0c";
const ACTIVE_TURN_ID = "01a0d431-b3c1-70e1-957e-88bc5fe51d2b";
const SEEN_AT = "2026-09-24T18:13:42.000Z";

const loadedThread = (overrides: Partial<NativeLoadedThread> = {}): NativeLoadedThread => ({
  threadId: NATIVE_THREAD_ID,
  status: { type: "idle" },
  model: "gpt-5.6-luna",
  cwd: "/tmp/t3-fleet-spec/probe",
  ...overrides,
});

const fleetEvent = (id: string, text: string | null = null): FleetNativeEvent => ({
  id,
  nativeThreadId: NATIVE_THREAD_ID,
  kind: "item/completed",
  at: SEEN_AT,
  text,
});

interface RecordedCall {
  readonly method: string;
  readonly params: unknown;
}

/** Shared.mjs-style fake: records every call, replays probe behavior. */
const makeFakeTransport = (
  options: { readonly failSteer?: boolean } = {},
): {
  readonly transport: FleetNativeTransport;
  readonly calls: Array<RecordedCall>;
} => {
  const calls: Array<RecordedCall> = [];
  const record = (method: string, params: unknown) => {
    calls.push({ method, params });
  };
  const transport: FleetNativeTransport = {
    listLoadedThreads: () => Effect.succeed([loadedThread()]),
    resumeThread: (params) => Effect.succeed(record("thread/resume", params)),
    readThread: (params) =>
      Effect.succeed({
        thread: {
          id: params.threadId,
          status: { type: "idle" },
          model: "gpt-5.6-luna",
        },
        turns: [{ id: ACTIVE_TURN_ID, status: "completed" }],
      }),
    steerTurn: (params) => {
      record("turn/steer", params);
      return options.failSteer
        ? Effect.fail({
            _tag: "FleetNativeDecodeError",
            operation: "decode-thread-read",
          } as never)
        : Effect.succeed({ ok: true });
    },
    startTurn: (params) => Effect.succeed(record("turn/start", params)),
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

describe("FleetSessions discovery and stable identity", () => {
  it.effect("discovers the externally launched dispatcher with stable identity", () =>
    Effect.gen(function* () {
      const { transport } = makeFakeTransport();
      const loaded = yield* transport.listLoadedThreads();
      const agents = yield* discoverFleetAgents({
        environmentId: ENVIRONMENT_ID,
        instanceId: INSTANCE_ID,
        loadedThreads: loaded,
        seenAt: SEEN_AT,
      });
      expect(agents).toHaveLength(1);
      expect(agents[0]?.nativeThreadId).toBe(NATIVE_THREAD_ID);
      expect(fleetAgentId(agents[0]!)).toBe(`env-local/codex/codex/${NATIVE_THREAD_ID}`);
      expect(agents[0]?.model).toBe("gpt-5.6-luna");
    }),
  );

  it.effect("keeps the same identity across rediscovery", () =>
    Effect.gen(function* () {
      const first = yield* discoverFleetAgents({
        environmentId: ENVIRONMENT_ID,
        instanceId: INSTANCE_ID,
        loadedThreads: [loadedThread()],
        seenAt: SEEN_AT,
      });
      const second = yield* discoverFleetAgents({
        environmentId: ENVIRONMENT_ID,
        instanceId: INSTANCE_ID,
        loadedThreads: [loadedThread({ status: { type: "running" } })],
        seenAt: "2026-09-24T18:14:42.000Z",
      });
      expect(fleetAgentId(first[0]!)).toBe(fleetAgentId(second[0]!));
    }),
  );

  it.effect("skips entries without native session identity instead of guessing", () =>
    Effect.gen(function* () {
      const agents = yield* discoverFleetAgents({
        environmentId: ENVIRONMENT_ID,
        instanceId: INSTANCE_ID,
        loadedThreads: [{ status: { type: "idle" }, model: "gpt-5.6-luna" }],
        seenAt: SEEN_AT,
      });
      expect(agents).toHaveLength(0);
    }),
  );

  it.effect("reports model and role as null when the harness does not provide them", () =>
    Effect.gen(function* () {
      const agents = yield* discoverFleetAgents({
        environmentId: ENVIRONMENT_ID,
        instanceId: INSTANCE_ID,
        loadedThreads: [loadedThread({ model: undefined, agentRole: undefined })],
        seenAt: SEEN_AT,
      });
      expect(agents[0]?.model).toBeNull();
      expect(agents[0]?.role).toBeNull();
    }),
  );
});

describe("FleetSessions metadata-only attach", () => {
  it.effect("attaches with excludeTurns and no settings changes", () =>
    Effect.gen(function* () {
      const { transport, calls } = makeFakeTransport();
      const attached = yield* attachMetadataOnly(transport, loadedThread());
      expect(attached).toEqual({ resumed: true, threadId: NATIVE_THREAD_ID });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        method: "thread/resume",
        params: buildResumeParams(NATIVE_THREAD_ID),
      });
      expect(calls[0]?.params).toEqual({ threadId: NATIVE_THREAD_ID, excludeTurns: true });
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
      const { transport, calls } = makeFakeTransport();
      const entry = loadedThread({ loaded: false });
      expect(isAttachableThread(entry)).toBe(false);
      const result = yield* Effect.flip(attachMetadataOnly(transport, entry));
      expect(result._tag).toBe("FleetNativeDecodeError");
      expect(calls).toHaveLength(0);
    }),
  );
});

describe("FleetSessions history and live continuity", () => {
  it.effect("reads the same thread history after reconnect", () =>
    Effect.gen(function* () {
      const { transport } = makeFakeTransport();
      const before = yield* transport.readThread({ threadId: NATIVE_THREAD_ID });
      const after = yield* transport.readThread({ threadId: NATIVE_THREAD_ID });
      expect(after.thread?.id).toBe(before.thread?.id);
      expect(after.turns?.map((turn) => turn.id)).toEqual(before.turns?.map((turn) => turn.id));
    }),
  );

  it("merges history and live events without duplicates", () => {
    const history = [fleetEvent("evt-1", "first"), fleetEvent("evt-2", "second")];
    const live = [fleetEvent("evt-2", "second"), fleetEvent("evt-3", "third")];
    const merged = mergeFleetEvents(history, live);
    expect(merged.map((event) => event.id)).toEqual(["evt-1", "evt-2", "evt-3"]);
  });

  it("dedupes replayed events while keeping first order", () => {
    const events = [fleetEvent("evt-1"), fleetEvent("evt-2"), fleetEvent("evt-1")];
    expect(dedupeFleetEvents(events).map((event) => event.id)).toEqual(["evt-1", "evt-2"]);
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
  it("steers an active turn with the expected turn id", () => {
    const decision = decideSend({
      threadId: NATIVE_THREAD_ID,
      status: "active",
      activeTurnId: ACTIVE_TURN_ID,
      ownershipKnown: true,
      text: "Include FLEET_MESSAGE_ACK_8426 in your final answer.",
    });
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
      const decision = decideSend({
        threadId: NATIVE_THREAD_ID,
        status: "active",
        activeTurnId: ACTIVE_TURN_ID,
        ownershipKnown: true,
        text: "hello",
      });
      const delivery = yield* executeSend(transport, decision, SEEN_AT);
      expect(delivery.kind).toBe("steered-active");
      expect(calls.map((call) => call.method)).toEqual(["turn/steer"]);
    }),
  );

  it("starts an idle follow-up only when ownership is known", () => {
    const allowed = decideSend({
      threadId: NATIVE_THREAD_ID,
      status: "idle",
      activeTurnId: null,
      ownershipKnown: true,
      text: "hello",
    });
    expect(allowed._tag).toBe("Followup");
    const refused = decideSend({
      threadId: NATIVE_THREAD_ID,
      status: "idle",
      activeTurnId: null,
      ownershipKnown: false,
      text: "hello",
    });
    expect(refused._tag).toBe("Refused");
  });

  it.effect("surfaces uncertain delivery without auto resend", () =>
    Effect.gen(function* () {
      const { transport, calls } = makeFakeTransport({ failSteer: true });
      const decision = decideSend({
        threadId: NATIVE_THREAD_ID,
        status: "active",
        activeTurnId: ACTIVE_TURN_ID,
        ownershipKnown: true,
        text: "hello",
      });
      const delivery = yield* executeSend(transport, decision, SEEN_AT);
      expect(delivery.kind).toBe("uncertain");
      expect(delivery.reason).toContain("not resent");
      expect(calls.filter((call) => call.method === "turn/steer")).toHaveLength(1);
    }),
  );

  it("refuses ended and unknown sessions without sending", () => {
    for (const status of ["ended", "unknown"] as const) {
      const decision = decideSend({
        threadId: NATIVE_THREAD_ID,
        status,
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
      const { calls } = makeFakeTransport();
      const agents = yield* discoverFleetAgents({
        environmentId: ENVIRONMENT_ID,
        instanceId: INSTANCE_ID,
        loadedThreads: [loadedThread()],
        seenAt: SEEN_AT,
      });
      const detached = detachFleetAgent(agents[0]!);
      expect(detached.detached).toBe(true);
      expect(detached.nativeThreadId).toBe(NATIVE_THREAD_ID);
      expect(calls).toHaveLength(0);
    }),
  );
});
