import { Marked, type Token } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { Parser } from 'htmlparser2';
import { messageParts } from './bridge.js';

type Content = { msgtype: 'm.text' | 'm.notice'; body: string; format?: 'org.matrix.custom.html'; formatted_body?: string };
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Room tools accept literal text. Escape it and add only the connector-owned
// named mention pills; never interpret agent-provided HTML here.
export function mentionContent(text: string, recipients: { id: string; name: string }[]) {
  return {
    msgtype: 'm.text' as const,
    body: text + '\n\n' + recipients.map(r => r.name).join(' '),
    format: 'org.matrix.custom.html' as const,
    formatted_body: escape(text).replace(/\n/g, '<br>') + '<br><br>' + recipients.map(r =>
      `<a href="https://matrix.to/#/${escape(encodeURI(r.id))}">${escape(r.name)}</a>`).join(' '),
  };
}

// Visible text of inline Markdown: formatting marks are dropped and link targets kept in brackets.
function plainText(tokens: Token[]): string {
  return tokens.map(token => {
    if (token.type === 'br') return ' ';
    if ('tokens' in token && token.tokens?.length) {
      const text = plainText(token.tokens);
      return token.type === 'link' && token.href !== text ? `${text} (${token.href})` : text;
    }
    return 'text' in token ? String(token.text) : '';
  }).join('').replace(/\s+/g, ' ').trim();
}

// Monospace cells occupied by text: wide East Asian characters and emoji take two, combining marks none.
export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (/\p{Mn}|\p{Me}|\u200d|\ufe0f/u.test(char)) continue;
    width += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) || (code >= 0x20000 && code <= 0x3fffd) ? 2 : 1;
  }
  return width;
}

type Align = 'left' | 'right' | 'center';
// Numbers with an optional sign, Unicode currency symbol or short unit, e.g. "$12", "15.1%/h".
// Unit letters and combining marks are independent of the conversation language.
const numeric = (cell: string) => /^[-+−]?\p{Sc}?\s*\p{Nd}[\p{Nd}\s.,]*\s*(?:%|\p{Sc}|(?:\p{L}\p{M}*){1,4}\.?)?(?:\/(?:\p{L}\p{M}*)+)?$/u.test(cell);

// Element X shows <pre> as a scrollable monospace block and drops <table> markup entirely, so tables
// are drawn with box-drawing characters. Headers stay bold: clients keep <strong> inside code blocks.
function boxTable(rows: string[][], aligns: (Align | null)[]): { html: string; text: string } {
  const count = Math.max(...rows.map(row => row.length));
  const cells = rows.map(row => Array.from({ length: count }, (_, i) => row[i] ?? ''));
  const widths = Array.from({ length: count }, (_, i) => Math.max(1, ...cells.map(row => displayWidth(row[i]))));
  // Columns without an explicit alignment are right-aligned when every body cell is a number.
  const align = widths.map((_, i) => aligns[i] ?? (cells.length > 1 && cells.slice(1).every(row => !row[i] || numeric(row[i])) ? 'right' : 'left'));
  const pad = (cell: string, i: number) => {
    const space = widths[i] - displayWidth(cell);
    const before = align[i] === 'right' ? space : align[i] === 'center' ? Math.floor(space / 2) : 0;
    return [' '.repeat(before), cell, ' '.repeat(space - before)];
  };
  const rule = (left: string, middle: string, right: string) => left + widths.map(width => '─'.repeat(width + 2)).join(middle) + right;
  const line = (row: string[], bold: boolean) => {
    const parts = row.map((cell, i) => pad(cell, i));
    return {
      html: '│' + parts.map(([before, cell, after]) => ` ${before}${bold && cell ? `<strong>${escape(cell)}</strong>` : escape(cell)}${after} `).join('│') + '│',
      text: '│' + parts.map(([before, cell, after]) => ` ${before}${cell}${after} `).join('│') + '│',
    };
  };
  const top = rule('┌', '┬', '┐'), middle = rule('├', '┼', '┤'), bottom = rule('└', '┴', '┘');
  const header = line(cells[0], true), body = cells.slice(1).map(row => line(row, false));
  return {
    html: [top, header.html, ...(body.length ? [middle] : []), ...body.map(row => row.html), bottom].join('\n'),
    text: [top, header.text, ...(body.length ? [middle] : []), ...body.map(row => row.text), bottom].join('\n'),
  };
}

const makeMarkdown = (wrapConfirmationValues = false) => new Marked({ gfm: true, breaks: true, renderer: {
  code(token) {
    if (!wrapConfirmationValues || !['riftjack-command', 'riftjack-value'].includes(token.lang ?? '')) return false;
    // Inline code follows the message width instead of opening a scrollable pre.
    // Keep literal source and explicit line breaks; never alter commands, paths or hashes.
    return `<p><code>${escape(token.text).replace(/\n/g, '<br>')}</code></p>\n`;
  },
  table(token) {
    const rows = [token.header, ...token.rows].map(row => row.map(cell => plainText(cell.tokens)));
    return `<pre><code>${boxTable(rows, token.align).html}</code></pre>\n`;
  },
  // Model-produced HTML is displayed literally, never executed or trusted.
  html: ({ text }) => escape(text),
  // Media delivery goes through the encrypted attachment path, not remote HTML images.
  image: ({ href, text }) => `<a href="${escape(href)}">${escape(text || 'Image')}</a>`,
} });

const markdown = makeMarkdown();
const confirmationMarkdown = makeMarkdown(true);

