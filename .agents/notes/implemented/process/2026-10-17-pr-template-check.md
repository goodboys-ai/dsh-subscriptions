# Agent Note: Pull request template check

Status: implemented

## Problem

A pull request can merge with a title that does not name the kind of change
and a description that drops the template. Review then reconstructs the
problem, the verification, and whether any AI tool was used. GitHub also
renders a newline inside a pull request description as a hard line break, so
an 80-column wrap shows as a sentence broken mid-line.

## Decision

`scripts/check-pr-template.mjs` runs in the `repo-checks` job. The title
starts with a topic and a colon. The topics are `feat`, `fix`, `docs`,
`test`, `chore`, `refactor`, `ci`, `build`, and `style`. An optional scope
is lowercase words separated by commas or hyphens, as in `fix(ollama):`,
`fix(auth,tools):`, and `fix(host-e2e):`.

The body uses the headings in `.github/PULL_REQUEST_TEMPLATE.md`, in that
order, and each section has an answer. `Related issue` is `None` or an
issue link. The verification bullets and the AI disclosure fields keep the
template's labels, with the answer on that same line. A prose paragraph is
one line. Lists, tables, and fenced code may span lines.

The script reads `pull_request.title` and `pull_request.body` from the
GitHub event file. An event with no pull request skips the title and body
checks after the template file has parsed. Exit 1 is a finding. Exit 2
means the check did not run. `--title` and `--body-file` check a
description locally. The check requires the sections to be present and
shaped as the template says. It does not judge whether the thinking path
states a real trade-off.

## Alternatives considered

**Accept any token before the colon.** `Update:` and `WIP:` would pass, and
the title would stop naming the kind of change already used on pull
requests in this repository.

**Reject scoped titles.** `fix(ollama):` and `chore(release):` are existing
titles. Requiring a bare `topic:` would fail that shape.

**Look up an open pull request on every push.** The `pull_request` event
already carries the title and body, and Actions runs that event for the
same commit. An API lookup needs a token and fails closed when the token
cannot see a fork's pull request.

## Consequences

A push that is not a pull request does not judge a title or a body. A
broken template file still fails that push, because the script parses the
template before it skips. A description wrapped at 80 columns fails even
when every section is present. A title that does not start with a topic,
such as the 0.2.1 support pull request, would not pass this check.
