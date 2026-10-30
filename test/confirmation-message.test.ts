import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sendConfirmation } from '../src/confirmation-message.js';
import { Interactions, type ReactionControls } from '../src/interactions.js';
import { codexInteraction } from '../src/codex-interactions.js';
import { claudeInteraction } from '../src/claude-interactions.js';
import type { Interaction } from '../src/interactions.js';
import { confirmationDetails } from '../src/confirmation-format.js';
import { replyContent } from '../src/message-format.js';

async function deliver(request: Interaction) {
  const interactions = new Interactions();
  const parts: ReturnType<typeof replyContent> = [];
  const result = interactions.ask(request, new AbortController().signal,
    (text, controls, markdown) => sendConfirmation(text, controls, {
      authorize: async () => {},
      sendMessage: async content => {
        assert.equal(content.msgtype, 'm.text');
        assert.equal(interactions.hasReactionTarget('$' + parts.length), false);
        parts.push(content);
        return '$' + parts.length;
      },
      sendReaction: async (id, key) => {
        assert.equal(id, '$' + parts.length);
        assert.match(interactions.react(id, key)!, /Answer sent|Declined/);
      },
      report: error => { throw error; },
    }, markdown));
  await result;
  return { parts, html: parts.map(p => p.formatted_body).join(''), plain: parts.map(p => p.body).join('') };
}

test('command approvals render literal input, headings and compact controls in Matrix HTML', async () => {
  const command = "echo '<script>hello</script> & **text**'\n```\n[link](https://example.com)\n```";
  const cwd = '/work/<folder> & `path`';
  const reason = 'Read **literal** text <img src=x> &amp;';
  for (const request of [
    codexInteraction({ id: 1, method: 'item/commandExecution/requestApproval', params: { command, cwd, reason } })!,
    claudeInteraction({ subtype: 'can_use_tool', tool_name: 'Bash', decision_reason: reason, input: { command, description: reason, cwd } })!,
  ]) {
    const { html, plain, parts } = await deliver(request);
    assert.ok(parts.every(p => p.format === 'org.matrix.custom.html'));
    assert.match(html, /<h3>Confirmation <code>[a-f0-9]{12}<\/code><\/h3>/);
    assert.match(html, /<strong>Command:<\/strong>/);
    assert.match(html, /<p><code>echo/);
    assert.doesNotMatch(html, /<pre>/);
    assert.doesNotMatch(html, /<script>|<img|<a |<strong>text|<strong>literal/);
    assert.ok(plain.includes(command));
    assert.ok(plain.includes(cwd));
    assert.ok(plain.includes(reason));
    assert.ok(request.text.includes(`\n\nReason: ${reason}\n\n`));
    assert.ok(plain.includes(`\n\nReason:\n${reason}\n\nCommand:`));
    assert.match(html, /<br><br><strong>Reason:<\/strong>/);
    assert.match(html, /<br><br><strong>Command:<\/strong>/);
    assert.match(html, /<code>!approve [a-f0-9]{12}<\/code>/);
    assert.match(plain, /This request only; no permanent rule/);
    const footer = plain.slice(plain.indexOf('✅ Approve:'));
    assert.ok(footer.length < 230);
    assert.match(footer, /ID optional when only one request is pending/);
  }
});

test('expanded escaping never truncates a long confirmation and binds reactions to its final chunk', async () => {
  const text = '<&>'.repeat(12_000) + '\nEND OF REQUEST';
  const { plain, parts } = await deliver({ text, approve: {}, deny: {} });
  assert.ok(parts.length > 1);
  assert.ok(plain.includes(text));
  assert.doesNotMatch(plain, /truncated/);
  for (const part of parts) assert.ok(Buffer.byteLength(JSON.stringify(part)) <= 36_000);
  assert.match(parts.at(-1)!.body, /!approve [a-f0-9]{12}/);
});

