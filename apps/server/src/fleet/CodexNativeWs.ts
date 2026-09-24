/**
 * CodexNativeWs - production WebSocket transport for an externally launched
 * Codex native app-server.
 *
 * The fleet pane never spawns its own app-server. It dials the WebSocket URL
 * configured per Codex provider instance (`CodexSettings.nativeEndpoint`),
 * runs the proven native handshake (`initialize` with `experimentalApi: true`
 * followed by the `initialized` notification), and speaks the same JSON-RPC
 * framing the vendored `effect-codex-app-server` protocol layer uses for
 * stdio: one JSON object per line over a byte stream. WebSocket text frames
 * are already discrete messages, so each frame is fed to the protocol as one
 * line.
 *
 * Closing a client only closes T3's socket. It sends no stop, close,
 * archive, or permission payload to the native backend; the native session
 * keeps running under its original owner.
 *
 * @module fleet/CodexNativeWs
 */
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as CodexError from "effect-codex-app-server/errors";
import {
  makeCodexAppServerPatchedProtocol,
  type CodexAppServerIncomingNotification,
  type CodexAppServerPatchedProtocol,
} from "effect-codex-app-server/protocol";

export type { CodexAppServerIncomingNotification };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const FLEET_CLIENT_NAME = "t3-fleet";
const FLEET_CLIENT_VERSION = "0.0.0";

/** Minimal socket surface. Satisfied by the global WebSocket in production. */
export interface FleetNativeSocket {
  readonly send: (text: string) => void;
  readonly close: () => void;
  readonly onOpen: (callback: () => void) => void;
  readonly onMessage: (callback: (text: string) => void) => void;
  readonly onError: (callback: (cause: unknown) => void) => void;
  readonly onClose: (callback: () => void) => void;
}

export type FleetNativeSocketFactory = (url: string) => FleetNativeSocket;

const toTransportError = (cause: unknown): CodexError.CodexAppServerError =>
  new CodexError.CodexAppServerTransportError({ operation: "read-input-stream", cause });

/** Production factory over the global WebSocket (Node 22+, browsers, Bun). */
export const globalWebSocketFactory: FleetNativeSocketFactory = (url: string) => {
  const socket = new WebSocket(url);
  return {
    send: (text: string) => {
      socket.send(text);
    },
    close: () => {
      socket.close();
    },
    onOpen: (callback: () => void) => {
      socket.onopen = () => {
        callback();
      };
    },
    onMessage: (callback: (text: string) => void) => {
      socket.onmessage = (event: MessageEvent) => {
        const data = event.data;
        callback(typeof data === "string" ? data : decoder.decode(data as ArrayBuffer));
      };
    },
    onError: (callback: (cause: unknown) => void) => {
      socket.onerror = (event: Event) => {
        callback(event);
      };
    },
    onClose: (callback: () => void) => {
      socket.onclose = () => {
        callback();
      };
    },
  };
};

export interface FleetNativeClient {
  readonly url: string;
  /** Raw JSON-RPC request. Responses decode at the call site. */
  readonly request: CodexAppServerPatchedProtocol["request"];
  readonly notify: CodexAppServerPatchedProtocol["notify"];
  readonly notifications: Stream.Stream<
    CodexAppServerIncomingNotification,
    CodexError.CodexAppServerError
  >;
  /** Close T3's socket. Sends nothing to the native backend. */
  readonly close: Effect.Effect<void>;
}

/**
 * Dial a native endpoint and complete the native handshake. Fails when the
 * socket never opens or the `initialize` round trip fails; callers treat
 * that as an unreachable endpoint and never retry blindly inside one call.
 */
export const openFleetNativeClient = Effect.fn("CodexNativeWs.openFleetNativeClient")(function* (
  url: string,
  factory: FleetNativeSocketFactory = globalWebSocketFactory,
): Effect.fn.Return<FleetNativeClient, CodexError.CodexAppServerError, Scope.Scope> {
  const socket = yield* Effect.sync(() => factory(url));
  const inbound = yield* Queue.unbounded<string, Cause.Done<void>>();
  const opened = yield* Deferred.make<void, CodexError.CodexAppServerError>();

  yield* Effect.sync(() => {
    socket.onOpen(() => {
      Deferred.doneUnsafe(opened, Effect.void);
    });
    socket.onMessage((text: string) => {
      Queue.offerUnsafe(inbound, text);
    });
    socket.onError((cause: unknown) => {
      Deferred.doneUnsafe(opened, Effect.fail(toTransportError(cause)));
      Queue.endUnsafe(inbound);
    });
    socket.onClose(() => {
      Deferred.doneUnsafe(
        opened,
        Effect.fail(toTransportError(new Error("Native socket closed before it opened."))),
      );
      Queue.endUnsafe(inbound);
    });
  });

  yield* Deferred.await(opened);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      socket.close();
    }),
  );

  const stdio = Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromQueue(inbound).pipe(
      Stream.map((text: string) => encoder.encode(`${text}\n`)),
    ),
    stdout: () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Effect.try({
          try: () => {
            socket.send(typeof chunk === "string" ? chunk : decoder.decode(chunk));
          },
          catch: (cause: unknown) =>
            PlatformError.systemError({
              _tag: "Unknown",
              module: "CodexNativeWs",
              method: "send",
              description: "Failed to send a frame to the native Codex app-server.",
              cause,
            }),
        }),
      ),
    stderr: () => Sink.drain,
  });

  const protocol = yield* makeCodexAppServerPatchedProtocol({
    stdio,
    terminationError: Effect.succeed(toTransportError(new Error("Native socket failed."))),
  });

  yield* protocol
    .request("initialize", {
      clientInfo: { name: FLEET_CLIENT_NAME, version: FLEET_CLIENT_VERSION },
      capabilities: { experimentalApi: true },
    })
    .pipe(Effect.asVoid);
  yield* protocol.notify("initialized", undefined).pipe(Effect.ignore);

  return {
    url,
    request: protocol.request,
    notify: protocol.notify,
    notifications: protocol.incomingNotifications,
    close: Effect.sync(() => {
      socket.close();
    }),
  };
});
