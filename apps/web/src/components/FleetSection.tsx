/**
 * Fleet section of the agents panel: externally launched native agents
 * (Codex first slice) across connected environments.
 *
 * Each environment's T3 server exposes its own native sessions; this
 * section aggregates them under stable
 * environment/provider/instance/native-thread identity. Rows are clickable:
 * selecting one opens its live transcript with the composer that messages
 * the native session in place. Selecting or viewing never stops the native
 * session or changes its permissions.
 */
import {
  appendFleetEvents,
  emptyFleetState,
  fleetDeliveryLabel,
  fleetPanelRows,
  ingestEnvironmentSnapshot,
  markEnvironmentOffline,
  mergeFleetEventLists,
  removeFleetAgent,
  setFleetEndpointNotice,
  upsertFleetAgent,
  type FleetPanelRow,
  type FleetState,
} from "@t3tools/client-runtime/state/fleetRuntime";
import type {
  EnvironmentId,
  FleetAgent,
  FleetMessageDelivery,
  FleetNativeEvent,
  FleetStreamEvent,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Input } from "~/components/ui/input";
import { ScrollArea } from "~/components/ui/scroll-area";
import { fleetEnvironment } from "~/state/fleet";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

export interface FleetSelection {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly nativeThreadId: string;
}

function selectionKey(selection: FleetSelection): string {
  return `${selection.environmentId}/${selection.instanceId}/${selection.nativeThreadId}`;
}

const FLEET_STATUS_VISUALS: Record<FleetPanelRow["status"], { dotClass: string; label: string }> = {
  active: { dotClass: "bg-info", label: "Active" },
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle" },
  ended: { dotClass: "bg-muted-foreground/60", label: "Ended" },
  unknown: { dotClass: "bg-muted-foreground/60", label: "Unknown" },
};

function FleetAgentRow({
  row,
  selected,
  onSelect,
}: {
  row: FleetPanelRow;
  selected: boolean;
  onSelect: () => void;
}) {
  const visuals = FLEET_STATUS_VISUALS[row.status];
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      aria-label={`Fleet agent ${row.nativeThreadId} in ${row.environmentId}, ${visuals.label}${row.online ? "" : ", offline"}`}
      className={cn(
        "grid h-[3.875rem] w-full grid-cols-[0.375rem_minmax(0,1fr)_auto] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/40",
        selected && "bg-accent/60",
        !row.online && "opacity-60",
      )}
    >
      <span className="col-start-1 row-start-1 flex items-center">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", visuals.dotClass)} />
      </span>
      <span className="col-start-2 row-start-1 min-w-0 truncate font-mono text-sm">
        {row.nativeThreadId}
      </span>
      <span className="col-start-3 row-start-1 min-w-14 text-right font-mono text-[.7rem] text-muted-foreground/80">
        {row.online ? visuals.label : "Offline"}
      </span>
      <span className="col-start-2 col-end-4 row-start-2 block truncate font-mono text-xs text-muted-foreground">
        {row.environmentId} · {row.provider}/{row.instanceId}
      </span>
      <span className="col-start-2 col-end-4 row-start-3 truncate font-mono text-[.7rem] tabular-nums text-muted-foreground/70">
        {row.detail ?? `${row.eventCount} events`}
        {row.detail ? ` · ${row.eventCount} events` : ""}
      </span>
      <span className="sr-only">{visuals.label}</span>
    </button>
  );
}

function FleetEventRow({ event }: { event: FleetNativeEvent }) {
  return (
    <div className="rounded-md border border-border/40 px-2 py-1.5">
      <div className="font-mono text-[.65rem] uppercase tracking-wider text-muted-foreground/70">
        {event.kind}
      </div>
      {event.text !== null && event.text.length > 0 ? (
        <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-foreground/90">
          {event.text}
        </div>
      ) : null}
    </div>
  );
}

