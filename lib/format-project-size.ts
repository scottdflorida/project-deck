export function formatProjectSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unavailable";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.floor(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  let display = unit === 0
    ? String(value)
    : value >= 100
      ? String(Math.round(value))
      : value.toFixed(1).replace(/\.0$/u, "");
  if (Number(display) >= 1024 && unit < units.length - 1) {
    unit += 1;
    display = "1";
  }
  return `${display} ${units[unit]}`;
}
