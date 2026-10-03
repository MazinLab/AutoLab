import { Fragment, type ReactElement, type ReactNode } from "react";

import "./markdown.css";

// A deliberately small markdown renderer. Output is built from React
// elements, so note content can never inject markup or scripts — raw HTML in
// the source is rendered as literal text.

const INLINE_PATTERN =
  /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[[^\]]+\]\((?:https?:\/\/|\/)[^\s)]+\))/;

function parseInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let remaining = text;
  let index = 0;
  while (remaining) {
    const match = INLINE_PATTERN.exec(remaining);
    if (!match || match.index === undefined) {
      nodes.push(remaining);
      break;
    }
    if (match.index > 0) {
      nodes.push(remaining.slice(0, match.index));
    }
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={key}>{parseInline(token.slice(2, -2), key)}</strong>,
      );
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{parseInline(token.slice(1, -1), key)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) {
        nodes.push(
          <a href={link[2]} key={key} rel="noreferrer" target="_blank">
            {parseInline(link[1], key)}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }
    remaining = remaining.slice(match.index + token.length);
    index += 1;
  }
  return nodes;
}

function parseTableRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string | undefined): boolean {
  return (
    line !== undefined && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(line)
  );
}

export function Markdown({ source }: { source: string }): ReactElement {
  const lines = source.replaceAll("\r\n", "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  function nextKey(): number {
    key += 1;
    return key;
  }

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (!line.trim()) {
      i += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").startsWith("```")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      i += 1;
      blocks.push(
        <pre key={nextKey()}>
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${level}` as "h1";
      blocks.push(
        <Tag key={nextKey()}>{parseInline(heading[2], `h${key}`)}</Tag>,
      );
      i += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push(<hr key={nextKey()} />);
      i += 1;
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[i + 1])) {
      const header = parseTableRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? "").includes("|")) {
        rows.push(parseTableRow(lines[i] ?? ""));
        i += 1;
      }
      blocks.push(
        <table key={nextKey()}>
          <thead>
            <tr>
              {header.map((cell, cellIndex) => (
                <th key={cellIndex}>{parseInline(cell, `t${key}-${cellIndex}`)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>
                    {parseInline(cell, `t${key}-${rowIndex}-${cellIndex}`)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i] ?? "")) {
        quoted.push((lines[i] ?? "").replace(/^\s*>\s?/, ""));
        i += 1;
      }
      blocks.push(
        <blockquote key={nextKey()}>
          <Markdown source={quoted.join("\n")} />
        </blockquote>,
      );
      continue;
    }

    const unordered = /^\s*[-*]\s+/.test(line);
    const ordered = /^\s*\d+[.)]\s+/.test(line);
    if (unordered || ordered) {
      const itemPattern = unordered ? /^\s*[-*]\s+/ : /^\s*\d+[.)]\s+/;
      const items: string[] = [];
      while (i < lines.length && itemPattern.test(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(itemPattern, ""));
        i += 1;
      }
      const children = items.map((item, itemIndex) => (
        <li key={itemIndex}>{parseInline(item, `l${key}-${itemIndex}`)}</li>
      ));
      blocks.push(
        unordered ? (
          <ul key={nextKey()}>{children}</ul>
        ) : (
          <ol key={nextKey()}>{children}</ol>
        ),
      );
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && (lines[i] ?? "").trim()) {
      const current = lines[i] ?? "";
      if (
        current.startsWith("```") ||
        /^(#{1,6})\s+/.test(current) ||
        /^\s*[-*]\s+/.test(current) ||
        /^\s*\d+[.)]\s+/.test(current) ||
        /^\s*>\s?/.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      i += 1;
    }
    blocks.push(
      <p key={nextKey()}>
        {paragraph.map((text, lineIndex) => (
          <Fragment key={lineIndex}>
            {lineIndex > 0 ? <br /> : null}
            {parseInline(text, `p${key}-${lineIndex}`)}
          </Fragment>
        ))}
      </p>,
    );
  }

  return <div className="markdown-body">{blocks}</div>;
}
