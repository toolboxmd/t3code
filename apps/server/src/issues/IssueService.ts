import {
  type IssueCommentInput,
  type IssueDetail,
  type IssueListEntry,
  type IssueListInput,
  type IssueListRepository,
  type IssueListResult,
  IssueOperationError,
  type IssueRef,
  type IssueSetStateInput,
  pullRequestHostOf,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { encodeGraphQlRequestJson } from "../pullRequest/gitHubPullRequestJson.ts";
import { parseRepositorySelector } from "../pullRequest/GitHubPullRequestCli.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubGraphQlBudget from "../sourceControl/githubGraphQlBudget.ts";
import {
  decodeIssueDetailJson,
  decodeIssueSearchJson,
  type GitHubIssueSearchJson,
  ISSUE_SEARCH_MAX_ROWS,
  issueDetailGraphQlQuery,
  issueLinkOf,
  issueSearchGraphQlQuery,
  issueSearchQuery,
  issueStateOf,
} from "./gitHubIssues.ts";

/** Repositories named in one search, as the pull request listing chunks them. */
const REPOSITORY_SEARCH_CHUNK = 100;
const DEFAULT_LIMIT = 50;
const SEARCH_CONCURRENCY = 4;

export class IssueService extends Context.Service<
  IssueService,
  {
    readonly list: (input: IssueListInput) => Effect.Effect<IssueListResult, IssueOperationError>;
    readonly detail: (input: IssueRef) => Effect.Effect<IssueDetail, IssueOperationError>;
    readonly comment: (input: IssueCommentInput) => Effect.Effect<void, IssueOperationError>;
    readonly setState: (input: IssueSetStateInput) => Effect.Effect<void, IssueOperationError>;
  }
>()("t3/issues/IssueService") {}

interface Workspace {
  readonly repositories: ReadonlyArray<IssueListRepository & { readonly cwd: string }>;
  readonly unsupported: ReadonlyArray<{ readonly host: string; readonly repository: string }>;
}

type WorkspaceRepository = Workspace["repositories"][number];

interface Search {
  readonly key: string;
  readonly host: string;
  readonly chunk: ReadonlyArray<WorkspaceRepository>;
}

interface SearchAnswer {
  readonly search: Search;
  readonly rows: GitHubIssueSearchJson | null;
  readonly error: IssueOperationError | null;
}

const failure = (operation: string, cause: unknown, fallback: string) =>
  new IssueOperationError({
    operation,
    detail:
      cause instanceof Error && cause.message.trim().length > 0 ? cause.message.trim() : fallback,
  });

const make = Effect.gen(function* () {
  const github = yield* GitHubCli.GitHubCli;
  const budget = yield* GitHubGraphQlBudget.GitHubGraphQlBudget;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const workspace = projections.getProjectShells().pipe(
    Effect.mapError((cause) =>
      failure("listProjects", cause, "The project list could not be read."),
    ),
    Effect.map((projects): Workspace => {
      const repositories: Array<IssueListRepository & { cwd: string }> = [];
      const unsupported: Array<{ host: string; repository: string }> = [];
      const seen = new Set<string>();
      for (const project of projects) {
        const identity = project.repositoryIdentity;
        const repository = sourceControlRepositorySelector(identity);
        if (!identity || repository === null) continue;
        const host = pullRequestHostOf(identity, identity.provider as SourceControlProviderKind);
        // Worktrees of one repository are separate projects; count and list the repository once.
        const key = `${host} ${repository.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (identity.provider !== "github") {
          unsupported.push({ host, repository });
          continue;
        }
        repositories.push({
          host,
          repository,
          projectId: project.id,
          projectTitle: project.title,
          cwd: project.workspaceRoot,
        });
      }
      return { repositories, unsupported };
    }),
  );

  const graphqlRead = <A>(input: {
    readonly cwd: string;
    readonly host: string;
    readonly operation: string;
    readonly query: string;
    readonly variables: Readonly<Record<string, string>>;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }) =>
    budget.query(input.host, input.query).pipe(
      Effect.flatMap((query) =>
        github.execute({
          cwd: input.cwd,
          rateLimitHost: input.host,
          args: ["api", "graphql", "--hostname", input.host, "--input", "-"],
          // Typed text travels over stdin, never in argv.
          stdin: encodeGraphQlRequestJson({ query, variables: input.variables }),
        }),
      ),
      Effect.tap((result) => budget.observe(input.host, result.stdout)),
      Effect.mapError((cause) => failure(input.operation, cause, "GitHub could not be read.")),
      Effect.flatMap((result) => {
        const decoded = input.decode(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new IssueOperationError({
                operation: input.operation,
                detail: "GitHub answered in an unexpected shape.",
              }),
            );
      }),
    );

  /** Any checkout on the host runs `gh`; every command names its repository itself. */
  const cwdFor = (host: string, operation: string) =>
    workspace.pipe(
      Effect.flatMap(({ repositories }) => {
        const own = repositories.find((candidate) => candidate.host === host.toLowerCase());
        return own === undefined
          ? Effect.fail(
              new IssueOperationError({
                operation,
                detail: `No project on ${host} to read Issues through.`,
              }),
            )
          : Effect.succeed(own.cwd);
      }),
    );

  const list: IssueService["Service"]["list"] = (input) =>
    Effect.gen(function* () {
      const { repositories, unsupported } = yield* workspace;
      const wanted =
        input.repositories === undefined
          ? repositories
          : repositories.filter((repository) =>
              input.repositories!.some(
                (key) =>
                  key.toLowerCase() === `${repository.host} ${repository.repository}`.toLowerCase(),
              ),
            );
      const byHost = new Map<string, Array<WorkspaceRepository>>();
      for (const repository of wanted) {
        const group = byHost.get(repository.host) ?? [];
        group.push(repository);
        byHost.set(repository.host, group);
      }
      const searches = [...byHost].flatMap(([host, group]) => {
        const chunks: Array<Search> = [];
        for (let start = 0; start < group.length; start += REPOSITORY_SEARCH_CHUNK) {
          const chunk = group.slice(start, start + REPOSITORY_SEARCH_CHUNK);
          chunks.push({ key: `${host}#${start / REPOSITORY_SEARCH_CHUNK}`, host, chunk });
        }
        return chunks;
      });
      // A continuation reads only the searches it names.
      const reads =
        input.cursors === undefined
          ? searches
          : searches.filter((search) => input.cursors![search.key] !== undefined);
      const limit = Math.min(input.limit ?? DEFAULT_LIMIT, ISSUE_SEARCH_MAX_ROWS);
      const answers = yield* Effect.forEach(
        reads,
        (search): Effect.Effect<SearchAnswer> => {
          const q = issueSearchQuery({
            repositories: search.chunk.map((repository) => repository.repository),
            state: input.state,
            sort: input.sort,
            query: input.query,
            labels: input.labels,
            milestone: input.milestone,
          });
          if (q === null) return Effect.succeed({ search, rows: null, error: null });
          const after = input.cursors?.[search.key];
          return graphqlRead({
            cwd: search.chunk[0]!.cwd,
            host: search.host,
            operation: "searchIssues",
            query: issueSearchGraphQlQuery(limit),
            variables: after === undefined ? { q } : { q, after },
            decode: decodeIssueSearchJson,
          }).pipe(
            Effect.map((rows) => ({ search, rows, error: null })),
            Effect.catch((error) => Effect.succeed({ search, rows: null, error })),
          );
        },
        { concurrency: SEARCH_CONCURRENCY },
      );
      const entries: Array<IssueListEntry> = [];
      const errors: Array<{ host: string; message: string }> = [];
      const nextCursors: Record<string, string> = {};
      for (const { search, rows, error } of answers) {
        if (error !== null) errors.push({ host: search.host, message: error.detail });
        if (rows === null) continue;
        const page = rows.data.search;
        if (page.pageInfo.hasNextPage && page.pageInfo.endCursor !== null) {
          nextCursors[search.key] = page.pageInfo.endCursor;
        }
        for (const node of page.nodes) {
          const owner = search.chunk.find(
            (repository) =>
              repository.repository.toLowerCase() === node.repository.nameWithOwner.toLowerCase(),
          );
          if (owner === undefined) continue;
          entries.push({
            ...issueLinkOf(search.host, node),
            projectId: owner.projectId,
            projectTitle: owner.projectTitle,
            author: node.author?.login || null,
            labels: node.labels.nodes.filter((label) => label.name.trim().length > 0),
            milestone: node.milestone?.title.trim() || null,
            commentCount: node.comments.totalCount,
            createdAt: node.createdAt,
            updatedAt: node.updatedAt,
            parent: node.parent === null ? null : issueLinkOf(search.host, node.parent),
            subIssues: node.subIssues.nodes.map((child) => issueLinkOf(search.host, child)),
            subIssueCount: node.subIssues.totalCount,
          });
        }
      }
      return {
        repositories: repositories.map(({ cwd: _cwd, ...repository }) => repository),
        unsupported,
        errors,
        entries,
        nextCursors,
      };
    });

  const detail: IssueService["Service"]["detail"] = (input) =>
    Effect.gen(function* () {
      const cwd = yield* cwdFor(input.host, "issueDetail");
      const { owner, name } = parseRepositorySelector(input.repository);
      const answer = yield* graphqlRead({
        cwd,
        host: input.host,
        operation: "issueDetail",
        query: issueDetailGraphQlQuery(input.number),
        variables: { owner, name },
        decode: decodeIssueDetailJson,
      });
      const issue = answer.data.repository?.issue ?? null;
      if (issue === null) {
        return yield* new IssueOperationError({
          operation: "issueDetail",
          detail: `${input.repository}#${input.number} was not found.`,
        });
      }
      return {
        ...issueLinkOf(input.host, issue),
        state: issueStateOf(issue),
        author: issue.author?.login || null,
        body: issue.body,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        comments: issue.comments.nodes.map((comment) => ({
          id: comment.id,
          author: comment.author?.login || null,
          body: comment.body,
          createdAt: comment.createdAt,
          url: comment.url,
        })),
        commentCount: issue.comments.totalCount,
        locked: issue.locked,
        viewerCanClose: issue.viewerCanClose,
        viewerCanReopen: issue.viewerCanReopen,
      };
    });

  const issueCommand = (
    operation: string,
    input: IssueRef,
    args: ReadonlyArray<string>,
    stdin?: string,
  ) =>
    cwdFor(input.host, operation).pipe(
      Effect.flatMap((cwd) =>
        github
          .execute({
            cwd,
            rateLimitHost: input.host,
            // Naming the host keeps an Enterprise repository off a same-named github.com one.
            args: [
              "issue",
              ...args,
              String(input.number),
              "--repo",
              `${input.host}/${input.repository}`,
            ],
            ...(stdin === undefined ? {} : { stdin }),
          })
          .pipe(
            Effect.mapError((cause) =>
              failure(operation, cause, `GitHub refused to ${operation} the Issue.`),
            ),
          ),
      ),
      Effect.asVoid,
    );

  const comment: IssueService["Service"]["comment"] = (input) =>
    input.body.trim().length === 0
      ? Effect.fail(
          new IssueOperationError({ operation: "comment", detail: "The comment is empty." }),
        )
      : // The body travels over stdin: argv is visible in process listings.
        issueCommand("comment", input, ["comment", "--body-file", "-"], input.body);

  const setState: IssueService["Service"]["setState"] = (input) =>
    input.action === "reopen"
      ? issueCommand("reopen", input, ["reopen"])
      : issueCommand("close", input, [
          "close",
          "--reason",
          input.action === "close-completed" ? "completed" : "not planned",
        ]);

  return IssueService.of({ list, detail, comment, setState });
});

export const layer = Layer.effect(IssueService, make);
