import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Card-header icons: one Lucide glyph per card, all at this size and colour. */
export const CARD_ICON = "size-5 shrink-0 text-muted-foreground"
