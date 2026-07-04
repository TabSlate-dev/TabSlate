import { isFirefoxBuild } from "@/lib/browser/env";

export interface WebSearchOptions {
  text: string;
  disposition: "CURRENT_TAB" | "NEW_TAB" | "NEW_WINDOW";
}

export async function runWebSearch({ text, disposition }: WebSearchOptions): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }

  if (isFirefoxBuild()) {
    await browser.search.query({
      text: trimmed,
      disposition,
    });
    return;
  }

  await chrome.search.query({
    text: trimmed,
    disposition,
  });
}
