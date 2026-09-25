import type { EnvironmentId, IssueDetail, IssueRef, IssueStateAction } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { ExternalLinkIcon, MessageSquarePlusIcon, SendIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { formatRelativeTimeLabel } from "~/timestampFormat";
import { issueComment, issueSetState, useIssueDetail } from "~/state/issues";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  PullRequestMarkdown,
  PullRequestMarkdownContext,
} from "../pullRequest/PullRequestMarkdown";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ISSUE_STATE_PRESENTATION, IssueStateGlyph } from "./issuePresentation";

const STATE_ACTION_LABELS: Record<IssueStateAction, { idle: string; busy: string }> = {
  "close-completed": { idle: "Close as completed", busy: "Closing..." },
  "close-not-planned": { idle: "Close as not planned", busy: "Closing..." },
  reopen: { idle: "Reopen", busy: "Reopening..." },
};

/**
 * One Issue beside the list: its body and comments, a comment box, and close or reopen. Every
 * write goes to GitHub through the server that listed the Issue, then the panel reads it again.
 */
export function IssueDetailPanel({
  environmentId,
  reference,
  cwd,
  onClose,
  onChanged,
  startDisabledReason,
  onStart,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  /** A checkout on the same server, which markdown media are fetched through. */
  cwd: string;
  onClose: () => void;
  /** The Issue changed on GitHub; the list should read it again. */
  onChanged: () => void;
  /** Why no thread can start from this Issue, or null when one can. */
  startDisabledReason: string | null;
  onStart: (detail: IssueDetail) => void;
}) {
  const result = useIssueDetail(environmentId, reference);
  const detail = AsyncResult.isSuccess(result) ? result.value : null;
  const markdownContext = useMemo(
    () => ({ repositoryUrl: `https://${reference.host}/${reference.repository}`, threadRef: null }),
    [reference.host, reference.repository],
  );
  return (
    <aside
      aria-label={`${reference.repository}#${reference.number}`}
      className="flex min-h-0 w-[min(44rem,50%)] shrink-0 flex-col border-l border-border bg-background"
    >
      <div className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center gap-2 border-b border-border px-3 [-webkit-app-region:no-drag]">
        {detail ? <IssueStateGlyph state={detail.state} /> : null}
        <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
          {reference.repository}#{reference.number}
        </span>
        <div className="min-w-0 flex-1" />
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label="Start a thread from this Issue"
                disabled={detail === null || startDisabledReason !== null}
                onClick={() => detail && onStart(detail)}
              />
            }
          >
            <MessageSquarePlusIcon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup>{startDisabledReason ?? "Start a thread from this Issue"}</TooltipPopup>
        </Tooltip>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Open on GitHub"
          render={
            <a
              href={`https://${reference.host}/${reference.repository}/issues/${reference.number}`}
              target="_blank"
              rel="noreferrer"
            />
          }
        >
          <ExternalLinkIcon className="size-4" />
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="Close panel" onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </div>
      {detail === null ? (
        <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          {AsyncResult.isFailure(result) ? (
            <span>{formatEnvironmentQueryError(result.cause)}</span>
          ) : (
            <Spinner aria-label="Loading Issue" />
          )}
        </div>
      ) : (
        <PullRequestMarkdownContext.Provider value={markdownContext}>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 p-4">
              <div className="space-y-1">
                <h2 className="text-base font-semibold">{detail.title}</h2>
                <p className="text-xs text-muted-foreground">
                  {ISSUE_STATE_PRESENTATION[detail.state].label} · opened by{" "}
                  {detail.author ?? "ghost"} {formatRelativeTimeLabel(detail.createdAt)}
                </p>
              </div>
              {detail.body.trim().length > 0 ? (
                <PullRequestMarkdown text={detail.body} cwd={cwd} environmentId={environmentId} />
              ) : (
                <p className="text-sm text-muted-foreground italic">No description.</p>
              )}
              {detail.commentCount > detail.comments.length ? (
                <p className="text-xs text-muted-foreground">
                  {detail.commentCount - detail.comments.length} older comments are on GitHub.
                </p>
              ) : null}
              {detail.comments.map((comment) => (
                <section key={comment.id} className="space-y-1 border-t border-border pt-3">
                  <p className="text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{comment.author ?? "ghost"}</span>{" "}
                    <a href={comment.url} target="_blank" rel="noreferrer">
                      {formatRelativeTimeLabel(comment.createdAt)}
                    </a>
                  </p>
                  <PullRequestMarkdown
                    text={comment.body}
                    cwd={cwd}
                    environmentId={environmentId}
                  />
                </section>
              ))}
              <IssueActions
                environmentId={environmentId}
                reference={reference}
                detail={detail}
                onChanged={onChanged}
              />
            </div>
          </ScrollArea>
        </PullRequestMarkdownContext.Provider>
      )}
    </aside>
  );
}

function IssueActions({
  environmentId,
  reference,
  detail,
  onChanged,
}: {
  environmentId: EnvironmentId;
  reference: IssueRef;
  detail: IssueDetail;
  onChanged: () => void;
}) {
  const [body, setBody] = useState("");
  const [pending, setPending] = useState<"comment" | IssueStateAction | null>(null);
  const postComment = useAtomCommand(issueComment, { reportFailure: false });
  const setState = useAtomCommand(issueSetState, { reportFailure: false });
  const stateActions: ReadonlyArray<IssueStateAction> =
    detail.state === "open"
      ? detail.viewerCanClose
        ? ["close-completed", "close-not-planned"]
        : []
      : detail.viewerCanReopen
        ? ["reopen"]
        : [];

  const comment = async () => {
    if (body.trim().length === 0 || pending !== null) return;
    setPending("comment");
    const result = await postComment({ environmentId, input: { ...reference, body } });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: "Could not post the comment",
        description: formatEnvironmentQueryError(result.cause),
      });
      return;
    }
    setBody("");
    onChanged();
  };

  const changeState = async (action: IssueStateAction) => {
    if (pending !== null) return;
    setPending(action);
    const result = await setState({ environmentId, input: { ...reference, action } });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: action === "reopen" ? "Could not reopen the Issue" : "Could not close the Issue",
        description: formatEnvironmentQueryError(result.cause),
      });
      return;
    }
    onChanged();
  };

  return (
    <div className="space-y-2 border-t border-border pt-3">
      {detail.locked ? (
        <p className="text-xs text-muted-foreground">
          This Issue is locked; GitHub accepts comments only from collaborators.
        </p>
      ) : null}
      <Textarea
        disabled={pending !== null}
        value={body}
        rows={3}
        placeholder="Leave a comment"
        aria-label="Comment on this Issue"
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!event.repeat) void comment();
          }
        }}
      />
      <div className="flex flex-wrap justify-end gap-2">
        {stateActions.map((action) => (
          <Button
            key={action}
            size="xs"
            variant={action === "reopen" ? "outline" : "destructive-outline"}
            disabled={pending !== null}
            onClick={() => void changeState(action)}
          >
            {pending === action
              ? STATE_ACTION_LABELS[action].busy
              : STATE_ACTION_LABELS[action].idle}
          </Button>
        ))}
        <Button
          size="xs"
          variant="outline"
          disabled={body.trim().length === 0 || pending !== null}
          onClick={() => void comment()}
        >
          <SendIcon className="size-3.5" />
          {pending === "comment" ? "Posting..." : "Comment"}
        </Button>
      </div>
    </div>
  );
}
