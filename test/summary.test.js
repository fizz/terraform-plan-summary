'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../src/summary.js');

const mark = s.markers('tf-plan');

function planComment(name, text) {
  return [`<!-- tf-plan: ${name} -->`, `### terraform plan: \`${name}\``, '', '```terraform', text, '```'].join('\n');
}

const CHANGES = `
  # aws_s3_bucket.logs will be created
  + resource "aws_s3_bucket" "logs" {
  # aws_iam_role.app will be updated in-place
  ~ resource "aws_iam_role" "app" {
  # aws_instance.web must be replaced
-/+ resource "aws_instance" "web" {
  # data.aws_iam_policy_document.x will be read during apply
Plan: 2 to add, 1 to change, 1 to destroy.`;

test('parses names, resources and totals', () => {
  const plan = s.parsePlan(planComment('prod', CHANGES), mark.plan);
  assert.equal(plan.name, 'prod');
  assert.equal(plan.status, 'changes');
  assert.deepEqual(plan.counts, { import: 0, add: 2, change: 1, destroy: 1 });
  assert.deepEqual(plan.resources, [
    { address: 'aws_s3_bucket.logs', action: 'create' },
    { address: 'aws_iam_role.app', action: 'update' },
    { address: 'aws_instance.web', action: 'replace' },
  ]);
});

test('ignores comments without the marker', () => {
  assert.equal(s.parsePlan('Plan: 1 to add, 0 to change, 0 to destroy.', mark.plan), null);
});

test('reads no changes, imports, failures and unknown output', () => {
  const none = s.parsePlan(planComment('dev', 'No changes. Your infrastructure matches the configuration.'), mark.plan);
  assert.equal(none.status, 'none');

  const imp = s.parsePlan(planComment('dev', 'Plan: 3 to import, 0 to add, 0 to change, 0 to destroy.'), mark.plan);
  assert.equal(imp.counts.import, 3);
  assert.equal(s.iconFor(imp), s.ICONS.change);

  const failed = s.parsePlan(planComment('dev', '│ Error: Invalid count argument\nPlan: 1 to add, 0 to change, 0 to destroy.'), mark.plan);
  assert.equal(failed.status, 'failed');
  assert.equal(s.iconFor(failed), s.ICONS.failed);

  assert.equal(s.parsePlan(planComment('dev', 'something else'), mark.plan).status, 'unknown');
});

test('module addresses with indexes and keys parse whole', () => {
  const text = '  # module.vpc.aws_subnet.private["a"] will be destroyed\n  # module.x[0].aws_eip.this has moved to module.y.aws_eip.this';
  assert.deepEqual(s.parseResources(text), [
    { address: 'module.vpc.aws_subnet.private["a"]', action: 'destroy' },
    { address: 'module.x[0].aws_eip.this', action: 'move' },
  ]);
});

test('chooses one icon per kind of change', () => {
  const icon = (add, change, destroy) => s.iconFor({ status: 'changes', counts: { import: 0, add, change, destroy } });
  assert.equal(icon(1, 0, 0), s.ICONS.add);
  assert.equal(icon(0, 1, 0), s.ICONS.change);
  assert.equal(icon(0, 0, 1), s.ICONS.destroy);
  assert.equal(icon(1, 1, 0), s.ICONS.mixed);
  assert.equal(s.iconFor({ status: 'none' }), s.ICONS.none);
});

test('renders a sorted table, links each plan and caps resources', () => {
  const plans = [
    { ...s.parsePlan(planComment('prod', CHANGES), mark.plan), url: 'https://x/prod' },
    { ...s.parsePlan(planComment('dev', 'No changes.'), mark.plan), url: 'https://x/dev' },
  ];
  const body = s.renderSummary(plans, { title: 'T', summaryMarker: mark.summary, maxResources: 2 });
  const lines = body.split('\n');
  assert.equal(lines[0], mark.summary);
  assert.equal(lines[1], '### T');
  assert.match(lines[5], /^\| \[dev\]\(https:\/\/x\/dev\) \| ✅ No changes\. \|$/);
  assert.match(lines[6], /^\| \[prod\]/);
  assert.match(lines[6], /<code>aws_s3_bucket\.logs<\/code> <i>create<\/i>/);
  assert.match(lines[6], /… and 1 more in the plan/);
  assert.doesNotMatch(lines[6], /aws_instance\.web/);
});

