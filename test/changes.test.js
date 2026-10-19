'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const c = require('../src/changes.js');
const s = require('../src/summary.js');

function update(address, before, after, extra = {}) {
  return { address, type: address.split('.').slice(-2)[0], mode: 'managed', change: { actions: ['update'], before, after, after_unknown: {}, before_sensitive: {}, after_sensitive: {}, ...extra } };
}

const env = (name) => ({ name, value: '', value_from: [{ secret_key_ref: [{ key: name, name: 'auth-handler', optional: false }] }] });

test('an env var added in the middle of the list is one added item, grouped under its list', () => {
  const deployment = (names, image, command) => ({ spec: [{ replicas: '1', template: [{ spec: [{ container: [{ image, command: ['/bin/sh', '-c', command], env: names.map(env) }] }] }] }] });
  const plan = {
    resource_changes: [
      update(
        'module.auth_handler.kubernetes_deployment_v1.service',
        deployment(['A_URL', 'CODE_TIMEOUT', 'REDIS_HOST'], 'repo/auth:old', 'serve'),
        deployment(['A_URL', 'B_FORM_URL', 'CODE_TIMEOUT', 'REDIS_HOST'], 'repo/auth:new', 'gunicorn'),
      ),
    ],
  };
  const [r] = c.planChanges(plan);
  assert.deepEqual(r.changes, [
    { group: 'spec.template.spec.container', key: 'image', before: '"repo/auth:old"', after: '"repo/auth:new"' },
    { group: 'spec.template.spec.container.command', key: null, before: '"serve"', after: '"gunicorn"' },
    {
      group: 'spec.template.spec.container.env',
      key: '["B_FORM_URL"]',
      before: null,
      after: null,
      added: true,
      fields: [
        ['name', '"B_FORM_URL"'],
        ['value_from.secret_key_ref.key', '"B_FORM_URL"'],
        ['value_from.secret_key_ref.name', '"auth-handler"'],
        ['value_from.secret_key_ref.optional', 'false'],
      ],
    },
  ]);
});

test('a policy in jsonencode() compares what it says, by statement Sid', () => {
  const policy = (resources) => JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'SSMRead', Effect: 'Allow', Resource: resources }, { Sid: 'KMSDecrypt', Effect: 'Allow', Resource: '*' }] });
  const plan = { resource_changes: [update('aws_iam_role_policy.read', { policy: policy(['arn:a', 'arn:c']) }, { policy: policy(['arn:a', 'arn:b/ONBOARDING_URL', 'arn:c']) })] };
  assert.deepEqual(c.planChanges(plan)[0].changes, [
    { group: 'policy.Statement["SSMRead"].Resource', key: null, before: null, after: '"arn:b/ONBOARDING_URL"' },
  ]);
});

test('items of a list with no name match on content, and the manifest mirror stays out', () => {
  const data = (keys) => keys.map((k) => ({ remoteRef: { key: `/p/${k}` }, secretKey: k }));
  const manifest = (keys) => ({ spec: { data: data(keys) } });
  const plan = {
    resource_changes: [
      update('kubernetes_manifest.external_secret', { manifest: manifest(['A', 'C']), object: manifest(['A', 'C']) }, { manifest: manifest(['A', 'B', 'C']), object: manifest(['A', 'C', 'X']) }),
    ],
  };
  assert.deepEqual(c.planChanges(plan)[0].changes, [
    { group: 'manifest.spec.data', key: null, before: null, after: null, added: true, fields: [['remoteRef.key', '"/p/B"'], ['secretKey', '"B"']] },
  ]);
});

test('sensitive values never leave the plan, and unknown values say so', () => {
  const plan = {
    resource_changes: [
      update('aws_db_instance.main', { password: 'old-secret', tags: { a: '1' }, arn: 'arn:x' }, { password: 'new-secret', tags: { a: '1' }, arn: null }, {
        before_sensitive: { password: true },
        after_sensitive: { password: true },
        after_unknown: { arn: true },
      }),
    ],
  };
  assert.doesNotMatch(JSON.stringify(c.planChanges(plan)), /secret/);
  assert.deepEqual(c.planChanges(plan)[0].changes, [
    { group: '', key: 'password', before: c.SENSITIVE, after: c.SENSITIVE },
    { group: '', key: 'arn', before: '"arn:x"', after: c.UNKNOWN },
  ]);
});

test('creates list their set attributes, replaces flag the attribute that forces them', () => {
  const plan = {
    resource_changes: [
      { address: 'aws_s3_bucket.logs', mode: 'managed', change: { actions: ['create'], before: null, after: { bucket: 'logs', tags: null }, after_unknown: { id: true } } },
      {
        address: 'aws_instance.web',
        mode: 'managed',
        change: { actions: ['delete', 'create'], before: { ami: 'ami-1' }, after: { ami: 'ami-2' }, after_unknown: {}, replace_paths: [['ami']] },
      },
      { address: 'data.aws_iam_policy_document.x', mode: 'data', change: { actions: ['read'] } },
      { address: 'aws_eip.ip', mode: 'managed', previous_address: 'aws_eip.old', change: { actions: ['no-op'], before: {}, after: {} } },
    ],
  };
  const [bucket, web, eip] = c.planChanges(plan);
  assert.deepEqual(bucket.changes, [
    { group: '', key: 'bucket', before: null, after: '"logs"' },
    { group: '', key: 'id', before: null, after: c.UNKNOWN },
  ]);
  assert.deepEqual(web, { address: 'aws_instance.web', action: 'replace', changes: [{ group: '', key: 'ami', before: '"ami-1"', after: '"ami-2"', forces: true }], total: 1 });
  assert.deepEqual(eip, { address: 'aws_eip.ip', action: 'move', changes: [], total: 0, from: 'aws_eip.old' });
});

