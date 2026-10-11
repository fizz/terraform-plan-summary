# terraform-plan-summary

One table for every Terraform plan on a pull request.

A pull request that plans three environments gets three long comments, and people read the first one. This action keeps one more comment at the top of the conversation: a row per plan, an icon for the kind of change, the resources it touches, and a link to the full plan. Each plan comment gets a link back to the table.

| Plan | Result |
|------|--------|
| [dev](#) | 🆕 Plan: 65 to add, 0 to change, 0 to destroy.<br>&emsp;↳ `aws_lb.this` (create)<br>&emsp;↳ `aws_ecs_cluster.this` (create)<br>&emsp;… and 63 more in the plan |
| [prod](#) | ✅ No changes. |
| [stage](#) | ⚡ Plan: 1 to add, 1 to change, 0 to destroy.<br>&emsp;↳ `aws_lb_listener.https[0]` (create)<br>&emsp;↳ `aws_lb_listener.http` (update) |

## Usage

Your plan jobs already post their output as a comment. Start each one with a marker that names the plan:

```
<!-- tf-plan: prod -->
```

The rest of the comment is yours. Put the `terraform plan` output in it as text. The action reads the `# address will be created` lines and the `Plan:` line.

Then add two jobs:

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  plan-summary-pending:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: fizz/terraform-plan-summary@v1
        with:
          mode: pending

  dev:
    # ... your plan job, which posts <!-- tf-plan: dev -->
  stage:
    # ...
  prod:
    # ...

  plan-summary:
    needs: [dev, stage, prod]
    if: always() && github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: fizz/terraform-plan-summary@v1
```

`if: always()` is necessary. Without it, one failed plan skips the summary, and the failure is the row people most need to see.

The pending job marks the old table as out of date while the new plans run. It does not empty the table. Leave the job out if you do not want that.

## Icons

| Icon | Meaning |
|---|---|
| ✅ | No changes |
| 🆕 | Adds only |
| 🔧 | Changes only, or imports only |
| 🗑️ | Destroys only |
| ⚡ | More than one kind of change |
| ❌ | The plan printed `Error:` |
| ❔ | The comment has a marker but no plan result |

A plan that prints its totals and then fails shows ❌. The error wins.

## Inputs

| Input | Default | Description |
|---|---|---|
| `mode` | `summary` | `summary` builds the table. `pending` marks it as out of date. |
| `title` | `Terraform plan summary` | Heading of the summary comment. |
| `marker-prefix` | `tf-plan` | Plan comments start with `<!-- PREFIX: NAME -->`. Change it to keep two summaries on one pull request apart. |
| `max-resources` | `20` | Resources listed per plan. The rest become "… and N more in the plan". |
| `backlinks` | `true` | Add a link from each plan comment back to the summary. |
| `github-token` | `github.token` | Needs to read and write pull request comments. |

Output: `comment-url`, the URL of the summary comment.

## Behavior

- Rows sort by plan name.
- If one plan has two comments, the later one wins.
- Each run updates the same summary comment. It finds the comment by `<!-- PREFIX-summary -->`.
- A run that is not for a pull request, or that finds no plan comments, does nothing and does not fail.
- Data sources read during apply are not changes, so they are not listed.

## Development

```
npm test
```

The tests use Node's built-in test runner and need no install.

## License

Apache-2.0
