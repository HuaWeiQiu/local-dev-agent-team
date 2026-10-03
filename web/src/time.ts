const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

/** "3 分钟前" style label; anything under a minute reads as "刚刚". */
export function formatRelative(iso: string, now = Date.now()): string {
  const diff = Date.parse(iso) - now;
  if (Number.isNaN(diff)) return "";
  if (Math.abs(diff) < 60_000) return "刚刚";
  for (const [unit, size] of units) {
    if (Math.abs(diff) >= size) return formatter.format(Math.round(diff / size), unit);
  }
  return "刚刚";
}