function FleetComposer({
  selection,
  activeTurnId,
  status,
  online,
  onSent,
}: {
  selection: FleetSelection;
  activeTurnId: string | null;
  status: FleetPanelRow["status"];
  online: boolean;
  onSent: (delivery: FleetMessageDelivery) => void;
}) {
  const [text, setText] = useState("");
  const [ownershipConfirmed, setOwnershipConfirmed] = useState(false);
  const [sending, setSending] = useState(false);
  const sendMessage = useAtomCommand(fleetEnvironment.sendMessage, {
    label: "fleet send-message",
    reportFailure: false,
  });

  const needsOwnership = status === "idle" && activeTurnId === null;
  const canSend =
    online && !sending && text.trim().length > 0 && (!needsOwnership || ownershipConfirmed);

  const send = useCallback(async () => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || !canSend) return;
    setSending(true);
    try {
      const result = await sendMessage({
        environmentId: selection.environmentId,
        input: {
          instanceId: selection.instanceId,
          nativeThreadId: selection.nativeThreadId,
          text: trimmed,
          expectedActiveTurnId: activeTurnId,
          ownershipKnown: !needsOwnership || ownershipConfirmed,
        },
      });
      if (result._tag === "Success") {
        onSent(result.value);
        if (result.value.kind === "steered-active" || result.value.kind === "queued-followup") {
          setText("");
          setOwnershipConfirmed(false);
        }
      } else {
        onSent({
          kind: "uncertain",
          reason: "The send call failed before the server answered. It was not resent.",
          at: new Date().toISOString(),
        });
      }
    } finally {
      setSending(false);
    }
  }, [
    activeTurnId,
    canSend,
    needsOwnership,
    onSent,
    ownershipConfirmed,
    selection,
    sendMessage,
    text,
  ]);

  return (
    <div className="border-t border-border/60 p-2">
      {needsOwnership ? (
        <label className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={ownershipConfirmed}
            onCheckedChange={(checked) => setOwnershipConfirmed(checked === true)}
            aria-label="Confirm this idle session is mine to continue"
          />
          This idle session is mine to continue
        </label>
      ) : null}
      <div className="flex items-center gap-1.5">
        <Input
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void send();
            }
          }}
          placeholder={
            !online
              ? "Environment offline"
              : status === "active"
                ? "Steer the running turn…"
                : status === "idle"
                  ? "Start a follow-up turn…"
                  : "Session is not messageable"
          }
          disabled={!online || sending || (status !== "active" && status !== "idle")}
          aria-label="Message the native agent"
        />
        <Button size="sm" onClick={() => void send()} disabled={!canSend}>
          {sending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}

function FleetDetail({
  selection,
  liveEvents,
  agentRow,
  onClose,
}: {
  selection: FleetSelection;
  liveEvents: ReadonlyArray<FleetNativeEvent>;
  agentRow: FleetPanelRow | undefined;
  onClose: () => void;
}) {
  const [delivery, setDelivery] = useState<FleetMessageDelivery | null>(null);
  const history = useEnvironmentQuery(
    fleetEnvironment.threadHistory({
      environmentId: selection.environmentId,
      input: { instanceId: selection.instanceId, nativeThreadId: selection.nativeThreadId },
    }),
  );
  const events = useMemo(
    () => mergeFleetEventLists(history.data?.events ?? [], liveEvents),
    [history.data, liveEvents],
  );
  const activeTurnId = history.data?.activeTurnId ?? null;
  const status = agentRow?.status ?? history.data?.agent.status ?? "unknown";
  const online = agentRow?.online ?? true;

  useEffect(() => {
    setDelivery(null);
  }, [selectionKey(selection)]);

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-border/50 bg-card/30">
      <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1.5">
        <span className="min-w-0 truncate font-mono text-xs">{selection.nativeThreadId}</span>
        <span className="ml-auto font-mono text-[.65rem] text-muted-foreground">
          {selection.environmentId} · {status}
          {online ? "" : " · offline"}
        </span>
        <Button
          size="icon-micro"
          variant="ghost-muted"
          onClick={onClose}
          aria-label="Close fleet detail"
        >
          ×
        </Button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-1.5 p-2">
          {history.isPending && events.length === 0 ? (
            <p className="text-xs text-muted-foreground">Loading native history…</p>
          ) : null}
          {history.error !== null && events.length === 0 ? (
            <p className="text-xs text-destructive-foreground">{history.error}</p>
          ) : null}
          {events.map((event) => (
            <FleetEventRow key={event.id} event={event} />
          ))}
          {events.length === 0 && !history.isPending && history.error === null ? (
            <p className="text-xs text-muted-foreground">No transcript items yet.</p>
          ) : null}
        </div>
      </ScrollArea>
      {delivery !== null ? (
        <p className="border-t border-border/40 px-2 py-1 font-mono text-[.7rem] text-muted-foreground">
          {fleetDeliveryLabel(delivery)}
          {delivery.reason !== null &&
          (delivery.kind === "uncertain" ||
            delivery.kind === "refused" ||
            delivery.kind === "failed")
            ? `: ${delivery.reason}`
            : ""}
        </p>
      ) : null}
      <FleetComposer
        selection={selection}
        activeTurnId={activeTurnId}
        status={status}
        online={online}
        onSent={setDelivery}
      />
    </div>
  );
}

