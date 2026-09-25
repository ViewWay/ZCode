import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BundledTheme, ThemedToken } from "shiki";
import { highlightCode, shouldUseSyntaxHighlighting, type TokenizedCode } from "@/lib/shikiHighlighter.js";
import { cn } from "@/components/lib/utils.js";

const HIGHLIGHT_MAX_CHARS = 256 * 1024;

function useTokenizedCode(
  code: string,
  language: string,
  theme: BundledTheme | undefined,
): TokenizedCode | null {
  const [tokenizedCode, setTokenizedCode] = useState<TokenizedCode | null>(null);

  useEffect(() => {
    setTokenizedCode(null);
    if (!code || code.length > HIGHLIGHT_MAX_CHARS) {
      return;
    }
    let cancelled = false;
    const tokenized = highlightCode(code, language, theme, (result) => {
      if (!cancelled) setTokenizedCode(result);
    });
    if (tokenized) setTokenizedCode(tokenized);
    return () => {
      cancelled = true;
    };
  }, [code, language, theme]);

  return tokenizedCode;
}

function renderTokenLine(tokens: readonly ThemedToken[] | undefined, lineKey: number) {
  const spans = (tokens ?? []).map((token, index) => (
    <span key={`${lineKey}:${index}`} style={token.color ? { color: token.color } : undefined}>
      {token.content}
    </span>
  ));
  // 逐行渲染需显式补换行，保证与 textarea 的行高/行数逐像素一致。
  return (
    <span key={`line:${lineKey}`}>
      {lineKey > 0 ? "\n" : null}
      {spans.length > 0 ? spans : "\u00A0"}
    </span>
  );
}

export interface EditableHighlightedCodeProps {
  value: string;
  onChange: (value: string) => void;
  language: string;
  theme?: BundledTheme;
  fontSizePx: number;
  wrapLongLines?: boolean;
  /** 行号槽开关（对应 codePreviewSettings.showLineNumbers）；wrap 模式下视觉行与逻辑行不对齐，强制隐藏。 */
  showLineNumbers?: boolean;
  onSave: () => void;
  ariaLabel: string;
}

/**
 * 实时可编辑代码表面：Shiki token 高亮层作底，透明 textarea 覆盖其上
 * （文字透明、光标可见），两层共享同一字体度量——输入时语法色彩实时保留，
 * 无需任何模式切换。textarea 是滚动所有者，滚动时同步高亮层与行号槽。
 */
export function EditableHighlightedCode({
  value,
  onChange,
  language,
  theme,
  fontSizePx,
  wrapLongLines = false,
  showLineNumbers = false,
  onSave,
  ariaLabel,
}: EditableHighlightedCodeProps) {
  const highlightRef = useRef<HTMLPreElement | null>(null);
  const gutterRef = useRef<HTMLDivElement | null>(null);
  const [tokenizedCode, setTokenizedCode] = useState<TokenizedCode | null>(null);

  useEffect(() => {
    setTokenizedCode(null);
    if (!value || !shouldUseSyntaxHighlighting(language)) {
      return;
    }
    let cancelled = false;
    const tokenized = highlightCode(value, language, theme, (result) => {
      if (!cancelled) setTokenizedCode(result);
    });
    if (tokenized) setTokenizedCode(tokenized);
    return () => {
      cancelled = true;
    };
  }, [language, theme, value]);

  const lineCount = useMemo(() => value.split("\n").length, [value]);
  const showGutter = showLineNumbers && !wrapLongLines;

  const syncHighlightScroll = useCallback((textarea: HTMLTextAreaElement) => {
    const highlight = highlightRef.current;
    if (highlight) {
      highlight.scrollTop = textarea.scrollTop;
      highlight.scrollLeft = textarea.scrollLeft;
    }
    const gutter = gutterRef.current;
    if (gutter) {
      gutter.scrollTop = textarea.scrollTop;
    }
  }, []);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLTextAreaElement>) => {
      syncHighlightScroll(event.currentTarget);
    },
    [syncHighlightScroll],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        onSave();
      }
    },
    [onSave],
  );

  const sharedTextStyle = {
    fontSize: `${fontSizePx}px`,
    lineHeight: "1.6",
    tabSize: 4,
  } as const;

  const gutterWidthCh = Math.max(2, String(lineCount).length) + 2;

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background">
      {showGutter ? (
        <div
          ref={gutterRef}
          aria-hidden
          className="shrink-0 select-none overflow-hidden border-r border-border/50 bg-surface pb-3 pl-3 pr-2 text-right font-mono whitespace-pre text-foreground-subtle/60"
          style={{ ...sharedTextStyle, width: `${gutterWidthCh}ch` }}
        >
          {Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")}
        </div>
      ) : null}
      <div className="relative h-full min-w-0 flex-1">
        <pre
          ref={highlightRef}
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 m-0 overflow-hidden p-3 font-mono",
            wrapLongLines ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          )}
          style={{ ...sharedTextStyle, color: tokenizedCode?.fg ?? "inherit" }}
        >
          {(tokenizedCode?.tokens ?? []).map((line, index) => renderTokenLine(line, index))}
        </pre>
        <textarea
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onScroll={handleScroll}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          wrap={wrapLongLines ? "soft" : "off"}
          aria-label={ariaLabel}
          className={cn(
            "absolute inset-0 h-full w-full resize-none overflow-auto bg-transparent p-3 font-mono text-transparent caret-foreground outline-none",
            wrapLongLines ? "whitespace-pre-wrap break-words" : "whitespace-pre",
          )}
          style={sharedTextStyle}
        />
      </div>
    </div>
  );
}
