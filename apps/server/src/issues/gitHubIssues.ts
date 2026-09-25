import type {
  IssueLink,
  IssueListSort,
  IssueListState,
  IssuePullRequest,
  IssueReviewMark,
  IssueState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  qualifierValue,
  searchPhrase,
  SEARCH_REPOSITORY,
} from "../pullRequest/GitHubPullRequestCli.ts";

/** GitHub's ceiling on a search page. */
export const ISSUE_SEARCH_MAX_ROWS = 100;
/** Children read per Issue; `subIssueCount` says when there are more. */
const SUB_ISSUE_PAGE = 50;
/** Newest comments the side panel shows. */
const COMMENT_PAGE = 100;
/** Closing pull requests read per Issue; more than a few is rare. */
const CLOSING_PULL_REQUEST_PAGE = 10;
/** The commit status AgentsMD's independent review posts on a pull request's head. */
export const REVIEW_MARK_CONTEXT = "review/independent";

/**
 * The Issues search, built the way the pull request search is (`searchQuery` in
 * GitHubPullRequestCli): typed text is one quoted phrase and label and milestone values are
 * quoted, so nothing a reader types can widen the search. Null when a repository is not a plain
 * `owner/name`.
 */
export function issueSearchQuery(input: {
  readonly repositories: ReadonlyArray<string>;
  readonly state: IssueListState;
  readonly sort?: IssueListSort | undefined;
  readonly query?: string | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly milestone?: string | undefined;
}): string | null {
  if (input.repositories.length === 0) return null;
  const repositories = input.repositories.map((repository) => repository.trim());
  if (!repositories.every((repository) => SEARCH_REPOSITORY.test(repository))) return null;
  const query = input.query?.trim() ?? "";
  return [
    "is:issue",
    ...(input.state === "open" ? ["is:open"] : []),
    ...(input.state === "closed" ? ["is:closed"] : []),
    ...(query.length === 0 ? [] : [searchPhrase(query)]),
    ...(input.labels ?? []).map((label) => `label:${qualifierValue(label)}`),
    ...(input.milestone === undefined ? [] : [`milestone:${qualifierValue(input.milestone)}`]),
    // Number order is creation order on GitHub; the page sorts the rows it holds exactly.
    input.sort === "created" || input.sort === "number" ? "sort:created-desc" : "sort:updated-desc",
    ...repositories.map((repository) => `repo:${repository}`),
  ].join(" ");
}

const LINK_FIELDS = "number title url state stateReason repository { nameWithOwner }";

/** A commit's review mark and who posted it; trust is decided against the query's viewer. */
export const COMMIT_REVIEW_FIELDS = `oid status { context(name: "${REVIEW_MARK_CONTEXT}") { state creator { login } } }`;

export function issueSearchGraphQlQuery(rows: number): string {
  const first = Math.min(Math.max(Math.trunc(rows), 1), ISSUE_SEARCH_MAX_ROWS);
  return `query($q: String!, $after: String) {
  viewer { login }
  search(query: $q, type: ISSUE, first: ${first}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on Issue {
        ${LINK_FIELDS}
        createdAt
        updatedAt
        author { login }
        labels(first: 20) { nodes { name color } }
        milestone { title }
        comments { totalCount }
        parent { ${LINK_FIELDS} }
        subIssues(first: ${SUB_ISSUE_PAGE}) { totalCount nodes { ${LINK_FIELDS} } }
        issueDependenciesSummary { blockedBy }
        closedByPullRequestsReferences(first: ${CLOSING_PULL_REQUEST_PAGE}, includeClosedPrs: true) {
          nodes {
            number url state isDraft headRefName headRefOid repository { nameWithOwner }
            headRef { target { ... on Commit { ${COMMIT_REVIEW_FIELDS} } } }
          }
        }
      }
    }
  }
}`;
}

/** The number is a validated positive integer written into the document; the rest are variables. */
export function issueDetailGraphQlQuery(number: number): string {
  return `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issue(number: ${Math.trunc(number)}) {
      ${LINK_FIELDS}
      body
      createdAt
      updatedAt
      locked
      viewerCanClose
      viewerCanReopen
      author { login }
      comments(last: ${COMMENT_PAGE}) {
        totalCount
        nodes { id url body createdAt author { login } }
      }
    }
  }
}`;
}

const Actor = Schema.NullOr(Schema.Struct({ login: Schema.String }));

const LinkNode = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  url: Schema.String,
  state: Schema.String,
  stateReason: Schema.NullOr(Schema.String),
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
});
type LinkNode = typeof LinkNode.Type;