test('escapes pipes so a cell cannot break the table', () => {
  const body = s.renderSummary([{ name: 'a|b', status: 'unknown', headline: 'x|y', resources: [] }], {
    title: 'T', summaryMarker: mark.summary, maxResources: 5,
  });
  assert.match(body, /a\\\|b/);
  assert.match(body, /x\\\|y/);
});

test('pending keeps the old table and adds one note, however often it runs', () => {
  assert.match(s.renderPending(null, { title: 'T', summaryMarker: mark.summary }), /Plans are running\._$/);

  const table = s.renderSummary([{ name: 'dev', status: 'none', headline: 'No changes.', resources: [] }], {
    title: 'T', summaryMarker: mark.summary, maxResources: 5,
  });
  const once = s.renderPending(table, { title: 'T', summaryMarker: mark.summary });
  const twice = s.renderPending(once, { title: 'T', summaryMarker: mark.summary });
  assert.equal(once, twice);
  assert.match(once, /previous run/);
  assert.match(once, /\| dev \|/);
});

test('adds a backlink once', () => {
  const opts = { backlinkMarker: mark.backlink, title: 'T', url: 'https://x/s' };
  const linked = s.withBacklink('plan', opts);
  assert.match(linked, /\[↩ Back to T\]\(https:\/\/x\/s\)$/);
  assert.equal(s.withBacklink(linked, opts), null);
});

test('points an old backlink at the current summary', () => {
  const linked = s.withBacklink('plan', { backlinkMarker: mark.backlink, title: 'T', url: 'https://x/old' });
  const moved = s.withBacklink(linked, { backlinkMarker: mark.backlink, title: 'T', url: 'https://x/new' });
  assert.equal(moved, 'plan\n\n---\n<!-- tf-plan-backlink -->\n[↩ Back to T](https://x/new)');
});

test('replaces a backlink that puts the marker before the rule', () => {
  const old = 'plan\n<!-- tf-plan-backlink -->\n\n---\n[↩ Back to Plan Summary](https://x/old)';
  const moved = s.withBacklink(old, { backlinkMarker: mark.backlink, title: 'T', url: 'https://x/new' });
  assert.equal(moved, 'plan\n\n---\n<!-- tf-plan-backlink -->\n[↩ Back to T](https://x/new)');
});

test('a custom prefix changes every marker', () => {
  const m = s.markers('infra.plan');
  assert.equal(m.summary, '<!-- infra.plan-summary -->');
  assert.ok(m.plan.test('<!-- infra.plan: dev -->'));
  assert.ok(!m.plan.test('<!-- infraXplan: dev -->'));
});

// A fake of the github-script client: enough of issues.* to run main().
// listComments returns one page, as the API does, so code that skips paginate
// sees only the first per_page comments.
function fakeGithub(comments) {
  const calls = [];
  let nextId = 1000;
  const github = {
    paginate: async (fn, args) => {
      const all = [];
      for (let page = 1; ; page++) {
        const items = await fn({ ...args, page });
        all.push(...items);
        if (items.length < args.per_page) return all;
      }
    },
    rest: {
      issues: {
        listComments: async ({ page = 1, per_page = 30 }) => comments.slice((page - 1) * per_page, page * per_page),
        createComment: async ({ body }) => {
          const c = { id: nextId++, body, html_url: `https://x/c/${nextId}` };
          comments.push(c);
          calls.push(['create', c.id]);
          return { data: c };
        },
        updateComment: async ({ comment_id, body }) => {
          const c = comments.find((x) => x.id === comment_id);
          c.body = body;
          calls.push(['update', comment_id]);
          return { data: c };
        },
        deleteComment: async ({ comment_id }) => {
          const i = comments.findIndex((x) => x.id === comment_id);
          if (i === -1) throw Object.assign(new Error('Not Found'), { status: 404 });
          comments.splice(i, 1);
          calls.push(['delete', comment_id]);
        },
      },
    },
  };
  return { github, calls };
}

const context = { issue: { number: 7 }, repo: { owner: 'o', repo: 'r' } };
const core = { info() {}, setOutput(k, v) { this.out = { ...this.out, [k]: v }; } };

