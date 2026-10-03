import { type ReactElement, useRef, useState } from "react";

import { Markdown } from "./Markdown";

interface MarkdownEditorProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  rows?: number;
}

const TABLE_SNIPPET = [
  "| Column | Column |",
  "| --- | --- |",
  "| value | value |",
  "",
].join("\n");

export function MarkdownEditor({
  id,
  value,
  onChange,
  disabled = false,
  placeholder,
  rows = 10,
}: MarkdownEditorProps): ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  function applyEdit(
    nextValue: string,
    selectionStart: number,
    selectionEnd: number,
  ): void {
    onChange(nextValue);
    const textarea = textareaRef.current;
    if (textarea) {
      requestAnimationFrame(() => {
        textarea.focus();
        textarea.setSelectionRange(selectionStart, selectionEnd);
      });
    }
  }

  function wrapSelection(
    before: string,
    after: string,
    fallback: string,
  ): void {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = value.slice(start, end) || fallback;
    const nextValue =
      value.slice(0, start) + before + selected + after + value.slice(end);
    applyEdit(
      nextValue,
      start + before.length,
      start + before.length + selected.length,
    );
  }

  function prefixSelectedLines(prefix: string, numbered = false): void {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEndIndex = value.indexOf("\n", end);
    const lineEnd = lineEndIndex === -1 ? value.length : lineEndIndex;
    const block = value.slice(lineStart, lineEnd);
    const prefixed = block
      .split("\n")
      .map((line, index) => (numbered ? `${index + 1}. ${line}` : prefix + line))
      .join("\n");
    const nextValue = value.slice(0, lineStart) + prefixed + value.slice(lineEnd);
    applyEdit(nextValue, lineStart, lineStart + prefixed.length);
  }

  function insertBlock(snippet: string): void {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const start = textarea.selectionStart;
    const needsNewline = start > 0 && value[start - 1] !== "\n";
    const inserted = (needsNewline ? "\n" : "") + snippet;
    const nextValue = value.slice(0, start) + inserted + value.slice(start);
    const cursor = start + inserted.length;
    applyEdit(nextValue, cursor, cursor);
  }

  const controlsDisabled = disabled || isPreviewing;
  const tools: { label: string; title: string; run: () => void }[] = [
    { label: "B", title: "Bold", run: () => wrapSelection("**", "**", "bold") },
    { label: "I", title: "Italic", run: () => wrapSelection("*", "*", "italic") },
    {
      label: "</>",
      title: "Inline code",
      run: () => wrapSelection("`", "`", "code"),
    },
    { label: "H2", title: "Heading", run: () => prefixSelectedLines("## ") },
    {
      label: "•",
      title: "Bulleted list",
      run: () => prefixSelectedLines("- "),
    },
    {
      label: "1.",
      title: "Numbered list",
      run: () => prefixSelectedLines("", true),
    },
    { label: "❝", title: "Quote", run: () => prefixSelectedLines("> ") },
    {
      label: "🔗",
      title: "Link",
      run: () => wrapSelection("[", "](https://)", "link text"),
    },
    { label: "⊞", title: "Table", run: () => insertBlock(TABLE_SNIPPET) },
    {
      label: "```",
      title: "Code block",
      run: () => insertBlock("```\ncode\n```\n"),
    },
  ];

  return (
    <div className="markdown-editor">
      <div className="markdown-toolbar" role="toolbar" aria-label="Formatting">
        {tools.map((tool) => (
          <button
            aria-label={tool.title}
            className="markdown-tool"
            disabled={controlsDisabled}
            key={tool.title}
            onClick={tool.run}
            title={tool.title}
            type="button"
          >
            {tool.label}
          </button>
        ))}
        <div className="markdown-toolbar-spacer" />
        <button
          aria-pressed={!isPreviewing}
          className="markdown-tab"
          disabled={disabled}
          onClick={() => setIsPreviewing(false)}
          type="button"
        >
          Write
        </button>
        <button
          aria-pressed={isPreviewing}
          className="markdown-tab"
          disabled={disabled}
          onClick={() => setIsPreviewing(true)}
          type="button"
        >
          Preview
        </button>
      </div>
      {isPreviewing ? (
        <div aria-label="Markdown preview" className="markdown-preview">
          {value.trim() ? (
            <Markdown source={value} />
          ) : (
            <p className="empty-state">Nothing to preview.</p>
          )}
        </div>
      ) : (
        <textarea
          id={id}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          ref={textareaRef}
          rows={rows}
          value={value}
        />
      )}
    </div>
  );
}
