export type Theme = "light" | "dark";
export const THEME_KEY = "uniroute-theme";

export function decodeTheme(value: string | undefined | null): Theme | null {
  if (value === "dark" || value === "light") return value;
  return null;
}