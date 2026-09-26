import {
  type EnvironmentId,
  type IssueKey,
  type ThreadsForIssuesInput,
  gitHubRepositoryOf,
  parseIssueUrl,
} from "@t3tools/contracts";

/** Repositories a bare `#N` is looked up in, per server. */
const MAX_REPOSITORIES = 20;

/** What a palette query names as an Issue: `#N`, `owner/repo#N` or an Issue URL. */
export function parsePaletteIssueReference(query: string): {
  readonly repository: string | null;
  readonly host: string | null;
  readonly number: number;
} | null {
  const trimmed = query.trim();
  const url = parseIssueUrl(trimmed);
  if (url !== null) return url;
  const match = /^(?:([\w.-]+\/[\w.-]+))?#(\d{1,9})$/u.exec(trimmed);
  if (match === null) return null;
  const number = Number(match[2]);
  return number < 1 ? null : { repository: match[1]?.toLowerCase() ?? null, host: null, number };
}

/**
 * One `threadsForIssues` read per server that keeps Issue links, for the Issue the query names:
 * in that repository, or for a bare `#N` in each of the server's GitHub project repositories (at
 * most 20). Empty when the query names no Issue.
 */
export function paletteIssueThreadTargets(
  query: string,
  projects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly repositoryIdentity?:
      | { readonly canonicalKey: string; readonly provider?: string | undefined }
      | null
      | undefined;
  }>,
  linkEnvironments: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly input: ThreadsForIssuesInput }> {
  const reference = parsePaletteIssueReference(query);
  if (reference === null) return [];
  return linkEnvironments.flatMap((environmentId) => {
    const repositories = new Map<string, IssueKey>();
    for (const project of projects) {
      if (project.environmentId !== environmentId) continue;
      const repository = gitHubRepositoryOf(project.repositoryIdentity);
      if (repository === null) continue;
      if (reference.repository !== null && repository.repository !== reference.repository) continue;
      if (reference.host !== null && repository.host !== reference.host) continue;
      const key = `${repository.host}/${repository.repository}`;
      if (!repositories.has(key)) {
        repositories.set(key, { ...repository, number: reference.number });
      }
    }
    // A named repository no project here checks out can still have links on this server.
    if (repositories.size === 0 && reference.repository !== null) {
      repositories.set("named", {
        host: reference.host ?? "github.com",
        repository: reference.repository,
        number: reference.number,
      });
    }
    const issues = [...repositories.values()]
      .slice(0, MAX_REPOSITORIES)
      .map((issue) => ({ ...issue, closingPullRequests: [] }));
    return issues.length === 0 ? [] : [{ environmentId, input: { issues } }];
  });
}
