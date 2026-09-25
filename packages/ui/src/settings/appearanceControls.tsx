import { useState } from "react";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  APPEARANCE_FONT_WEIGHT_OPTIONS,
  isHexColor,
  normalizeHexColor,
  type AppearanceFontWeight,
} from "@/lib/appearancePreferences.js";

export function ColorSwatch({
  color,
  disabled,
  ariaLabel,
  onChange,
}: {
  color: string;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (hex: string) => void;
}) {
  return (
    <label
      className={cn(
        "relative inline-flex size-7 shrink-0 items-center justify-center rounded-full ring-1 ring-black/10 dark:ring-white/20",
        disabled ? "cursor-default opacity-50" : "cursor-pointer",
      )}
    >
      <span className="size-7 rounded-full" style={{ backgroundColor: color }} />
      <input
        type="color"
        value={color.toLowerCase()}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => onChange(normalizeHexColor(event.currentTarget.value))}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      />
    </label>
  );
}

/**
 * hex 文本输入：失焦/回车提交；空值按 null 提交（跟随内置），
 * 非法值回落当前值并还原显示。
 */
export function HexColorInput({
  value,
  disabled,
  ariaLabel,
  onCommit,
}: {
  value: string;
  disabled?: boolean;
  ariaLabel: string;
  onCommit: (hex: string | null) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [draftKey, setDraftKey] = useState(value);

  // 外部值变化（预设/导入/广播）时同步草稿。
  if (draftKey !== value) {
    setDraftKey(value);
    setDraft(value);
  }

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === "") {
      setDraft(value);
      onCommit(null);
      return;
    }
    if (isHexColor(trimmed)) {
      const normalized = normalizeHexColor(trimmed);
      setDraft(normalized);
      if (normalized !== value) {
        onCommit(normalized);
      }
      return;
    }
    setDraft(value);
  };

  return (
    <Input
      value={draft}
      disabled={disabled}
      aria-label={ariaLabel}
      spellCheck={false}
      onChange={(event) => setDraft(event.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.currentTarget.blur();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft(value);
        }
      }}
      className="h-8 w-[110px] font-mono text-ui-sm tabular-nums"
    />
  );
}

export function ContrastSlider({
  value,
  ariaLabel,
  onChange,
}: {
  value: number;
  ariaLabel: string;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-label={ariaLabel}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
        className="h-1.5 w-44 cursor-pointer appearance-none rounded-full bg-border"
        style={{ accentColor: "var(--color-brand)" }}
      />
      <span className="w-8 text-right text-ui-base tabular-nums text-foreground">{value}</span>
    </div>
  );
}

// Radix Select 禁止 SelectItem 的 value 为空字符串（空串语义是"清空选择显示占位符"），
// 而外观偏好用 "" 表示「系统默认/与界面字体相同」。这里用哨兵值做内部映射，
// 对外（store、localStorage）仍保持 "" 语义不变。
const EMPTY_FONT_ITEM_VALUE = "__system__";

function toSelectItemValue(fontFamily: string): string {
  return fontFamily === "" ? EMPTY_FONT_ITEM_VALUE : fontFamily;
}

function fromSelectItemValue(itemValue: string): string {
  return itemValue === EMPTY_FONT_ITEM_VALUE ? "" : itemValue;
}

export function FontFamilySelect({
  options,
  value,
  widthClassName,
  ariaLabel,
  onChange,
}: {
  options: { value: string; labelId: string }[];
  value: string;
  widthClassName: string;
  ariaLabel: string;
  onChange: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Select
      value={toSelectItemValue(value)}
      onValueChange={(next) => onChange(fromSelectItemValue(next))}
    >
      <SelectTrigger
        size="lg"
        aria-label={ariaLabel}
        className={cn("min-w-0 justify-between", widthClassName)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value || "system"} value={toSelectItemValue(option.value)}>
            {intl.formatMessage({ id: option.labelId })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function FontWeightSelect({
  value,
  ariaLabel,
  onChange,
}: {
  value: AppearanceFontWeight;
  ariaLabel: string;
  onChange: (value: AppearanceFontWeight) => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <Select
      value={String(value)}
      onValueChange={(next) => onChange(Number(next) as AppearanceFontWeight)}
    >
      <SelectTrigger size="lg" aria-label={ariaLabel} className="w-[104px] justify-between">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {APPEARANCE_FONT_WEIGHT_OPTIONS.map((weight) => (
          <SelectItem key={weight} value={String(weight)}>
            {intl.formatMessage({ id: `settings.appearance.fontWeight.${weight}` })}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
