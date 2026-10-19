'use strict';

// Reads the output of `terraform show -json PLANFILE` and lists, for each
// resource that changes, what changes in it, grouped by the object that holds
// it. The JSON holds every value in clear, so values that Terraform marks
// sensitive are masked here, before anything reaches a comment.
//
// A change is { group, key, before, after, added, removed, fields, forces }:
//   group   the path of the object or list that holds the change ('' for the
//           resource itself), such as "spec.template.spec.container"
//   key     the attribute, or the item of a list such as ["B_URL"], or null for
//           an item of a list that has no name
//   before, after   one-line values, or null when absent
//   fields  for an object added or removed whole: [[path, value], ...]

const SENSITIVE = '(sensitive)';
const UNKNOWN = '(known after apply)';

// Keys that name an item in a list of blocks, such as env { name = ... }. A
// list whose items all have one of these is matched on it. Other lists are
// matched on content, so an item added in the middle reads as one added item and
// not as every later item renamed.
const IDENTITY_KEYS = ['name', 'key', 'id', 'Sid', 'sid', 'container_port', 'port'];

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isEmpty(v) {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0) || (isObject(v) && Object.keys(v).length === 0);
}

function child(tree, key) {
  if (tree === true) return true;
  if (tree !== null && typeof tree === 'object') return tree[key];
  return undefined;
}

function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function segment(key) {
  if (typeof key === 'number') return `[${key}]`;
  if (/^[A-Za-z_][\w-]*$/.test(key)) return key;
  return `[${JSON.stringify(key)}]`;
}

function join(segments) {
  return segments.map((s, i) => (s.startsWith('[') || i === 0 ? s : `.${s}`)).join('');
}

function scalar(value, sensitive) {
  if (sensitive === true) return SENSITIVE;
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value !== 'object') return String(value);
  if (Array.isArray(value) && value.every((x) => x === null || typeof x !== 'object')) return `[${value.map((x) => scalar(x)).join(', ')}]`;
  return '{…}';
}

// The non-empty values inside an object, each with its path in the object.
function fieldsOf(value, sensitive) {
  const fields = [];
  (function walk(v, s, segs) {
    if (s === true) fields.push([join(segs), SENSITIVE]);
    else if (Array.isArray(v) && v.length > 0 && v.every((x) => x === null || typeof x !== 'object')) fields.push([join(segs), scalar(v)]);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, child(s, i), v.length === 1 ? segs : [...segs, segment(i)]));
    else if (isObject(v)) {
      for (const [k, x] of Object.entries(v)) if (!isEmpty(x)) walk(x, child(s, k), [...segs, segment(k)]);
    } else if (!isEmpty(v)) fields.push([join(segs), scalar(v)]);
  })(value, sensitive, []);
  return fields;
}

