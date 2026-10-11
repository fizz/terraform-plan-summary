'use strict';

// Each plan job posts one comment that starts with a marker such as
// <!-- tf-plan: prod -->. This file reads those comments and keeps a single
// summary comment on the pull request: one row per plan, an icon for the kind of
// change, the resources it touches, and a link to the full plan.

const ICONS = {
  none: '✅',
  add: '🆕',
  change: '🔧',
  destroy: '🗑️',
  mixed: '⚡',
  failed: '❌',
  unknown: '❔',
};

const PENDING_FIRST = '_⏳ Plans are running._';
const PENDING_STALE = '_⏳ Plans are running. This table is from the previous run._';

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function markers(prefix) {
  return {
    plan: new RegExp(`<!-- ${escapeRegExp(prefix)}: ([^\\s>]+) -->`),
    summary: `<!-- ${prefix}-summary -->`,
    backlink: `<!-- ${prefix}-backlink -->`,
  };
}

// The text after the address in a "# <address> ..." line of plan output. Data
// sources read during apply change nothing, so they return null and stay out of
// the table.
function actionOf(rest) {
  if (rest.includes('must be replaced') || rest.includes('will be replaced')) return 'replace';
  if (rest.includes('will be created')) return 'create';
  if (rest.includes('will be destroyed')) return 'destroy';
  if (rest.includes('will be updated in-place')) return 'update';
  if (rest.startsWith('has moved to ')) return 'move';
  if (rest.includes('will no longer be managed')) return 'forget';
  return null;
}

function parseResources(body) {
  const seen = new Map();
  for (const match of body.matchAll(/^[ \t]*# (\S+) (.+)$/gm)) {
    const [, address, rest] = match;
    const action = actionOf(rest);
    if (action && !seen.has(address)) seen.set(address, action);
  }
  return [...seen].map(([address, action]) => ({ address, action }));
}

const PLAN_LINE =
  /Plan: (?:(\d+) to import, )?(\d+) to add, (\d+) to change, (\d+) to destroy\./;

// Returns null when the comment is not a plan comment.
function parsePlan(body, planMarker) {
  const marker = body.match(planMarker);
  if (!marker) return null;

  const plan = { name: marker[1], resources: parseResources(body) };

  // A plan can print its totals and then fail, so an error wins.
  if (/^[ \t│]*Error: /m.test(body)) {
    return { ...plan, status: 'failed', headline: 'Plan failed' };
  }

  const totals = body.match(PLAN_LINE);
  if (totals) {
    const [, imp, add, change, destroy] = totals;
    return {
      ...plan,
      status: 'changes',
      headline: totals[0],
      counts: { import: Number(imp || 0), add: Number(add), change: Number(change), destroy: Number(destroy) },
    };
  }

  if (body.includes('No changes.')) {
    return { ...plan, status: 'none', headline: 'No changes.' };
  }

  return { ...plan, status: 'unknown', headline: 'See the plan comment' };
}

function iconFor(plan) {
  if (plan.status !== 'changes') return ICONS[plan.status];
  const kinds = ['add', 'change', 'destroy'].filter((kind) => plan.counts[kind] > 0);
  if (kinds.length > 1) return ICONS.mixed;
  if (kinds.length === 1) return ICONS[kinds[0]];
  // Imports alone change state but no infrastructure.
  return plan.counts.import > 0 ? ICONS.change : ICONS.none;
}

function cell(text) {
  return String(text).replace(/\|/g, '\\|');
}

function renderRow(plan, maxResources) {
  const name = plan.url ? `[${cell(plan.name)}](${plan.url})` : cell(plan.name);
  let result = `${iconFor(plan)} ${cell(plan.headline)}`;

  if (plan.status !== 'none' && plan.resources.length > 0) {
    const shown = plan.resources.slice(0, maxResources);
    const lines = shown.map((r) => `&emsp;↳ \`${cell(r.address)}\` (${r.action})`);
    const hidden = plan.resources.length - shown.length;
    if (hidden > 0) lines.push(`&emsp;… and ${hidden} more in the plan`);
    result += '<br>' + lines.join('<br>');
  }

  return `| ${name} | ${result} |`;
}

function renderSummary(plans, { title, summaryMarker, maxResources }) {
  const rows = [...plans]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((plan) => renderRow(plan, maxResources));
  return [summaryMarker, `### ${title}`, '', '| Plan | Result |', '|------|--------|', ...rows].join('\n');
}

// Keeps the previous table visible and says it is out of date. Running it twice
// leaves one note, not two.
function renderPending(existingBody, { title, summaryMarker }) {
  if (!existingBody) return [summaryMarker, `### ${title}`, '', PENDING_FIRST].join('\n');

  const cleared = existingBody
    .split('\n')
    .filter((line) => line !== PENDING_FIRST && line !== PENDING_STALE)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  const heading = `### ${title}`;
  if (!cleared.includes(heading)) return [summaryMarker, heading, '', PENDING_STALE].join('\n');
  return cleared.replace(heading, `${heading}\n\n${PENDING_STALE}`);
}

function withBacklink(body, { backlinkMarker, title, url }) {
  if (body.includes(backlinkMarker)) return null;
  return `${body}\n\n---\n${backlinkMarker}\n[↩ Back to ${title}](${url})`;
}

async function main({ github, context, core, inputs }) {
  const mode = inputs.mode || 'summary';
  if (mode !== 'summary' && mode !== 'pending') {
    throw new Error(`mode must be "summary" or "pending", not "${mode}"`);
  }

  const issueNumber = context.issue && context.issue.number;
  if (!issueNumber) {
    core.info('This run is not for a pull request. There is nothing to summarize.');
    return;
  }

  const title = inputs.title || 'Terraform plan summary';
  const maxResources = Number(inputs.maxResources || 20);
  const mark = markers(inputs.prefix || 'tf-plan');
  const repo = { owner: context.repo.owner, repo: context.repo.repo };

  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  });
  const existing = comments.find((c) => c.body && c.body.includes(mark.summary));

  async function upsert(body) {
    if (existing) {
      const { data } = await github.rest.issues.updateComment({ ...repo, comment_id: existing.id, body });
      return data;
    }
    const { data } = await github.rest.issues.createComment({ ...repo, issue_number: issueNumber, body });
    return data;
  }

  if (mode === 'pending') {
    const data = await upsert(renderPending(existing && existing.body, { title, summaryMarker: mark.summary }));
    core.setOutput('comment-url', data.html_url);
    return;
  }

  // Comments arrive oldest first. A later comment for the same plan wins.
  const byName = new Map();
  for (const comment of comments) {
    const plan = parsePlan(comment.body || '', mark.plan);
    if (plan) byName.set(plan.name, { ...plan, url: comment.html_url, comment });
  }
  const plans = [...byName.values()];

  if (plans.length === 0) {
    core.info(`No comments carry a "<!-- ${inputs.prefix || 'tf-plan'}: <name> -->" marker. Nothing to summarize.`);
    return;
  }

  const summary = await upsert(renderSummary(plans, { title, summaryMarker: mark.summary, maxResources }));
  core.setOutput('comment-url', summary.html_url);

  if (inputs.backlinks === false || inputs.backlinks === 'false') return;
  for (const plan of plans) {
    const body = withBacklink(plan.comment.body, { backlinkMarker: mark.backlink, title, url: summary.html_url });
    if (body) await github.rest.issues.updateComment({ ...repo, comment_id: plan.comment.id, body });
  }
}

module.exports = {
  ICONS,
  markers,
  parsePlan,
  parseResources,
  iconFor,
  renderSummary,
  renderPending,
  withBacklink,
  main,
};