test('forms show an answer command and decline without offering a bare approval', async () => {
  const { html, plain } = await deliver({
    text: 'Enter <value> & **literal**', deny: {}, answer: text => ({ text }), answerHint: '{"field":"value"}',
  });
  assert.match(html, /<code>!answer [a-f0-9]{12} \{&quot;field&quot;:&quot;value&quot;\}<\/code>/);
  assert.match(plain, /❌ Decline: !deny/);
  assert.doesNotMatch(plain, /!approve|✅/);
  assert.ok(plain.includes('Enter <value> & **literal**'));
});

test('controls bind only after the full description and commands are delivered', async () => {
  const events: string[] = [];
  let target = '';
  const controls: ReactionControls = { keys: ['✅', '❌'], isPending: () => true, bind: id => { target = id; events.push('bind'); } };
  await sendConfirmation('a'.repeat(6001), controls, {
    authorize: async () => {},
    sendMessage: async content => { assert.equal(target, ''); events.push(content.body); return '$' + events.length; },
    sendReaction: async (id, key) => { assert.equal(id, '$3'); events.push(key); },
    report: error => { throw error; },
  });
  assert.deepEqual(events.map(x => x.length > 10 ? x.length : x), [3000, 3000, 'a', 'bind', '✅', '❌']);
});

test('partial text delivery failure leaves no reaction binding or actionable request', async () => {
  const interactions = new Interactions();
  let sent = 0, reactions = 0;
  await assert.rejects(interactions.ask({ text: 'a'.repeat(6000), approve: {}, deny: {} }, new AbortController().signal,
    (text, controls, markdown) => sendConfirmation(text, controls, {
      authorize: async () => {}, sendMessage: async () => { if (++sent === 2) throw new Error('offline'); return '$part'; },
      sendReaction: async () => { reactions++; }, report: error => { throw error; },
    }, markdown)), /offline/);
  assert.equal(reactions, 0);
  assert.equal(interactions.size, 0);
  assert.equal(interactions.react('$part', '✅'), undefined);
});

test('seed failures retain manual controls; an answer during seeding stops further seeds', async () => {
  const interactions = new Interactions();
  const reports: unknown[] = [], keys: string[] = [];
  const result = await interactions.ask({ text: 'Ready?', approve: { ok: true }, deny: {} }, new AbortController().signal,
    (text, controls, markdown) => sendConfirmation(text, controls, {
      authorize: async () => {}, sendMessage: async () => '$request',
      sendReaction: async (_id, key) => {
        keys.push(key);
        assert.match(interactions.react('$request', '✅')!, /Answer sent/);
        throw new Error('seed failed');
      }, report: error => reports.push(error),
    }, markdown));
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(keys, ['✅']);
  assert.equal(reports.length, 1);
});

test('withdrawal during delivery cannot bind a stale confirmation', async () => {
  const interactions = new Interactions(), controller = new AbortController();
  await assert.rejects(interactions.ask({ text: 'Ready?', approve: {}, deny: {} }, controller.signal,
    (text, controls, markdown) => sendConfirmation(text, controls, {
      authorize: async () => {}, sendMessage: async () => { controller.abort(); return '$late'; },
      sendReaction: async () => assert.fail('Must not seed'), report: error => { throw error; },
    }, markdown)));
  assert.equal(interactions.hasReactionTarget('$late'), false);
});

test('commands and form answers cannot resolve a request while any description chunk is undelivered', async () => {
  for (const form of [false, true]) {
    const interactions = new Interactions();
    let sent = 0;
    let validationCalls = 0;
    const request = { text: 'a'.repeat(6000) + '\nFINAL DETAILS', deny: { denied: true },
      ...(form ? { answer: (text: string) => { validationCalls++; return { text }; } } : { approve: { approved: true } }) };
    const result = await interactions.ask(request, new AbortController().signal, (text, controls, markdown) => {
      const id = /^Confirmation (\w+)/.exec(text)![1];
      return sendConfirmation(text, controls, {
        authorize: async () => {},
        sendMessage: async () => {
          sent++;
          for (const command of ['!approve', `!approve ${id}`, '!deny', `!deny ${id}`, '!answer yes', `!answer ${id} yes`]) {
            assert.match(interactions.answer(command), /still being delivered/);
          }
          assert.equal(validationCalls, 0);
          assert.equal(controls.isPending(), true);
          return '$' + sent;
        },
        sendReaction: async () => {
          assert.ok(sent > 1);
          assert.match(interactions.answer(form ? '!answer yes' : '!approve'), /Answer sent/);
        },
        report: error => { throw error; },
      }, markdown);
    });
    assert.deepEqual(result, form ? { text: 'yes' } : { approved: true });
    assert.equal(validationCalls, form ? 1 : 0);
  }
});

