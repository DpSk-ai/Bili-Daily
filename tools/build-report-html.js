#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const src = process.argv[2];
const out = process.argv[3];
if (!src || !out) {
  console.error('usage: node build-html.js <source.md> <output.html>');
  process.exit(1);
}

const md = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');

function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;

function joinText(a, b) {
  if (!a) return b;
  if (!b) return a;
  const left = a[a.length - 1];
  const right = b[0];
  if (CJK.test(left) || CJK.test(right)) return a + b;
  return a + ' ' + b;
}

function inline(s) {
  let text = escapeHtml(s);
  const codes = [];
  text = text.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(code);
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  text = text.replace(/\u0000(\d+)\u0000/g, (_, i) => '<code>' + codes[+i] + '</code>');
  return text;
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((c) => c.trim());
}

function isTableSep(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function isBlockStart(line) {
  return (
    /^#{1,6}\s+/.test(line) ||
    /^```/.test(line) ||
    /^>\s?/.test(line) ||
    /^(\s*)([-*]|\d+\.)\s+/.test(line) ||
    /^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)
  );
}

const lines = md.split('\n');
const html = [];
const toc = [];
let i = 0;
let headingIndex = 0;

function renderBlocks(blockLines) {
  // Used for blockquotes: minimal recursion over paragraphs/lists.
  return renderLines(blockLines, true);
}

function renderLines(ls, inQuote) {
  const outArr = [];
  let p = 0;
  while (p < ls.length) {
    const line = ls[p];

    if (/^\s*$/.test(line)) { p++; continue; }

    // fenced code
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1];
      const buf = [];
      p++;
      while (p < ls.length && !/^```\s*$/.test(ls[p])) buf.push(ls[p++]);
      if (p < ls.length) p++;
      outArr.push(
        '<pre class="code"' + (lang ? ' data-lang="' + escapeHtml(lang) + '"' : '') + '><code>' +
        escapeHtml(buf.join('\n')) + '</code></pre>'
      );
      continue;
    }

    // heading
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].trim();
      let id = '';
      if (level === 2 && !inQuote) {
        headingIndex++;
        id = 'sec-' + headingIndex;
        toc.push({ id, text: text.replace(/[*`]/g, '') });
      }
      outArr.push('<h' + level + (id ? ' id="' + id + '"' : '') + '>' + inline(text) + '</h' + level + '>');
      p++;
      continue;
    }

    // hr
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      outArr.push('<hr>');
      p++;
      continue;
    }

    // blockquote
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (p < ls.length && /^>\s?/.test(ls[p])) {
        buf.push(ls[p].replace(/^>\s?/, ''));
        p++;
      }
      outArr.push('<blockquote>' + renderBlocks(buf) + '</blockquote>');
      continue;
    }

    // table
    if (line.includes('|') && p + 1 < ls.length && isTableSep(ls[p + 1])) {
      const header = splitRow(line);
      const align = splitRow(ls[p + 1]).map((c) => {
        const l = c.startsWith(':');
        const r = c.endsWith(':');
        return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
      });
      p += 2;
      const rows = [];
      while (p < ls.length && ls[p].includes('|') && !/^\s*$/.test(ls[p])) {
        rows.push(splitRow(ls[p]));
        p++;
      }
      let t = '<div class="table-wrap"><table><thead><tr>';
      header.forEach((c, idx) => {
        t += '<th' + (align[idx] ? ' class="al-' + align[idx] + '"' : '') + '>' + inline(c) + '</th>';
      });
      t += '</tr></thead><tbody>';
      rows.forEach((r) => {
        t += '<tr>';
        header.forEach((_, idx) => {
          t += '<td' + (align[idx] ? ' class="al-' + align[idx] + '"' : '') + '>' + inline(r[idx] || '') + '</td>';
        });
        t += '</tr>';
      });
      t += '</tbody></table></div>';
      outArr.push(t);
      continue;
    }

    // list
    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2]);
      const tag = ordered ? 'ol' : 'ul';
      const items = [];
      while (p < ls.length) {
        const m = ls[p].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (m) {
          items.push({ text: m[3], indent: m[1].length, ordered: /\d+\./.test(m[2]) });
          p++;
        } else if (/^\s*$/.test(ls[p]) || isBlockStart(ls[p])) {
          break;
        } else {
          if (items.length) items[items.length - 1].text = joinText(items[items.length - 1].text, ls[p].trim());
          p++;
        }
      }
      // flat rendering with indent classes (source uses one level)
      let listHtml = '<' + tag + '>';
      items.forEach((item) => {
        const cls = item.indent >= 2 ? ' class="li-nested"' : '';
        listHtml += '<li' + cls + '>' + inline(item.text) + '</li>';
      });
      listHtml += '</' + tag + '>';
      outArr.push(listHtml);
      continue;
    }

    // paragraph
    const buf = [line.trim()];
    p++;
    while (p < ls.length && !/^\s*$/.test(ls[p]) && !isBlockStart(ls[p]) && !(ls[p].includes('|') && p + 1 < ls.length && isTableSep(ls[p + 1]))) {
      buf.push(ls[p].trim());
      p++;
    }
    const text = buf.reduce((acc, x) => joinText(acc, x), '');
    outArr.push('<p>' + inline(text) + '</p>');
  }
  return outArr.join('\n');
}

const titleMatch = md.match(/^#\s+(.*)$/m);
const title = titleMatch ? titleMatch[1].replace(/[*`]/g, '') : path.basename(src);

// Pull the first H1 out of the body so it can be rendered as the page header.
let removedH1 = false;
for (let n = 0; n < lines.length; n++) {
  if (/^#\s+/.test(lines[n])) {
    lines[n] = '';
    removedH1 = true;
  }
  if (removedH1) break;
}

const body = renderLines(lines, false);

const tocHtml = toc.length
  ? '<nav class="toc"><div class="toc-title">目录</div><ol>' +
    toc.map((t) => '<li><a href="#' + t.id + '">' + escapeHtml(t.text) + '</a></li>').join('') +
    '</ol></nav>'
  : '';

const now = new Date();
const stamp = now.toLocaleString('zh-CN', { hour12: false });

const doc = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --ink: #1f2430;
    --muted: #5b6472;
    --line: #dfe3ea;
    --bg: #f4f6f9;
    --card: #ffffff;
    --accent: #2f5f9e;
    --accent-soft: #eaf1fb;
    --code-bg: #f6f8fa;
    --warn-bg: #fff8e6;
    --warn-border: #e0a800;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    padding: 32px 16px 64px;
    background: var(--bg);
    color: var(--ink);
    font-family: "Segoe UI", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", system-ui, sans-serif;
    font-size: 15.5px;
    line-height: 1.78;
  }
  .page {
    max-width: 980px;
    margin: 0 auto;
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 10px;
    box-shadow: 0 2px 14px rgba(24, 39, 75, 0.07);
    padding: 44px 52px 52px;
  }
  .meta {
    margin: 0 0 26px;
    padding: 10px 14px;
    background: var(--accent-soft);
    border-left: 4px solid var(--accent);
    border-radius: 4px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }
  .meta div + div { margin-top: 2px; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.4; color: #16202e; }
  h1 {
    font-size: 27px;
    margin: 0 0 20px;
    padding-bottom: 14px;
    border-bottom: 2px solid var(--accent);
  }
  h2 {
    font-size: 21px;
    margin: 38px 0 14px;
    padding-left: 12px;
    border-left: 5px solid var(--accent);
  }
  h3 { font-size: 17.5px; margin: 26px 0 10px; color: var(--accent); }
  h4 { font-size: 16px; margin: 20px 0 8px; }
  p { margin: 10px 0; }
  hr { border: 0; border-top: 1px solid var(--line); margin: 30px 0; }
  a { color: var(--accent); text-decoration: none; border-bottom: 1px solid rgba(47, 95, 158, .35); }
  a:hover { border-bottom-color: var(--accent); }
  strong { color: #101826; }
  code {
    font-family: Consolas, "Cascadia Code", "SFMono-Regular", Menlo, monospace;
    font-size: 0.9em;
    background: var(--code-bg);
    border: 1px solid #e3e8ef;
    border-radius: 4px;
    padding: 1px 5px;
    color: #9a3412;
    word-break: break-word;
  }
  pre.code {
    position: relative;
    background: var(--code-bg);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 16px 18px;
    overflow-x: auto;
    line-height: 1.55;
    margin: 16px 0;
  }
  pre.code code {
    background: none;
    border: 0;
    padding: 0;
    color: #24303f;
    font-size: 13.5px;
    white-space: pre;
  }
  pre.code[data-lang]::before {
    content: attr(data-lang);
    position: absolute;
    top: 0;
    right: 0;
    padding: 2px 9px;
    font-size: 11px;
    color: #7b8594;
    background: #eef1f5;
    border-left: 1px solid var(--line);
    border-bottom: 1px solid var(--line);
    border-radius: 0 7px 0 7px;
    text-transform: uppercase;
    letter-spacing: .4px;
  }
  .table-wrap { overflow-x: auto; margin: 16px 0; }
  table { width: 100%; border-collapse: collapse; font-size: 14.5px; }
  th, td {
    border: 1px solid var(--line);
    padding: 8px 12px;
    text-align: left;
    vertical-align: top;
  }
  th { background: #eef2f8; color: #1b2a41; font-weight: 600; white-space: nowrap; }
  tbody tr:nth-child(even) { background: #fafbfd; }
  tbody tr:hover { background: #f2f6fc; }
  .al-center { text-align: center; }
  .al-right { text-align: right; }
  blockquote {
    margin: 16px 0;
    padding: 12px 18px;
    background: var(--warn-bg);
    border-left: 4px solid var(--warn-border);
    border-radius: 4px;
    color: #5c4a17;
  }
  blockquote p { margin: 6px 0; }
  ul, ol { margin: 10px 0; padding-left: 26px; }
  li { margin: 5px 0; }
  li.li-nested { margin-left: 20px; }
  .toc {
    margin: 0 0 34px;
    padding: 16px 22px;
    background: #f8f9fc;
    border: 1px solid var(--line);
    border-radius: 8px;
    font-size: 14px;
  }
  .toc-title { font-weight: 700; margin-bottom: 8px; color: #16202e; letter-spacing: .5px; }
  .toc ol { margin: 0; padding-left: 22px; columns: 2; column-gap: 32px; }
  .toc li { margin: 4px 0; break-inside: avoid; }
  .footer {
    margin-top: 44px;
    padding-top: 16px;
    border-top: 1px solid var(--line);
    color: #8a93a1;
    font-size: 12.5px;
    display: flex;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  @media (max-width: 680px) {
    body { padding: 12px 8px 32px; font-size: 15px; }
    .page { padding: 24px 18px 32px; border-radius: 6px; }
    h1 { font-size: 22px; }
    h2 { font-size: 18.5px; }
    .toc ol { columns: 1; }
  }
  @media print {
    body { background: #fff; padding: 0; font-size: 11.5pt; }
    .page { max-width: none; border: 0; box-shadow: none; padding: 0; }
    .toc { break-inside: avoid; }
    h1, h2, h3 { break-after: avoid; }
    pre.code, table, blockquote, tr { break-inside: avoid; }
    a { color: inherit; border: 0; }
    .footer { color: #777; }
    @page { size: A4; margin: 16mm 14mm; }
  }
</style>
</head>
<body>
<main class="page">
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">
    <div><strong>来源：</strong>${escapeHtml(path.basename(src))}</div>
    <div><strong>生成时间：</strong>${escapeHtml(stamp)}</div>
  </div>
  ${tocHtml}
${body}
  <div class="footer">
    <span>Bili Daily · 开发报告</span>
    <span>${escapeHtml(title)}</span>
  </div>
</main>
</body>
</html>
`;

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, doc, 'utf8');
console.log('wrote ' + out);
console.log('bytes ' + Buffer.byteLength(doc, 'utf8'));
