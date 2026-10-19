# terraform-plan-summary

One table for every Terraform plan on a pull request.

A pull request that plans three environments gets three long comments, and people read the first one. This action keeps one more comment at the top of the conversation: a row per plan, an icon for the kind of change, a card for each resource it touches, and a link to the full plan. Each plan comment gets a link back to the table.

| Plan | Result |
|------|--------|
| [dev](#) | 🆕 Plan: 1 to add, 0 to change, 0 to destroy.<table><tr><th align="left">🆕 <code>aws_ssm_parameter.api_url</code> <i>create</i></th></tr><tr><td><table><tr><th align="left">🆕 <b>name</b> <i>added</i></th></tr><tr><td><code>/app/dev/API_URL</code></td></tr></table></td></tr><tr><td><table><tr><th align="left">🆕 <b>type</b> <i>added</i></th></tr><tr><td><code>String</code></td></tr></table></td></tr></table> |
| [prod](#) | ✅ No changes. |
| [stage](#) | 🔧 Plan: 0 to add, 1 to change, 0 to destroy.<table><tr><th align="left">🔧 <code>aws_iam_role_policy.read</code> <i>update</i></th></tr><tr><td><table><tr><th align="left"><sub>policy.Statement["SSMRead"].Resource</sub><br>🆕 <b>API_URL</b> <i>added</i></th></tr><tr><td>service: <code>ssm</code><br>region: <code>us-east-1</code><br>account: <code>123456789012</code><br>type: <code>parameter</code><br>path: <code>/app/stage</code></td></tr></table></td></tr></table> |

## Usage

Each plan job posts its plan as a comment. The action can post it for you:

```yaml
      - run: terraform plan -no-color -out=tfplan 2>&1 | tee plan.txt

      - run: terraform show -json tfplan > plan.json

      - uses: fizz/terraform-plan-summary@v1
        if: github.event_name == 'pull_request'
        with:
          mode: comment
          name: prod
          plan-file: plan.txt
          plan-json: plan.json
```

With `plan-json`, the summary shows each resource as a card that holds a card for each thing in it that changes. A card's type is the path where the value lives, and its name is the value's own name: the attribute, the item's `name` or `key`, or for an ARN the last part of its resource. The front shows the new value, and an ARN or image shows its parts (service, region, account, path; registry, repository, tag, digest). The old value is on the back, under **before**. Lists of blocks match their items on `name`, `key`, `id` or `Sid`, and other lists match on content, so an item inserted in the middle reads as one added item. A policy in `jsonencode()` compares as the policy, not as a string. Values that Terraform marks sensitive show as `(sensitive)`, and the comment holds no other copy of them. Without `plan-json`, the summary lists the resource addresses only.

The comment starts with `<!-- tf-plan: prod -->`. Each run updates that comment and does not post a new one, however many comments the pull request has. A plan longer than `max-plan-chars` keeps its end, where the `Plan:` line and any errors are. The link back to the summary stays when the comment is updated.

You can also post the comment yourself. Start it with the same marker, and put the `terraform plan` output in it as text. The action reads the `# address will be created` lines and the `Plan:` line, and lists addresses only.

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
| `mode` | `summary` | `comment` posts or updates one plan comment. `summary` builds the table. `pending` marks it as out of date. |
| `name` | | `comment` mode: the plan name in the marker and the table, such as `prod`. No spaces. |
| `plan-file` | | `comment` mode: path to the text output of `terraform plan`, from the workspace root. |
| `max-plan-chars` | `60000` | `comment` mode: characters of plan output kept. A comment holds 65,536. |
| `heading` | ``Terraform plan: `NAME` `` | `comment` mode: heading of the plan comment. |
| `title` | `Terraform plan summary` | Heading of the summary comment. |
| `marker-prefix` | `tf-plan` | Plan comments start with `<!-- PREFIX: NAME -->`. Change it to keep two summaries on one pull request apart. |
| `max-resources` | `20` | Resources listed per plan. The rest become "… and N more in the plan". |
| `max-changes` | `10` | Changed attributes shown on each resource card. The rest become "… and N more in the plan". |
| `backlinks` | `true` | Add a link from each plan comment back to the summary. |
| `github-token` | `github.token` | Needs to read and write pull request comments. |

Output: `comment-url`, the URL of the comment that the step wrote.

## Behavior

- Every mode reads all pages of comments, so a pull request with hundreds of comments works the same as a new one.
- Rows sort by plan name.
- When the summary comment is deleted and posted again, the next summary run points each backlink at the new one.
- If one plan has two comments, the later one wins. `comment` mode updates the later one.
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