test('each change is a card with its type, its name, the new value in front and the old behind', () => {
  const resource = {
    address: 'module.auth_handler.kubernetes_deployment_v1.service',
    action: 'update',
    total: 3,
    changes: [
      { group: 'spec.template.spec.container', key: 'image', before: '"575826221478.dkr.ecr.us-gov-east-1.amazonaws.com/nistapp-auth-handler:866f331b5691320d4af122fe11f58526b093668b"', after: '"575826221478.dkr.ecr.us-gov-east-1.amazonaws.com/nistapp-auth-handler:0e421ef80d18bb5250dbb727acabfcb4ff8cb289"' },
      { group: 'spec.template.spec.container.env', key: '["B_URL"]', before: null, after: null, added: true, fields: [['name', '"B_URL"'], ['value_from.secret_key_ref.key', '"B_URL"']] },
      { group: 'spec', key: 'replicas', before: '"0"', after: '"1"' },
    ],
  };
  const plan = { name: 'p', status: 'changes', headline: 'h', counts: { import: 0, add: 0, change: 1, destroy: 0 }, resources: [resource] };
  const row = s.renderSummary([plan], { title: 'T', summaryMarker: '<!-- tf-plan-summary -->', maxResources: 5 }).split('\n')[5];
  assert.ok(row.includes(
    '<th align="left"><sub>spec.template.spec.container</sub><br>🔧 <b>image</b> <i>changed</i></th></tr><tr><td>' +
      'registry: <code>575826221478.dkr.ecr.us-gov-east-1.amazonaws.com</code><br>repository: <code>nistapp-auth-handler</code><br>tag: <code>0e421ef80d18</code>' +
      '<details><summary>before</summary>registry: <code>575826221478.dkr.ecr.us-gov-east-1.amazonaws.com</code><br>repository: <code>nistapp-auth-handler</code><br>tag: <code>866f331b5691</code></details>',
  ));
  assert.ok(row.includes('<sub>spec.template.spec.container.env</sub><br>🆕 <b>B_URL</b> <i>added</i></th></tr><tr><td>name: <code>B_URL</code><br>value_from.secret_key_ref.key: <code>B_URL</code></td>'));
  assert.ok(row.includes('<sub>spec</sub><br>🔧 <b>replicas</b> <i>changed</i></th></tr><tr><td><code>1</code><details><summary>before</summary><code>0</code></details>'));
});

test('an ARN in a list is a card named for what it points at, with its parts', () => {
  const arn = '"arn:aws-us-gov:ssm:us-gov-east-1:575826221478:parameter/nistagent/govcloud/shared/auth-handler/ONBOARDING_ACTIVATION_FORM_URL"';
  const plan = { name: 'p', status: 'changes', headline: 'h', counts: { import: 0, add: 0, change: 1, destroy: 0 }, resources: [
    { address: 'x.y', action: 'update', total: 2, changes: [
      { group: 'policy.Statement["SSMRead"].Resource', key: null, before: null, after: arn },
      { group: '', key: 'value', before: c.SENSITIVE, after: c.SENSITIVE },
    ] },
  ] };
  const body = s.renderSummary([plan], { title: 'T', summaryMarker: '<!-- tf-plan-summary -->', maxResources: 5 });
  assert.ok(body.includes(
    '<sub>policy.Statement["SSMRead"].Resource</sub><br>🆕 <b>ONBOARDING_ACTIVATION_FORM_URL</b> <i>added</i></th></tr><tr><td>' +
      'service: <code>ssm</code><br>region: <code>us-gov-east-1</code><br>account: <code>575826221478</code><br>type: <code>parameter</code><br>' +
      'path: <code>/nistagent/govcloud/shared/auth-handler</code><br>partition: <code>aws-us-gov</code></td>',
  ));
  assert.ok(body.includes('🔧 <b>value</b> <i>changed</i></th></tr><tr><td><code>(sensitive value changes)</code></td>'));
});

test('comment mode stores the changes, and the summary shows them as cards', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tps-'));
  const planFile = path.join(dir, 'plan.txt');
  const planJson = path.join(dir, 'plan.json');
  fs.writeFileSync(planFile, '  # aws_iam_role.app will be updated in-place\nPlan: 0 to add, 1 to change, 0 to destroy.');
  fs.writeFileSync(planJson, JSON.stringify({ resource_changes: [update('aws_iam_role.app', { name: 'app', max_session_duration: 3600 }, { name: 'app', max_session_duration: 7200 })] }));

  const comments = [];
  const github = {
    paginate: async () => comments,
    rest: {
      issues: {
        listComments: () => {},
        createComment: async ({ body }) => {
          const data = { id: comments.length + 1, body, html_url: `https://x/${comments.length + 1}` };
          comments.push(data);
          return { data };
        },
        updateComment: async ({ comment_id, body }) => {
          const data = comments.find((x) => x.id === comment_id);
          data.body = body;
          return { data };
        },
      },
    },
  };
  const context = { issue: { number: 1 }, repo: { owner: 'o', repo: 'r' } };
  const core = { setOutput: () => {}, info: () => {} };

  await s.main({ github, context, core, inputs: { mode: 'comment', name: 'prod', planFile, planJson } });
  assert.match(comments[0].body, /^<!-- tf-plan: prod -->\n<!-- tf-plan-changes: [A-Za-z0-9+/=]+ -->\n### /);

  await s.main({ github, context, core, inputs: { mode: 'summary' } });
  assert.ok(comments[1].body.includes('🔧 <b>max_session_duration</b> <i>changed</i></th></tr><tr><td><code>7200</code><details><summary>before</summary><code>3600</code></details>'));
});
