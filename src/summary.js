'use strict';

// Each plan job posts one comment that starts with a marker such as
// <!-- tf-plan: prod -->. This file writes those comments ("comment" mode), and
// keeps a single summary comment on the pull request ("summary" and "pending"
// modes): one row per plan, an icon for the kind of change, the resources it
// touches, and a link to the full plan.

const fs = require('fs');
const { planChanges, encode, decode, SENSITIVE } = require('./changes.js');

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
    changes: new RegExp(`<!-- ${escapeRegExp(prefix)}-changes: ([A-Za-z0-9+/=]+) -->`),
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
function parsePlan(body, planMarker, changesMarker) {
  const marker = body.match(planMarker);
  if (!marker) return null;

  // A plan comment written with plan-json carries its changes. Older comments
  // and plans posted without it list addresses only.
  const embedded = changesMarker && body.match(changesMarker);
  const resources = (embedded && decode(embedded[1])) || parseResources(body);
  const plan = { name: marker[1], resources };

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

// Card text sits inside HTML, where markdown does not apply.
function html(text) {
  return cell(String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
}

// Commit SHAs and digests keep their first 12 characters, which is enough to
// tell them apart. Every other part of a value stays, because that is the change.
function trimHashes(value) {
  return value.replace(/\b([0-9a-f]{12})[0-9a-f]{8,}\b/g, '$1');
}

const ACTION_ICONS = {
  create: '🆕',
  update: '🔧',
  replace: '♻️',
  destroy: '🗑️',
  move: '➡️',
  forget: '📤',
};

const code = (text) => `<code>${html(trimHashes(text))}</code>`;

function unquote(value) {
  if (typeof value !== 'string' || !value.startsWith('"')) return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

const ARN = /^arn:([^:]+):([^:]*):([^:]*):([^:]*):(.+)$/;
const IMAGE = /^([a-z0-9.-]+\.[a-z]{2,}(?::\d+)?)\/([a-z0-9._/-]+?)(?::([\w.-]+))?(?:@(sha256:[0-9a-f]+))?$/;

// A value split into the parts a reader looks for, and the name of what it
// points at. Values with no known shape are one part.
function partsOf(raw) {
  const value = unquote(raw);
  if (typeof value !== 'string') return { name: null, parts: [['value', String(raw)]] };

  const arn = value.match(ARN);
  if (arn) {
    const [, partition, service, region, account, resource] = arn;
    const at = Math.max(resource.lastIndexOf('/'), resource.lastIndexOf(':'));
    const name = at === -1 ? resource : resource.slice(at + 1);
    const parts = [['service', service]];
    if (region) parts.push(['region', region]);
    if (account) parts.push(['account', account]);
    if (at !== -1) {
      const head = resource.slice(0, at);
      const split = head.search(/[/:]/);
      parts.push(['type', split === -1 ? head : head.slice(0, split)]);
      if (split !== -1) parts.push(['path', head.slice(split)]);
    }
    if (partition !== 'aws') parts.push(['partition', partition]);
    return { name, parts };
  }

  const image = value.match(IMAGE);
  if (image) {
    const [, registry, repository, tag, digest] = image;
    const parts = [['registry', registry], ['repository', repository]];
    if (tag) parts.push(['tag', tag]);
    if (digest) parts.push(['digest', digest]);
    return { name: repository.split('/').pop(), parts };
  }

  return { name: value, parts: [['value', value]] };
}

function renderParts(parts) {
  if (parts.length === 1 && parts[0][0] === 'value') return code(parts[0][1]);
  return parts.map(([k, v]) => `${html(k)}: ${code(v)}`).join('<br>');
}

function fieldParts(fields) {
  return (fields || []).map(([k, v]) => [k, String(unquote(v))]);
}

// What a card shows: its type (where the value lives), its name, its state, and
// the new value on the front with the old value on the back.
function cardOf(change) {
  const type = change.group || '';
  const idKey = change.key && change.key.startsWith('[') ? String(unquote(change.key.slice(1, -1))) : null;

  if (change.added || change.removed) {
    const fields = fieldParts(change.fields);
    const named = fields.find(([k]) => /(^|\.)(name|secretKey|key|id|Sid)$/.test(k));
    const name = idKey || (named && named[1]) || 'item';
    return { type, name, state: change.added ? 'added' : 'removed', front: fields, back: null };
  }

  if (change.before === SENSITIVE && change.after === SENSITIVE) {
    return { type, name: change.key, state: 'changed', front: [['value', '(sensitive value changes)']], back: null };
  }

  const after = change.after !== null ? partsOf(change.after) : null;
  const before = change.before !== null ? partsOf(change.before) : null;
  // A value added to or removed from a list is named by what it points at.
  const name = idKey || change.key || (after || before).name;
  if (after && before) return { type, name, state: 'changed', front: after.parts, back: before.parts };
  if (after) return { type, name, state: 'added', front: after.parts, back: null };
  return { type, name, state: 'removed', front: before.parts, back: null };
}

const STATE_ICONS = { added: '🆕', removed: '🗑️', changed: '🔧' };

function renderChangeCard(change) {
  const card = cardOf(change);
  const forces = change.forces ? ' <b>forces replacement</b>' : '';
  const type = card.type ? `<sub>${html(card.type)}</sub><br>` : '';
  const head = `${type}${STATE_ICONS[card.state]} <b>${html(trimHashes(String(card.name)))}</b> <i>${card.state}</i>${forces}`;
  let body = renderParts(card.front);
  if (card.back) body += `<details><summary>before</summary>${renderParts(card.back)}</details>`;
  return `<table><tr><th align="left">${head}</th></tr><tr><td>${body}</td></tr></table>`;
}

// A card for one resource, holding a card for each thing in it that changes.
function renderCard(resource, maxChanges) {
  const from = resource.from ? ` from <code>${html(resource.from)}</code>` : '';
  const head = `${ACTION_ICONS[resource.action] || ''} <code>${html(resource.address)}</code> <i>${resource.action}</i>${from}`;
  const changes = (resource.changes || []).slice(0, maxChanges);
  const rows = changes.map((change) => `<tr><td>${renderChangeCard(change)}</td></tr>`);
  const hidden = (resource.total || changes.length) - changes.length;
  if (hidden > 0) rows.push(`<tr><td>… and ${hidden} more in the plan</td></tr>`);
  return `<table><tr><th align="left">${head}</th></tr>${rows.join('')}</table>`;
}

function renderRow(plan, maxResources, maxChanges) {
  const name = plan.url ? `[${cell(plan.name)}](${plan.url})` : cell(plan.name);
  let result = `${iconFor(plan)} ${cell(plan.headline)}`;

  if (plan.status !== 'none' && plan.resources.length > 0) {
    const shown = plan.resources.slice(0, maxResources);
    const cards = shown.map((r) => renderCard(r, maxChanges));
    const hidden = plan.resources.length - shown.length;
    if (hidden > 0) cards.push(`… and ${hidden} more in the plan`);
    result += cards.join('');
  }

  return `| ${name} | ${result} |`;
}

function renderSummary(plans, { title, summaryMarker, maxResources, maxChanges = 20 }) {
  const rows = [...plans]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((plan) => renderRow(plan, maxResources, maxChanges));
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

// Where the backlink block starts, or -1. withBacklink writes the rule before the
// marker. Older comments put the marker first, then the rule and the link.
function backlinkStart(body, backlinkMarker) {
  const block = body.indexOf(`\n\n---\n${backlinkMarker}`);
  if (block !== -1) return block;
  return body.indexOf(`\n${backlinkMarker}`);
}

// Adds the link, or points an old link at the current summary. The summary
// comment can be deleted and posted again, and a link to the old one goes nowhere.
// Returns null when the comment already has this link.
function withBacklink(body, { backlinkMarker, title, url }) {
  const at = backlinkStart(body, backlinkMarker);
  const plan = at === -1 ? body : body.slice(0, at);
  const linked = `${plan}\n\n---\n${backlinkMarker}\n[↩ Back to ${title}](${url})`;
  return linked === body ? null : linked;
}

// The backlink block at the end of a comment, or '' when there is none.
function backlinkOf(body, backlinkMarker) {
  const at = backlinkStart(body, backlinkMarker);
  return at === -1 ? '' : body.slice(at);
}

// A comment holds 65,536 characters. A long plan keeps its end, where the Plan:
// line and any errors are, and says at the top that the start is missing.
function renderPlanComment(plan, { name, prefix, maxChars, heading, changes }) {
  const payload = changes ? `<!-- ${prefix}-changes: ${encode(changes)} -->` : null;
  // The changes share the comment with the plan text, so the text gives up room.
  if (payload) maxChars = Math.max(1000, maxChars - payload.length - 1);
  const text = plan.length > maxChars ? `... (start of the plan truncated) ...\n\n${plan.slice(-maxChars)}` : plan;
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  return [`<!-- ${prefix}: ${name} -->`, ...(payload ? [payload] : []), `### ${heading || `Terraform plan: \`${name}\``}`, '', `${fence}terraform`, text, fence].join('\n');
}

// The changes in a plan-json file, or null when the file cannot give them. With
// null, the summary reads the addresses from the plan text, so a bad file costs
// the cards but not the plan comment.
function readChanges(file, core) {
  const warn = (message) => (core.warning ? core.warning(message) : core.info(message));
  if (!fs.existsSync(file)) {
    warn(`plan-json ${file} does not exist. The summary lists addresses only.`);
    return null;
  }
  let plan;
  try {
    plan = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    warn(`plan-json ${file} is not JSON (${error.message}). The summary lists addresses only.`);
    return null;
  }
  // terraform show -json writes format_version for every plan. Without it, the
  // file is not a plan, such as the {} a workflow writes when the plan failed.
  if (!plan || typeof plan !== 'object' || !plan.format_version) {
    warn(`plan-json ${file} is not the output of terraform show -json. The summary lists addresses only.`);
    return null;
  }
  return planChanges(plan);
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
  const maxChanges = Number(inputs.maxChanges || 20);
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
    const changes = inputs.planJson ? readChanges(inputs.planJson, core) : null;
    planBody = renderPlanComment(fs.readFileSync(inputs.planFile, 'utf8'), {
      name: inputs.name,
      prefix,
      maxChars: Number(inputs.maxPlanChars || 60000),
      // One line, so the heading cannot start the plan text early.
      heading: (inputs.heading || '').replace(/\s+/g, ' ').trim(),
      changes,
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

  const isSummary = (c) => c.body && c.body.includes(mark.summary);
  const existing = comments.find(isSummary);

  // Removes every summary comment but the one kept. A comment that another run
  // removed first is already gone, which is the same result.
  async function removeOthers(summaries, keep) {
    for (const c of summaries) {
      if (c.id === keep.id) continue;
      try {
        await github.rest.issues.deleteComment({ ...repo, comment_id: c.id });
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
  }

  // Jobs that start together can each find no summary and each post one. After
  // a post, the oldest summary comment is the one to keep: every job sees the
  // same oldest comment, so they all keep it and remove the others.
  async function upsert(body) {
    if (existing) {
      await removeOthers(comments.filter(isSummary), existing);
      const { data } = await github.rest.issues.updateComment({ ...repo, comment_id: existing.id, body });
      return data;
    }
    const { data: created } = await github.rest.issues.createComment({ ...repo, issue_number: issueNumber, body });
    const now = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: issueNumber, per_page: 100 });
    const summaries = now.filter(isSummary).sort((a, b) => a.id - b.id);
    const keep = summaries[0] || created;
    await removeOthers(summaries, keep);
    if (keep.id === created.id) return created;
    const { data } = await github.rest.issues.updateComment({ ...repo, comment_id: keep.id, body });
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
    const plan = parsePlan(comment.body || '', mark.plan, mark.changes);
    if (plan) byName.set(plan.name, { ...plan, url: comment.html_url, comment });
  }
  const plans = [...byName.values()];

  if (plans.length === 0) {
    core.info(`No comments carry a "<!-- ${inputs.prefix || 'tf-plan'}: <name> -->" marker. Nothing to summarize.`);
    return;
  }

  const summary = await upsert(renderSummary(plans, { title, summaryMarker: mark.summary, maxResources, maxChanges }));
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
