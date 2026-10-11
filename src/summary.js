'use strict';

// Each plan job posts one comment that starts with a marker such as
// <!-- tf-plan: prod -->. This file writes those comments ("comment" mode), and
// keeps a single summary comment on the pull request ("summary" and "pending"
// modes): one row per plan, an icon for the kind of change, the resources it
// touches, and a link to the full plan.

const fs = require('fs');

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

// The backlink block that withBacklink appended, or '' when there is none.
function backlinkOf(body, backlinkMarker) {
  const at = body.indexOf(`\n\n---\n${backlinkMarker}`);
  return at === -1 ? '' : body.slice(at);
}

// A comment holds 65,536 characters. A long plan keeps its end, where the Plan:
// line and any errors are, and says at the top that the start is missing.
function renderPlanComment(plan, { name, prefix, maxChars }) {
  const text = plan.length > maxChars ? `... (start of the plan truncated) ...\n\n${plan.slice(-maxChars)}` : plan;
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return [`<!-- ${prefix}: ${name} -->`, `### Terraform plan: \`${name}\``, '', `${fence}terraform`, text, fence].join('\n');
}

const MODES = ['summary', 'pending', 'comment'];
const NAME = /^[^\s>]+$/;

async function main({ github, context, core, inputs }) {
  const mode = inputs.mode || 'summary';
  if (!MODES.includes(mode)) {
    throw new Error(`mode must be one of ${MODES.map((m) => `"${m}"`).join(', ')}, not "${mode}"`);
  }

  const issueNumber = context.issue && context.issue.number;
  if (!issueNumber) {
    core.info('This run is not for a pull request. There is nothing to do.');
    return;
  }

  const title = inputs.title || 'Terraform plan summary';
  const maxResources = Number(inputs.maxResources || 20);
  const prefix = inputs.prefix || 'tf-plan';
  const mark = markers(prefix);
  const repo = { owner: context.repo.owner, repo: context.repo.repo };

  // Check the inputs before any API call.
  let planBody;
  if (mode === 'comment') {
    if (!inputs.name || !NAME.test(inputs.name)) {
      throw new Error(`"comment" mode needs a name with no spaces or ">", such as "prod". Got "${inputs.name || ''}".`);
    }
    if (!inputs.planFile) throw new Error('"comment" mode needs plan-file.');
    if (!fs.existsSync(inputs.planFile)) throw new Error(`plan-file ${inputs.planFile} does not exist.`);
    planBody = renderPlanComment(fs.readFileSync(inputs.planFile, 'utf8'), {
      name: inputs.name,
      prefix,
      maxChars: Number(inputs.maxPlanChars || 60000),
    });
  }

  // Read every page. With only the first page, a pull request with more than 100
  // comments hides the comment, and each run posts another one.
  const comments = await github.paginate(github.rest.issues.listComments, {
    ...repo,
    issue_number: issueNumber,
    per_page: 100,
  });

  if (mode === 'comment') {
    const own = comments.filter((c) => {
      const m = c.body && c.body.match(mark.plan);
      return m && m[1] === inputs.name;
    });
    // A later comment wins in the summary, so update the latest one.
    const target = own[own.length - 1];
    let data;
    if (target) {
      // Keep the link to the summary. Without it, the link is gone until the next summary run.
      const body = planBody + backlinkOf(target.body, mark.backlink);
      ({ data } = await github.rest.issues.updateComment({ ...repo, comment_id: target.id, body }));
    } else {
      ({ data } = await github.rest.issues.createComment({ ...repo, issue_number: issueNumber, body: planBody }));
    }
    core.setOutput('comment-url', data.html_url);
    return;
  }

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
  renderPlanComment,
  withBacklink,
  main,
};
