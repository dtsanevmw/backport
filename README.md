Backport is a [JavaScript GitHub Action](https://help.github.com/en/articles/about-actions#javascript-actions) to backport a pull request by simply adding a label to it.

It supports every merge method: [squashed and merged](https://help.github.com/en/github/collaborating-with-issues-and-pull-requests/about-pull-request-merges#squash-and-merge-your-pull-request-commits) pull requests, [rebased and merged](https://help.github.com/en/github/collaborating-with-issues-and-pull-requests/about-pull-request-merges#rebase-and-merge-your-pull-request-commits) pull requests (all their commits are backported) and merge commits.

# Usage

1.  :electric_plug: Add this [.github/workflows/backport.yml](.github/workflows/backport.yml) to your repository.

2.  :speech_balloon: Let's say you want to backport a pull request on a branch named `production`.

    Then label it with `auto-backport-to-production`. (See [how to create labels](https://help.github.com/articles/creating-a-label/).)

3.  :sparkles: That's it! When the pull request gets merged, it will be backported to the `production` branch and a comment linking to the backport pull request will be posted.

If the cherry-pick has conflicts, the conflict markers are committed and the backport pull request is created as a draft, listing the files to fix.
Resolve the conflicts on its branch, then mark it as ready for review.
Set `conflict_resolution: fail` to skip the draft and only get the comment with manual instructions described below.

If the pull request cannot be backported (conflicts with `conflict_resolution: fail`, a missing target branch...):

- a comment explains why and how to backport manually, with a link to create the pull request with its title and body already filled in;
- the `failed-backport-to-production` label is added;
- the workflow run fails.

To retry, remove the `auto-backport-to-production` label and add it again.
The comment is updated in place on every attempt and the `failed-backport-to-production` label is removed once the backport succeeds.

# Inputs

| Input                 | Default                                                              | Description                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conflict_resolution` | `draft`                                                              | `draft` to commit the conflict markers and create the backport pull request as a draft when the cherry-pick has conflicts, `fail` to only comment with manual instructions instead. |
| `github_token`        | required                                                             | Token for the GitHub API. It needs `contents`, `issues` and `pull-requests` write permissions.                                                                                      |
| `label_pattern`       | `^auto-backport-to-(?<base>([^ ]+))$`                                | Labels matching this pattern trigger a backport to the branch captured by the `base` named group. Branch names with shell syntax are rejected.                                      |
| `body_template`       | `Backport <%= mergeCommitSha %> from #<%= number %>.\n\n<%= body %>` | Lodash template for the backport pull request's body. Data: `base`, `body`, `mergeCommitSha`, `number`.                                                                             |
| `head_template`       | `backport-<%= number %>-to-<%= base %>`                              | Lodash template for the backport pull request's head branch. Data: `base`, `number`.                                                                                                |
| `title_template`      | `<%= title %> (backport to <%= base %>)`                             | Lodash template for the backport pull request's title. Data: `base`, `number`, `title`.                                                                                             |

In templates, use `<%= value %>` to insert a value as is.
Don't use `<%- value %>`: it HTML-escapes the value, turning `'` into `&#39;`, which GitHub then renders as a link to issue #39.

# Outputs

| Output                  | Description                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `created_pull_requests` | A JSON stringified object mapping the base branch of the backport pull requests to their number. |
