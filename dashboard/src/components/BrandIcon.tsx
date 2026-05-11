import claudeLogo from '../assets/brands/claude.png';
import codexLogo from '../assets/brands/codex.png';
import feishuLogo from '../assets/brands/feishu.ico';
import geminiLogo from '../assets/brands/gemini.svg';
import telegramLogo from '../assets/brands/telegram.svg';
import weixinLogo from '../assets/brands/weixin.svg';
import slackLogo from '../assets/brands/slack.svg';
import discordLogo from '../assets/brands/discord.svg';
import dingtalkLogo from '../assets/brands/dingtalk.svg';
import wecomLogo from '../assets/brands/wecom.svg';
import playwrightLogo from '../assets/brands/playwright.ico';
import vscodeLogo from '../assets/brands/vscode.svg';
import cursorLogo from '../assets/brands/cursor.svg';
import windsurfLogo from '../assets/brands/windsurf.svg';
import finderLogo from '../assets/brands/finder.svg';
import hermesLogo from '../assets/brands/hermes.png';
import openrouterLogo from '../assets/brands/openrouter.ico';
import anthropicLogo from '../assets/brands/anthropic.ico';
import deepseekLogo from '../assets/brands/deepseek.ico';
import qwenLogo from '../assets/brands/qwen.png';
import doubaoLogo from '../assets/brands/doubao.png';
import glmLogo from '../assets/brands/glm.png';
import minimaxLogo from '../assets/brands/minimax.ico';
import openaiLogo from '../assets/brands/openai.svg';
import { cn } from '../utils';

const brandIcons: Record<string, string> = {
  claude: claudeLogo,
  codex: codexLogo,
  gemini: geminiLogo,
  telegram: telegramLogo,
  feishu: feishuLogo,
  weixin: weixinLogo,
  slack: slackLogo,
  discord: discordLogo,
  dingtalk: dingtalkLogo,
  wecom: wecomLogo,
  playwright: playwrightLogo,
  vscode: vscodeLogo,
  cursor: cursorLogo,
  windsurf: windsurfLogo,
  finder: finderLogo,
  // Coding agents + model providers
  hermes: hermesLogo,
  openrouter: openrouterLogo,
  anthropic: anthropicLogo,
  deepseek: deepseekLogo,
  google: geminiLogo,
  qwen: qwenLogo,
  doubao: doubaoLogo,
  glm: glmLogo,
  minimax: minimaxLogo,
  openai: openaiLogo,
};

/**
 * Letter-only fallback for the generic "custom" / "+" placeholder.
 */
const letterFallbacks: Record<string, { letter: string; color: string; bg: string }> = {
  custom: { letter: '+', color: '#94a3b8', bg: 'rgba(148,163,184,0.12)' },
};

export function BrandIcon({ brand, size = 18, className }: {
  brand: string;
  size?: number;
  className?: string;
}) {
  const src = brandIcons[brand];
  if (src) {
    return (
      <img
        src={src}
        alt=""
        aria-hidden="true"
        draggable={false}
        className={cn('shrink-0 object-contain select-none', className)}
        style={{ width: size, height: size }}
      />
    );
  }
  const fallback = letterFallbacks[brand];
  if (!fallback) return null;
  // Letter mark: pill background with brand-tinted color. Letter is sized
  // proportionally; multi-character marks (OR, DS) shrink slightly so they
  // still read as a single mark rather than running text.
  const isMulti = fallback.letter.length > 1;
  return (
    <span
      aria-hidden="true"
      className={cn('inline-flex shrink-0 items-center justify-center rounded-md font-semibold tracking-tight select-none', className)}
      style={{
        width: size,
        height: size,
        background: fallback.bg,
        color: fallback.color,
        fontSize: Math.round(size * (isMulti ? 0.42 : 0.55)),
        lineHeight: 1,
        letterSpacing: isMulti ? '-0.02em' : 'normal',
      }}
    >
      {fallback.letter}
    </span>
  );
}

export function BrandBadge({ brand, size, iconSize = Math.round(size * 0.5), className, imageClassName }: {
  brand: string;
  size: number;
  iconSize?: number;
  className?: string;
  imageClassName?: string;
}) {
  return (
    <div
      className={cn('flex shrink-0 items-center justify-center border border-edge bg-panel-alt', className)}
      style={{ width: size, height: size }}
    >
      <BrandIcon brand={brand} size={iconSize} className={imageClassName} />
    </div>
  );
}
