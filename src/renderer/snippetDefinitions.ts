export interface MarkdownSnippet {
  trigger: string;
  title: string;
  description: string;
  template: string;
  block: boolean;
}

export const snippetCatalog: readonly MarkdownSnippet[] = [
  { trigger: '/h1', title: 'Heading 1', description: 'A large heading.', template: '# ${1:Heading}\n${0}', block: true },
  { trigger: '/h2', title: 'Heading 2', description: 'A section heading.', template: '## ${1:Heading}\n${0}', block: true },
  { trigger: '/task', title: 'Task', description: 'An unchecked task.', template: '- [ ] ${1:Task}\n${0}', block: true },
  { trigger: '/quote', title: 'Quote', description: 'A block quote.', template: '> ${1:Quote}\n${0}', block: true },
  { trigger: '/code', title: 'Code block', description: 'A fenced block with language and code fields.', template: '```${1:language}\n${2:code}\n```\n${0}', block: true },
  { trigger: '/table', title: 'Table', description: 'Two columns with a header and a row.', template: '| ${1:Column 1} | ${2:Column 2} |\n| --- | --- |\n| ${3:Value 1} | ${4:Value 2} |\n${0}', block: true },
  { trigger: '/link', title: 'Link', description: 'A label and web address.', template: '[${1:label}](${2:https://example.com})${0}', block: false },
  { trigger: '/wiki', title: 'Note link', description: 'A link to another note in this notebook.', template: '[[${1:Note name}]]${0}', block: false },
];

