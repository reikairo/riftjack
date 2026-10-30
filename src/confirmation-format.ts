import { inlineCode, markdownText } from './manager-format.js';

type Detail = { label?: string; value: string; code?: boolean | 'command'; spaced?: boolean };

// Compose both presentations from the same values. Tool input is literal text,
// never Markdown: fences keep even embedded Markdown literal until rendering.
// The confirmation renderer displays command fences as wrapping inline code.
export function confirmationDetails(details: Detail[]): { text: string; markdown: string } {
  const separator = (index: number, formatted: boolean): string => {
    if (!index) return '';
    if (details[index].spaced || details[index - 1].spaced) {
      // An explicit Markdown line break keeps a blank line in Matrix clients
      // that collapse paragraph margins, and in the generated plain fallback.
      return formatted ? '\n\\\n' : '\n\n';
    }
    return formatted ? '\n\n' : '\n';
  };
  return {
    text: details.map(({ label, value }, index) => `${separator(index, false)}${label ? label + ': ' : ''}${value}`).join(''),
    markdown: details.map(({ label, value, code }, index) => {
      const title = separator(index, true) + (label ? `**${markdownText(label)}:**\n` : '');
      if (!code) return title + markdownText(value);
      const fence = '`'.repeat(Math.max(2, ...(value.match(/`+/g) || []).map(run => run.length)) + 1);
      return `${title}\n${fence}${code === 'command' ? 'riftjack-command' : 'text'}\n${value}\n${fence}`;
    }).join(''),
  };
}

export function confirmationPrompt(id: string, request: {
  text: string; markdown?: string; approve?: object; answer?: unknown; answerHint?: string; answerLabel?: string;
}): { text: string; markdown: string } {
  const actions = [
    ...(request.approve !== undefined ? [{ label: '✅ Approve', command: `!approve ${id}` }] : []),
    { label: '❌ Decline', command: `!deny ${id}` },
    ...(request.answer ? [{ label: request.answerLabel || 'Answer', command: `!answer ${id} ${request.answerHint || '<answer>'}` }] : []),
  ];
  const hint = 'React below or send a command. ID optional when only one request is pending.';
  return {
    text: `Confirmation ${id}\n${request.text}\n\n` +
      actions.map(a => `${a.label}: ${a.command}`).join('\n') + '\n' + hint,
    markdown: `### Confirmation ${inlineCode(id)}\n\n${request.markdown ?? markdownText(request.text)}\n\n` +
      actions.map(a => `${a.label}: ${inlineCode(a.command)}`).join('\n') + '\n\n' + hint,
  };
}
