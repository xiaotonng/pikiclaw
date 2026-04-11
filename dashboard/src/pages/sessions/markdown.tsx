import { useState } from 'react';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { cn } from '../../utils';
import { api } from '../../api';

export const mdPlugins = [remarkGfm, remarkBreaks];

const isWebUrl = (href: string) => /^https?:\/\//.test(href);
const isFilePath = (href: string) => /^(\/|~\/|\.\.?\/)/.test(href);

/* ── Copy button for fenced code blocks ── */
export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => { navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); }).catch(() => {}); };
  return (
    <button onClick={copy} className="flex items-center text-fg-5/50 hover:text-fg-3 transition-colors">
      {copied
        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#34d399" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
        : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
      }
    </button>
  );
}

export function classifyCode(text: string): string {
  const isPath = /^[.~/].*\.\w+$/.test(text) || /^[a-z][\w-]*\//.test(text);
  const isCmd = /^(npm |npx |git |python|pip |yarn |pnpm |cargo |go |make )/.test(text);
  if (isPath) return 'bg-blue-500/8 border-blue-400/12 text-blue-300/90';
  if (isCmd) return 'bg-amber-500/8 border-amber-400/10 text-amber-300/80';
  return 'bg-[rgba(255,255,255,0.06)] border-edge/20 text-fg-3';
}

export const mdComponents: Record<string, React.ComponentType<any>> = {
  h1: ({ children }: any) => <h2 className="text-[16px] font-bold text-fg mt-4 mb-2">{children}</h2>,
  h2: ({ children }: any) => <h3 className="text-[14.5px] font-semibold text-fg mt-4 mb-1.5">{children}</h3>,
  h3: ({ children }: any) => <h4 className="text-[13.5px] font-semibold text-fg mt-3 mb-1">{children}</h4>,
  p: ({ children }: any) => <p className="my-1.5 whitespace-pre-wrap break-words">{children}</p>,
  strong: ({ children }: any) => <strong className="font-semibold text-fg">{children}</strong>,
  em: ({ children }: any) => <em className="italic text-fg-3">{children}</em>,
  a: ({ href, children }: any) => {
    if (href && isWebUrl(href)) {
      return <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline underline-offset-2 decoration-blue-400/30 cursor-pointer hover:text-blue-300 transition-colors">{children}</a>;
    }
    if (href && isFilePath(href)) {
      return <span className="text-blue-400 underline underline-offset-2 decoration-blue-400/30 cursor-pointer hover:text-blue-300 transition-colors" onClick={() => api.openInEditor(href)}>{children}</span>;
    }
    return <span className="text-blue-400 underline underline-offset-2 decoration-blue-400/30">{children}</span>;
  },
  ul: ({ children }: any) => <ul className="space-y-1 my-2 ml-1">{children}</ul>,
  ol: ({ children }: any) => <ol className="space-y-1 my-2 ml-1 list-decimal list-inside">{children}</ol>,
  li: ({ children }: any) => (
    <li className="flex gap-2 items-start">
      <span className="shrink-0 mt-[10px] w-[5px] h-[5px] rounded-full bg-fg-5/40" />
      <span className="flex-1">{children}</span>
    </li>
  ),
  blockquote: ({ children }: any) => <blockquote className="border-l-2 border-fg-5/30 pl-3 my-2 text-fg-4 italic">{children}</blockquote>,
  hr: () => <hr className="border-edge/30 my-4" />,
  code: ({ className, children, ...props }: any) => {
    const text = String(children).replace(/\n$/, '');
    const langMatch = /language-(\w+)/.exec(className || '');

    // Inline code (no language class, short)
    if (!langMatch && !className) {
      if (isFilePath(text)) {
        return <code className={cn('px-1.5 py-[1px] rounded text-[12px] font-mono border cursor-pointer hover:brightness-125 transition-all', classifyCode(text))} onClick={() => api.openInEditor(text)}>{text}</code>;
      }
      return <code className={cn('px-1.5 py-[1px] rounded text-[12px] font-mono border', classifyCode(text))}>{text}</code>;
    }

    // Fenced code block
    const lang = langMatch?.[1] || '';
    return (
      <div className="rounded-lg overflow-hidden border border-edge/30 bg-[rgba(0,0,0,0.25)] my-3 not-prose">
        <div className="flex items-center justify-between px-3.5 py-1.5 border-b border-edge/15 bg-[rgba(0,0,0,0.12)]">
          <span className="text-[10px] font-mono text-fg-5/50">{lang || 'text'}</span>
          <CopyButton text={text} />
        </div>
        <pre className="px-3.5 py-3 text-[12px] leading-[1.65] text-fg-3 font-mono whitespace-pre-wrap break-words overflow-x-auto">
          <code>{text}</code>
        </pre>
      </div>
    );
  },
  pre: ({ children }: any) => <>{children}</>,
  table: ({ children }: any) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-edge/30">
      <table className="w-full text-[12.5px]">{children}</table>
    </div>
  ),
  thead: ({ children }: any) => <thead className="bg-[rgba(0,0,0,0.1)]">{children}</thead>,
  th: ({ children }: any) => <th className="px-3 py-1.5 text-left font-semibold text-fg-3 border-b border-edge/30">{children}</th>,
  td: ({ children }: any) => <td className="px-3 py-1.5 text-fg-4 border-t border-edge/12">{children}</td>,
  tr: ({ children }: any) => <tr className="even:bg-[rgba(255,255,255,0.015)]">{children}</tr>,
};