function parseJsonString(value) {
  if (typeof value !== 'string' || !/^\s*[{[]/.test(value)) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function identityKey(before, after) {
  const items = [...before, ...after];
  if (items.length === 0 || !items.every(isObject)) return null;
  const unique = (list, key) => new Set(list.map((x) => JSON.stringify(x[key]))).size === list.length;
  for (const key of IDENTITY_KEYS) {
    if (items.every((x) => typeof x[key] === 'string' || typeof x[key] === 'number') && unique(before, key) && unique(after, key)) return key;
  }
  return null;
}

// Pairs [i, j] of the longest run of equal items, in order.
function commonItems(before, after) {
  const b = before.map((x) => JSON.stringify(x));
  const a = after.map((x) => JSON.stringify(x));
  const n = b.length;
  const m = a.length;
  const len = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) len[i][j] = b[i] === a[j] ? len[i + 1][j + 1] + 1 : Math.max(len[i + 1][j], len[i][j + 1]);
  }
  const pairs = [];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (b[i] === a[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (len[i + 1][j] >= len[i][j + 1]) i += 1;
    else j += 1;
  }
  return pairs;
}

// Walks before and after together. ctx carries the sensitive and unknown marks
// for the current position, in the same shape as the values. segs is the path
// for display, raw the path as Terraform writes it in replace_paths.
function diff(before, after, ctx, segs, raw, out) {
  const { bs, as, au } = ctx;
  const emit = (change) => out.push({ group: join(segs.slice(0, -1)), key: segs[segs.length - 1] || null, raw, ...change });

  if (au === true) {
    emit({ before: isEmpty(before) ? null : scalar(before, bs), after: UNKNOWN });
    return;
  }
  if (bs === true || as === true) {
    if (!equal(before, after)) emit({ before: isEmpty(before) ? null : SENSITIVE, after: isEmpty(after) ? null : SENSITIVE });
    return;
  }

  // A policy in jsonencode() is a string of JSON. Compare what it says.
  const bJson = parseJsonString(before);
  const aJson = parseJsonString(after);
  if (bJson !== undefined && aJson !== undefined) {
    diff(bJson, aJson, {}, segs, raw, out);
    return;
  }

  if (isObject(before) && isObject(after)) {
    // A value known only after apply can be missing from after altogether.
    const unknown = isObject(au) ? Object.keys(au) : [];
    const keys = [...new Set([...Object.keys(after), ...Object.keys(before), ...unknown])];
    for (const k of keys) {
      diff(before[k], after[k], { bs: child(bs, k), as: child(as, k), au: child(au, k) }, [...segs, segment(k)], [...raw, k], out);
    }
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    diffList(before, after, ctx, segs, raw, out);
    return;
  }

  if (isEmpty(before) && isEmpty(after)) return;
  if (equal(before, after)) return;
  // An object added or removed whole shows what it holds.
  if (isObject(after) && isEmpty(before)) {
    emit({ before: null, after: null, added: true, fields: fieldsOf(after, as) });
  } else if (isObject(before) && isEmpty(after)) {
    emit({ before: null, after: null, removed: true, fields: fieldsOf(before, bs) });
  } else {
    emit({ before: isEmpty(before) ? null : scalar(before, bs), after: isEmpty(after) ? null : scalar(after, as) });
  }
}

function diffList(before, after, { bs, as, au }, segs, raw, out) {
  const group = join(segs);
  const item = (key, change) => out.push({ group, key, before: null, after: null, ...change });

  // Blocks that appear once, such as spec or metadata, keep a path without [0].
  if (before.length <= 1 && after.length <= 1) {
    diff(before[0], after[0], { bs: child(bs, 0), as: child(as, 0), au: child(au, 0) }, segs, [...raw, 0], out);
    return;
  }

  const plain = (l) => l.every((x) => x === null || typeof x !== 'object');
  if (plain(before) && plain(after) && bs !== true && as !== true) {
    const pairs = commonItems(before, after);
    const keptB = new Set(pairs.map(([i]) => i));
    const keptA = new Set(pairs.map(([, j]) => j));
    const removed = before.filter((v, i) => !keptB.has(i)).map((v) => scalar(v));
    const added = after.map((v, j) => (keptA.has(j) ? null : child(au, j) === true ? UNKNOWN : scalar(v))).filter((v) => v !== null);
    // As many values in as out reads as values replaced.
    if (removed.length === added.length) removed.forEach((v, k) => item(null, { raw, before: v, after: added[k] }));
    else {
      removed.forEach((v) => item(null, { raw, before: v }));
      added.forEach((v) => item(null, { raw, after: v }));
    }
    return;
  }

  const key = identityKey(before, after);
  if (key) {
    const at = (l) => new Map(l.map((x, i) => [JSON.stringify(x[key]), i]));
    const bAt = at(before);
    const aAt = at(after);
    for (const [id, i] of bAt) {
      if (!aAt.has(id)) item(`[${id}]`, { raw: [...raw, i], removed: true, fields: fieldsOf(before[i], child(bs, i)) });
    }
    for (const [id, j] of aAt) {
      if (!bAt.has(id)) {
        item(`[${id}]`, { raw: [...raw, j], added: true, fields: fieldsOf(after[j], child(as, j)) });
        continue;
      }
      const i = bAt.get(id);
      diff(before[i], after[j], { bs: child(bs, i), as: child(as, j), au: child(au, j) }, [...segs, `[${id}]`], [...raw, j], out);
    }
    return;
  }

  // No name to match on: items that stay the same pair up, and the rest are
  // added or removed. A changed item reads as one removed and one added.
  const pairs = commonItems(before, after);
  const keptB = new Set(pairs.map(([i]) => i));
  const keptA = new Set(pairs.map(([, j]) => j));
  before.forEach((x, i) => keptB.has(i) || item(null, { raw: [...raw, i], removed: true, fields: fieldsOf(x, child(bs, i)) }));
  after.forEach((x, j) => {
    if (keptA.has(j)) return;
    if (child(au, j) === true) item(null, { raw: [...raw, j], after: UNKNOWN });
    else item(null, { raw: [...raw, j], added: true, fields: fieldsOf(x, child(as, j)) });
  });
}

function actionOf(change, previousAddress) {
  const actions = change.actions || [];
  if (actions.includes('delete') && actions.includes('create')) return 'replace';
  if (actions.includes('create')) return 'create';
  if (actions.includes('delete')) return 'destroy';
  if (actions.includes('update')) return 'update';
  if (actions.includes('forget')) return 'forget';
  if (previousAddress) return 'move';
  return null;
}

function startsWith(raw, prefix) {
  return prefix.length <= raw.length && prefix.every((p, i) => p === raw[i]);
}

const MAX_VALUE = 300;

// Attributes that repeat another attribute of the same resource. kubernetes_manifest
// reads the object back into `object`, so every change to `manifest` shows twice,
// the second time with the defaults the API server fills in.
const MIRRORS = { kubernetes_manifest: ['object'] };

// The resources that change, each with up to maxChanges changes and the total.
function planChanges(plan, { maxChanges = 40 } = {}) {
  const resources = [];
  for (const rc of plan.resource_changes || []) {
    if (rc.mode === 'data') continue;
    const action = actionOf(rc.change || {}, rc.previous_address);
    if (!action) continue;

    const c = rc.change;
    const out = [];
    if (action !== 'destroy' && action !== 'forget' && action !== 'move') {
      const skip = MIRRORS[rc.type] || [];
      const drop = (v) => (isObject(v) ? Object.fromEntries(Object.entries(v).filter(([k]) => !skip.includes(k))) : {});
      const before = drop(c.before);
      const after = drop(c.after);
      diff(before, after, { bs: c.before_sensitive, as: c.after_sensitive, au: c.after_unknown }, [], [], out);
    }
    const replacePaths = c.replace_paths || [];
    const cut = (v) => (typeof v === 'string' && v.length > MAX_VALUE ? `${v.slice(0, MAX_VALUE)}…` : v);
    const changes = out.slice(0, maxChanges).map(({ raw, fields, ...change }) => {
      const entry = { ...change, before: cut(change.before), after: cut(change.after) };
      if (fields) entry.fields = fields.map(([k, v]) => [k, cut(v)]);
      if (replacePaths.some((p) => startsWith(raw || [], p))) entry.forces = true;
      return entry;
    });
    const resource = { address: rc.address, action, changes, total: out.length };
    if (action === 'move') resource.from = rc.previous_address;
    resources.push(resource);
  }
  return resources;
}

// The changes ride in the plan comment as base64 JSON inside an HTML comment, so
// no value can close the comment early.
function encode(resources) {
  return Buffer.from(JSON.stringify(resources), 'utf8').toString('base64');
}

function decode(text) {
  try {
    return JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

module.exports = { planChanges, encode, decode, SENSITIVE, UNKNOWN };