test('main builds one summary, then updates it and does not repeat backlinks', async () => {
  const comments = [
    { id: 1, body: planComment('prod', 'Plan: 1 to add, 0 to change, 0 to destroy.'), html_url: 'https://x/c/1' },
    { id: 2, body: planComment('dev', 'No changes.'), html_url: 'https://x/c/2' },
    { id: 3, body: 'an ordinary review comment', html_url: 'https://x/c/3' },
  ];
  const { github, calls } = fakeGithub(comments);

  await s.main({ github, context, core, inputs: { mode: 'summary' } });
  assert.deepEqual(calls, [['create', 1000], ['update', 1], ['update', 2]]);
  assert.match(comments[0].body, /Back to Terraform plan summary/);

  calls.length = 0;
  comments[1].body = comments[1].body.replace('No changes.', 'Plan: 0 to add, 0 to change, 2 to destroy.');
  await s.main({ github, context, core, inputs: { mode: 'summary' } });
  assert.deepEqual(calls, [['update', 1000]]);
  assert.match(comments.find((c) => c.id === 1000).body, /🗑️/);
});

test('a later comment for the same plan wins', async () => {
  const comments = [
    { id: 1, body: planComment('dev', 'Plan: 1 to add, 0 to change, 0 to destroy.'), html_url: 'u1' },
    { id: 2, body: planComment('dev', 'No changes.'), html_url: 'u2' },
  ];
  const { github } = fakeGithub(comments);
  await s.main({ github, context, core, inputs: { backlinks: 'false' } });
  const summary = comments.find((c) => c.body.includes(mark.summary)).body;
  assert.match(summary, /\[dev\]\(u2\)/);
  assert.doesNotMatch(summary, /u1/);
});

test('main does nothing outside a pull request or without plans', async () => {
  const { github, calls } = fakeGithub([]);
  await s.main({ github, context: { ...context, issue: {} }, core, inputs: {} });
  await s.main({ github, context, core, inputs: {} });
  assert.deepEqual(calls, []);
});

test('main rejects an unknown mode', async () => {
  const { github } = fakeGithub([]);
  await assert.rejects(s.main({ github, context, core, inputs: { mode: 'apply' } }), /mode must be/);
});

const fs = require('fs');
const os = require('os');
const path = require('path');

function planFile(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-'));
  const file = path.join(dir, 'plan.txt');
  fs.writeFileSync(file, text);
  return file;
}

function filler(n, from = 1) {
  return Array.from({ length: n }, (_, i) => ({ id: from + i, body: `review comment ${from + i}`, html_url: `u${from + i}` }));
}

test('a long plan keeps its end and says so at the top', () => {
  const plan = 'START\n' + 'x'.repeat(100) + '\nPlan: 1 to add, 0 to change, 0 to destroy.';
  const body = s.renderPlanComment(plan, { name: 'dev', prefix: 'tf-plan', maxChars: 60 });
  assert.match(body, /^<!-- tf-plan: dev -->\n/);
  assert.match(body, /```terraform\n\.\.\. \(start of the plan truncated\) \.\.\./);
  assert.match(body, /Plan: 1 to add, 0 to change, 0 to destroy\.\n```$/);
  assert.doesNotMatch(body, /START/);
  assert.equal(s.parsePlan(body, mark.plan).status, 'changes');
});

test('a plan that holds a code fence gets a longer fence', () => {
  const body = s.renderPlanComment('a ``` b', { name: 'dev', prefix: 'tf-plan', maxChars: 60000 });
  assert.match(body, /\n````terraform\n/);
  assert.match(body, /\n````$/);
});

test('comment mode posts a plan comment when there is none', async () => {
  const comments = filler(3);
  const { github, calls } = fakeGithub(comments);
  const file = planFile('No changes.');
  await s.main({ github, context, core, inputs: { mode: 'comment', name: 'dev', planFile: file } });
  assert.deepEqual(calls, [['create', 1000]]);
  assert.equal(s.parsePlan(comments[3].body, mark.plan).name, 'dev');
});

test('comment mode finds its comment after the first 100 and updates it', async () => {
  const old = { id: 500, body: s.renderPlanComment('No changes.', { name: 'dev', prefix: 'tf-plan', maxChars: 60000 }), html_url: 'u500' };
  const prod = { id: 501, body: s.renderPlanComment('No changes.', { name: 'prod', prefix: 'tf-plan', maxChars: 60000 }), html_url: 'u501' };
  const comments = [...filler(130), old, prod];
  const { github, calls } = fakeGithub(comments);
  const file = planFile('Plan: 2 to add, 0 to change, 0 to destroy.');
  await s.main({ github, context, core, inputs: { mode: 'comment', name: 'dev', planFile: file } });
  assert.deepEqual(calls, [['update', 500]]);
  assert.match(old.body, /2 to add/);
  assert.match(prod.body, /No changes\./);
  assert.equal(core.out['comment-url'], 'u500');
});