function FleetEnvSync({
  environmentId,
  onSnapshot,
  onStreamEvent,
  onUnreachable,
}: {
  environmentId: EnvironmentId;
  onSnapshot: (snapshot: { environmentId: string; agents: ReadonlyArray<FleetAgent> }) => void;
  onStreamEvent: (event: FleetStreamEvent) => void;
  onUnreachable: (environmentId: string) => void;
}) {
  const list = useEnvironmentQuery(fleetEnvironment.agentList({ environmentId, input: {} }));
  const live = useEnvironmentQuery(fleetEnvironment.subscription({ environmentId, input: {} }));
  const listData = list.data;
  const listError = list.error;
  const liveData = live.data;

  useEffect(() => {
    if (listData !== null) {
      onSnapshot({ environmentId, agents: listData.agents });
    } else if (listError !== null) {
      onUnreachable(environmentId);
    }
  }, [environmentId, listData, listError, onSnapshot, onUnreachable]);

  useEffect(() => {
    if (liveData !== null) onStreamEvent(liveData);
  }, [liveData, onStreamEvent]);

  return null;
}

export function FleetSection({ environmentIds }: { environmentIds: ReadonlyArray<EnvironmentId> }) {
  const [fleetState, setFleetState] = useState<FleetState>(emptyFleetState);
  const [selection, setSelection] = useState<FleetSelection | null>(null);

  const ingestSnapshot = useCallback(
    (snapshot: { environmentId: string; agents: ReadonlyArray<FleetAgent> }) => {
      setFleetState((state) => ingestEnvironmentSnapshot(state, { ...snapshot, events: [] }));
    },
    [],
  );

  const handleStreamEvent = useCallback((event: FleetStreamEvent) => {
    setFleetState((state) => {
      switch (event.kind) {
        case "agent-updated":
          return upsertFleetAgent(state, event.agent);
        case "events-appended":
          return appendFleetEvents(state, event.agentId, event.events);
        case "agent-removed":
          return removeFleetAgent(state, event.agentId);
        case "endpoint-unreachable":
          return setFleetEndpointNotice(state, event.instanceId, event.message);
      }
    });
  }, []);

  const handleUnreachable = useCallback((environmentId: string) => {
    setFleetState((state) => markEnvironmentOffline(state, environmentId));
  }, []);

  const rows = useMemo(() => fleetPanelRows(fleetState), [fleetState]);
  const selectedKey = selection === null ? null : selectionKey(selection);
  const selectedRow = rows.find((row) => row.id === selectedKey);
  const selectedLiveEvents = useMemo(
    () => (selectedKey === null ? [] : (fleetState.eventsByAgent[selectedKey] ?? [])),
    [fleetState, selectedKey],
  );

  if (environmentIds.length === 0) return null;

  return (
    <section>
      <div className="px-1.5 pt-1 text-[.65rem] font-medium uppercase tracking-wider text-muted-foreground">
        Fleet
      </div>
      {environmentIds.map((environmentId) => (
        <FleetEnvSync
          key={environmentId}
          environmentId={environmentId}
          onSnapshot={ingestSnapshot}
          onStreamEvent={handleStreamEvent}
          onUnreachable={handleUnreachable}
        />
      ))}
      {Object.entries(fleetState.endpointNotices).map(([instanceId, notice]) => (
        <p
          key={instanceId}
          className="px-1.5 py-0.5 font-mono text-[.7rem] text-destructive-foreground"
        >
          {instanceId}: {notice}
        </p>
      ))}
      {rows.map((row) => (
        <FleetAgentRow
          key={row.id}
          row={row}
          selected={row.id === selectedKey}
          onSelect={() =>
            setSelection((current) =>
              current !== null && selectionKey(current) === row.id
                ? null
                : {
                    environmentId: row.environmentId as EnvironmentId,
                    instanceId: row.instanceId as ProviderInstanceId,
                    nativeThreadId: row.nativeThreadId,
                  },
            )
          }
        />
      ))}
      {selection !== null ? (
        <div className="px-1.5 pb-1">
          <FleetDetail
            selection={selection}
            liveEvents={selectedLiveEvents}
            agentRow={selectedRow}
            onClose={() => setSelection(null)}
          />
        </div>
      ) : null}
    </section>
  );
}