// A non-commit target answers `{}`, which this reads as no mark.
const ReviewCommit = Schema.Struct({
  oid: Schema.optional(Schema.String),
  status: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        context: Schema.NullOr(Schema.Struct({ state: Schema.String, creator: Actor })),
      }),
    ),
  ),
});
export type GitHubReviewCommit = typeof ReviewCommit.Type;

const ClosingPullRequestNode = Schema.Struct({
  number: Schema.Number,
  url: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  headRefName: Schema.String,
  headRefOid: Schema.String,
  repository: Schema.Struct({ nameWithOwner: Schema.String }),
  // Null once the branch is deleted; the pull request is then closed or merged anyway.
  headRef: Schema.NullOr(Schema.Struct({ target: Schema.NullOr(ReviewCommit) })),
});
type ClosingPullRequestNode = typeof ClosingPullRequestNode.Type;

const SearchNode = Schema.Struct({
  ...LinkNode.fields,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  author: Actor,
  labels: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ name: Schema.String, color: Schema.String })),
  }),
  milestone: Schema.NullOr(Schema.Struct({ title: Schema.String })),
  comments: Schema.Struct({ totalCount: Schema.Number }),
  parent: Schema.NullOr(LinkNode),
  subIssues: Schema.Struct({ totalCount: Schema.Number, nodes: Schema.Array(LinkNode) }),
  issueDependenciesSummary: Schema.Struct({ blockedBy: Schema.Number }),
  closedByPullRequestsReferences: Schema.Struct({
    nodes: Schema.Array(Schema.NullOr(ClosingPullRequestNode)),
  }),
});
export type GitHubIssueSearchNode = typeof SearchNode.Type;

const IssueSearchJson = Schema.Struct({
  data: Schema.Struct({
    viewer: Schema.Struct({ login: Schema.String }),
    search: Schema.Struct({
      pageInfo: Schema.Struct({
        hasNextPage: Schema.Boolean,
        endCursor: Schema.NullOr(Schema.String),
      }),
      // `is:issue` keeps pull requests out, so every node is an Issue.
      nodes: Schema.Array(SearchNode),
    }),
  }),
});
export type GitHubIssueSearchJson = typeof IssueSearchJson.Type;

export const decodeIssueSearchJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(IssueSearchJson),
);

const DetailNode = Schema.Struct({
  ...LinkNode.fields,
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  locked: Schema.Boolean,
  viewerCanClose: Schema.Boolean,
  viewerCanReopen: Schema.Boolean,
  author: Actor,
  comments: Schema.Struct({
    totalCount: Schema.Number,
    nodes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        url: Schema.String,
        body: Schema.String,
        createdAt: Schema.String,
        author: Actor,
      }),
    ),
  }),
});
export type GitHubIssueDetailNode = typeof DetailNode.Type;

export const decodeIssueDetailJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.NullOr(Schema.Struct({ issue: Schema.NullOr(DetailNode) })),
      }),
    }),
  ),
);

export function issueStateOf(node: Pick<LinkNode, "state" | "stateReason">): IssueState {
  if (node.state === "OPEN") return "open";
  return node.stateReason === "NOT_PLANNED" || node.stateReason === "DUPLICATE"
    ? "not-planned"
    : "done";
}

export function issueLinkOf(host: string, node: LinkNode): IssueLink {
  return {
    host,
    repository: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    state: issueStateOf(node),
  };
}

/**
 * The head commit's review mark, or null when there is none or someone other than `trustedLogin`
 * posted it. GitHub keeps only the newest status per context, so an untrusted status posted
 * after a trusted one hides it until the trusted account posts again.
 */
export function reviewMarkOf(
  commit: GitHubReviewCommit | null | undefined,
  trustedLogin: string,
): IssueReviewMark | null {
  const context = commit?.status?.context ?? null;
  const creator = context?.creator?.login ?? "";
  if (context === null || creator.length === 0) return null;
  if (creator.toLowerCase() !== trustedLogin.trim().toLowerCase()) return null;
  switch (context.state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return null;
  }
}

export function closingPullRequestOf(
  node: ClosingPullRequestNode,
  trustedLogin: string,
): IssuePullRequest {
  // The branch can have moved past the head GitHub last synced; only the head's own mark counts.
  const target = node.headRef?.target ?? null;
  const head = target?.oid === node.headRefOid ? target : null;
  return {
    repository: node.repository.nameWithOwner,
    number: node.number,
    url: node.url,
    state: node.state === "MERGED" ? "merged" : node.state === "OPEN" ? "open" : "closed",
    isDraft: node.isDraft,
    headRefName: node.headRefName,
    headSha: node.headRefOid || null,
    reviewMark: reviewMarkOf(head, trustedLogin),
  };
}
