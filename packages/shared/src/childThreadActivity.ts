/**
 * Child-thread activity (toolboxmd/t3code#31): whether a thread's descendant
 * child threads are working now, derived from thread shells alone.
 *
 * Child threads are hidden from the sidebar, so their work would otherwise
 * never reach the parent. Callers pass their own copy of the `sub.<parent>.<suffix>`
 * id parser so this stays free of any one app's identity rules.
 */
export interface ChildThreadActivityShell {
  readonly id: string;
  readonly archivedAt: string | null;
  readonly session: { readonly status: string } | null;
  readonly backgroundLiveness?: "working" | "monitoring" | null | undefined;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
}

export interface ChildThreadActivity {
  /** Descendant child threads working now. */
  readonly workingCount: number;
  /** Any descendant child thread waiting on an approval. */
  readonly hasPendingApprovals: boolean;
}

/**
 * Same "working" as the sidebar's own status: a running or starting session,
 * or a live background fleet after the turn, unless the thread waits on the
 * user or its session failed.
 */
function isThreadShellWorking(shell: ChildThreadActivityShell): boolean {
  if (shell.archivedAt !== null || shell.hasPendingApprovals || shell.hasPendingUserInput) {
    return false;
  }
  const session = shell.session?.status;
  if (session === "running" || session === "starting") return true;
  return session !== "error" && shell.backgroundLiveness === "working";
}

/**
 * Activity per ancestor thread id, counting every live descendant (children
 * of children included). Threads without working or approval-waiting
 * descendants have no entry.
 */
export function childThreadActivityByParent(
  shells: ReadonlyArray<ChildThreadActivityShell>,
  parentThreadIdOf: (threadId: string) => string | null,
): ReadonlyMap<string, ChildThreadActivity> {
  const byParent = new Map<string, { workingCount: number; hasPendingApprovals: boolean }>();
  for (const shell of shells) {
    if (shell.archivedAt !== null) continue;
    const working = isThreadShellWorking(shell);
    if (!working && !shell.hasPendingApprovals) continue;
    // Parent ids are prefixes of child ids, so the walk always terminates.
    for (
      let ancestorId = parentThreadIdOf(shell.id);
      ancestorId !== null;
      ancestorId = parentThreadIdOf(ancestorId)
    ) {
      const entry = byParent.get(ancestorId) ?? { workingCount: 0, hasPendingApprovals: false };
      if (working) entry.workingCount += 1;
      if (shell.hasPendingApprovals) entry.hasPendingApprovals = true;
      byParent.set(ancestorId, entry);
    }
  }
  return byParent;
}