test('an early approval followed by delivery failure never approves the action', async () => {
  const interactions = new Interactions();
  let sent = 0;
  await assert.rejects(interactions.ask({ text: 'a'.repeat(6000), approve: { approved: true }, deny: {} }, new AbortController().signal,
    (text, controls, markdown) => sendConfirmation(text, controls, {
      authorize: async () => {},
      sendMessage: async () => {
        if (++sent === 2) throw new Error('offline');
        assert.match(interactions.answer('!approve'), /still being delivered/);
        return '$first';
      },
      sendReaction: async () => assert.fail('Incomplete request'), report: error => { throw error; },
    }, markdown)), /offline/);
  assert.equal(interactions.size, 0);
});

test('wrapped commands preserve long arguments, blank lines and whitespace across message chunks', async () => {
  const command = "python3 - <<'PY'\n\n    print('  " + '界<&`'.repeat(1800) + "  ')\n\nPY\n";
  const request = claudeInteraction({ subtype: 'can_use_tool', tool_name: 'Bash', input: { command } })!;
  const { html, plain, parts } = await deliver(request);
  assert.ok(parts.length > 1);
  assert.doesNotMatch(html, /<pre>|<script>|<a /);
  assert.match(html, /<code>/);
  assert.match(html, /<br><br>/);
  assert.ok(plain.includes(command));
  assert.deepEqual(request.approve, { behavior: 'allow', updatedInput: { command } });
  for (const part of parts) assert.ok(Buffer.byteLength(JSON.stringify(part)) <= 36_000);
});

test('all literal confirmation fields wrap; ordinary replies retain code blocks', async () => {
  const command = 'echo "a  b"\n\n  echo done';
  const details = confirmationDetails([
    { label: 'Command', value: command, code: 'command' },
    { label: 'Changes', value: '- old\n+ new', code: true },
  ]);
  const { html, plain } = await deliver({ ...details, approve: {}, deny: {} });
  assert.match(html, /<p><code>echo &quot;a  b&quot;<br><br>  echo done<\/code><\/p>/);
  assert.match(html, /<p><code>- old<br>\+ new<\/code><\/p>/);
  assert.doesNotMatch(html, /<pre>/);
  assert.ok(plain.includes(command));
  const ordinary = replyContent(details.markdown, true, false).map(p => p.formatted_body).join('');
  assert.match(ordinary, /<pre><code class="language-riftjack-command">/);
});


test('publication paths, destinations and complete hashes remain literal without scrollable blocks', async () => {
  const values = [
    ['Working directory', '/projects/' + 'long-directory/'.repeat(30) + '<workspace>&`'],
    ['Repository', '/projects/' + 'repository/'.repeat(30)],
    ['Destination', 'git@example.com:team/project.git refs/heads/' + 'branch-'.repeat(40)],
    ['Publish HEAD', '0123456789abcdef'.repeat(3)],
    ['Report SHA-256', 'abcdef0123456789'.repeat(4)],
    ['Permissions', '{"paths":["<literal>&`"],"network":false}'],
  ];
  const details = confirmationDetails(values.map(([label, value]) => ({ label, value, code: true })));
  const { html, plain } = await deliver({ ...details, approve: { exact: values }, deny: {} });
  assert.doesNotMatch(html, /<pre>|<literal>|<workspace>/);
  for (const [, value] of values) assert.ok(plain.includes(value));
  assert.match(html, /&lt;workspace&gt;&amp;`/);
});