test('comment mode keeps the backlink that the summary added', async () => {
  const comments = filler(2);
  const { github } = fakeGithub(comments);
  const inputs = { mode: 'comment', name: 'dev', planFile: planFile('No changes.') };
  await s.main({ github, context, core, inputs });
  await s.main({ github, context, core, inputs: { mode: 'summary' } });

  const dev = comments.find((c) => s.parsePlan(c.body, mark.plan));
  assert.equal(dev.body.split(mark.backlink).length, 2);

  inputs.planFile = planFile('Plan: 0 to add, 1 to change, 0 to destroy.');
  await s.main({ github, context, core, inputs });
  assert.match(dev.body, /1 to change/);
  assert.equal(dev.body.split(mark.backlink).length, 2);
  assert.match(dev.body, /\[↩ Back to Terraform plan summary\]/);
});

test('summary mode repairs backlinks after the summary comment is posted again', async () => {
  const dev = { id: 1, body: planComment('dev', 'No changes.'), html_url: 'u1' };
  const comments = [dev];
  const { github } = fakeGithub(comments);
  await s.main({ github, context, core, inputs: {} });
  const first = comments.find((c) => c.body.includes(mark.summary));
  comments.splice(comments.indexOf(first), 1);
  await s.main({ github, context, core, inputs: {} });
  const second = comments.find((c) => c.body.includes(mark.summary));
  assert.notEqual(second.html_url, first.html_url);
  assert.ok(dev.body.endsWith(`(${second.html_url})`));
  assert.equal(dev.body.split(mark.backlink).length, 2);
});

test('comment mode uses the heading input on one line', async () => {
  const comments = [];
  const { github } = fakeGithub(comments);
  const inputs = { mode: 'comment', name: 'devops', heading: 'Terraform Plan - Devops EKS\n🏗️', planFile: planFile('No changes.') };
  await s.main({ github, context, core, inputs });
  assert.ok(comments[0].body.includes('\n### Terraform Plan - Devops EKS 🏗️\n'));
  assert.equal(s.parsePlan(comments[0].body, mark.plan).name, 'devops');
});

test('comment mode checks its inputs before any API call', async () => {
  const { github, calls } = fakeGithub([]);
  await assert.rejects(s.main({ github, context, core, inputs: { mode: 'comment', planFile: 'x' } }), /needs a name/);
  await assert.rejects(s.main({ github, context, core, inputs: { mode: 'comment', name: 'a b', planFile: 'x' } }), /needs a name/);
  await assert.rejects(s.main({ github, context, core, inputs: { mode: 'comment', name: 'dev' } }), /needs plan-file/);
  await assert.rejects(
    s.main({ github, context, core, inputs: { mode: 'comment', name: 'dev', planFile: '/no/such/plan.txt' } }),
    /does not exist/,
  );
  assert.deepEqual(calls, []);
});

test('summary mode reads past the first 100 comments', async () => {
  const comments = [...filler(150), { id: 900, body: planComment('dev', 'No changes.'), html_url: 'u900' }];
  const { github } = fakeGithub(comments);
  await s.main({ github, context, core, inputs: { backlinks: 'false' } });
  assert.match(comments.find((c) => c.body.includes(mark.summary)).body, /\[dev\]\(u900\)/);
});

test('pending runs that start together leave one summary comment', async () => {
  const comments = [{ id: 1, body: planComment('dev', 'No changes.'), html_url: 'u1' }];
  const { github, calls } = fakeGithub(comments);
  await Promise.all([1, 2, 3].map(() => s.main({ github, context, core, inputs: { mode: 'pending' } })));
  assert.equal(calls.filter(([op]) => op === 'create').length, 3);
  assert.deepEqual(comments.filter((c) => c.body.includes(mark.summary)).map((c) => c.id), [1000]);
});

test('a summary run removes summary comments left by an earlier race', async () => {
  const comments = [
    { id: 1, body: planComment('dev', 'No changes.'), html_url: 'u1' },
    { id: 2, body: `${mark.summary}\n### Terraform plan summary\n\nold`, html_url: 'u2' },
    { id: 3, body: `${mark.summary}\n### Terraform plan summary\n\nempty`, html_url: 'u3' },
  ];
  const { github } = fakeGithub(comments);
  await s.main({ github, context, core, inputs: { backlinks: 'false' } });
  const summaries = comments.filter((c) => c.body.includes(mark.summary));
  assert.deepEqual(summaries.map((c) => c.id), [2]);
  assert.match(summaries[0].body, /\[dev\]\(u1\)/);
});