function render(text: string, wrapConfirmationValues: boolean): string {
  return sanitizeHtml((wrapConfirmationValues ? confirmationMarkdown : markdown).parse(text, { async: false }), {
    allowedTags: ['p', 'br', 'strong', 'em', 'del', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'a', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
],
    allowedAttributes: { a: ['href', 'title'], ol: ['start'], code: ['class'] },
    allowedClasses: { code: [/^language-[a-zA-Z0-9_-]+$/] },
    allowedSchemes: ['http', 'https', 'mailto', 'matrix'], allowProtocolRelative: false,
    nestingLimit: 12,
    transformTags: {
      a: (_tag, attrs) => {
        const href = attrs.href || '';
        return { tagName: 'a', attribs: {
          ...(/^(?:https?:|mailto:|matrix:)/i.test(href) && href.length <= 2048 ? { href } : {}),
          ...(attrs.title ? { title: attrs.title.slice(0, 128) } : {}),
        } };
      },
    },
  });
}

// Split rendered HTML, not Markdown source: reopen the enclosing tags in each
// chunk so code fences, emphasis and lists survive Matrix's event-size limit.
function splitHtml(html: string, msgtype: Content['msgtype']): Content[] {
  const parts: Content[] = [];
  const stack: { name: string; open: string; href?: string; label?: string; next?: number }[] = [];
  let formatted = '', body = '', bytes = 0, points = 0, content = false;
  const closeTags = () => stack.map(tag => `</${tag.name}>`).reverse().join('');
  const flush = () => {
    if (!content) return;
    const message: Content = { msgtype, body, format: 'org.matrix.custom.html', formatted_body: formatted + closeTags() };
    // Leave space for Matrix metadata and the overhead of encrypted transport.
    if (Buffer.byteLength(JSON.stringify(message)) <= 36_000) parts.push(message);
    else parts.push(...messageParts(body).map(body => ({ msgtype, body })));
    formatted = stack.map(tag => tag.open).join(''); body = ''; points = 0; content = false;
    bytes = Buffer.byteLength(JSON.stringify(formatted)) + Buffer.byteLength(closeTags());
  };
  const append = (markup: string, plain: string, visible = false, canSplit = true) => {
    const cost = Buffer.byteLength(JSON.stringify(markup)) + Buffer.byteLength(JSON.stringify(plain));
    if (canSplit && content && (points >= 2000 || bytes + cost > 24_000)) flush();
    formatted += markup; body += plain; bytes += cost; points += Array.from(plain).length;
    content ||= visible;
  };
  const newline = () => { if (body && !body.endsWith('\n')) append('', '\n'); };
  const block = /^(p|blockquote|ul|ol|li|pre|h[1-6])$/;
  const parser = new Parser({
    onopentag(name, attrs) {
      if (block.test(name)) newline();
      let prefix = '';
      if (name === 'li') {
        const list = [...stack].reverse().find(tag => tag.name === 'ul' || tag.name === 'ol');
        prefix = list?.name === 'ol' ? `${list.next!++}. ` : '- ';
        if (list?.name === 'ol') list.open = `<ol start="${list.next! - 1}">`;
      }
      const open = `<${name}${Object.entries(attrs).map(([key, value]) => ` ${key}="${escape(value)}"`).join('')}>`;
      append(open, name === 'br' ? '\n' : name === 'hr' ? '\n---\n' : prefix, name === 'br' || name === 'hr');
      if (name !== 'br' && name !== 'hr') stack.push({ name, open, href: attrs.href, label: name === 'a' ? '' : undefined, next: name === 'ol' ? Number(attrs.start || 1) : undefined });
    },
    ontext(text) {
      // Ignore renderer indentation between blocks, but retain code whitespace.
      if (/^\s+$/.test(text) && (!stack.length || /^(ul|ol)$/.test(stack.at(-1)!.name))) return;
      for (const tag of stack) if (tag.label !== undefined) tag.label += text;
      for (const char of text) append(escape(char), char, true);
    },
    onclosetag(name) {
      if (name === 'br' || name === 'hr') return;
      const tag = stack.at(-1);
      if (tag?.name !== name) return;
      append(`</${name}>`, '', false, false); stack.pop();
      if (tag.href && tag.label !== tag.href && !/^https:\/\/matrix\.to\/#\/@[^\s/]+:[^\s/]+$/.test(tag.href)) {
        // Matrix user pills use their name in plain text; other links retain
        // the fallback URL with their visible label. Splitting this suffix
        // alone would create an empty HTML message in formatted clients.
        const suffix = ` (${tag.href})`;
        body += suffix;
        points += Array.from(suffix).length;
        bytes += Buffer.byteLength(JSON.stringify(suffix));
      }
      if (block.test(name)) newline();
    },
  }, { decodeEntities: true });
  parser.end(html); flush();
  return parts;
}

// The m.relates_to of a bot reply. It stays in the thread of the message being answered. An agent's
// matrix-mentions reply_to adds a Matrix reply to that event; inside a thread is_falling_back:false
// marks it as a real reply rather than the thread fallback.
export function replyRelation(thread: { rel_type: string; event_id?: string } | undefined, inReplyTo?: string) {
  if (!inReplyTo) return thread;
  return { ...thread, 'm.in_reply_to': { event_id: inReplyTo }, ...(thread && { is_falling_back: false }) };
}

export function replyContent(text: string, formatted = false, truncate = true, msgtype: Content['msgtype'] = 'm.notice', wrapConfirmationValues = false): Content[] {
  if (!formatted) return messageParts(text).map(body => ({ msgtype, body }));
  const chars = Array.from(text);
  const source = truncate ? chars.slice(0, 100_000).join('') : text;
  let html: string;
  try { html = render(source, wrapConfirmationValues); } catch { html = `<pre><code>${escape(source)}</code></pre>`; }
  const parts = splitHtml(html, msgtype);
  if (truncate && chars.length > 100_000) parts.push({ msgtype, body: '[Response truncated at 100,000 characters.]' });
  return parts;
}
