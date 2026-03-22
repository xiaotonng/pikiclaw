import claudeLogo from '../assets/brands/claude.png';
import codexLogo from '../assets/brands/codex.png';
import feishuLogo from '../assets/brands/feishu.ico';
import geminiLogo from '../assets/brands/gemini.svg';
import telegramLogo from '../assets/brands/telegram.svg';
import weixinLogo from '../assets/brands/weixin.svg';
import playwrightLogo from '../assets/brands/playwright.ico';
import appiumLogo from '../assets/brands/appium.png';
import { cn } from '../utils';

const brandIcons: Record<string, string> = {
  claude: claudeLogo,
  codex: codexLogo,
  gemini: geminiLogo,
  telegram: telegramLogo,
  feishu: feishuLogo,
  weixin: weixinLogo,
  playwright: playwrightLogo,
  appium: appiumLogo,
};

export function BrandIcon({ brand, size = 18, className }: {
  brand: string;
  size?: number;
  className?: string;
}) {
  const src = brandIcons[brand];
  if (!src) return null;
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
