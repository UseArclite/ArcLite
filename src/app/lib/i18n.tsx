"use client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { zh } from "./zh";

/**
 * Two languages, keyed on the English text itself.
 *
 * The alternative is a key per string — `hero.title`, `hero.subtitle` — and it is the wrong trade
 * for a site whose copy *is* the product. A key tells you nothing at the call site, so a page
 * becomes unreadable to whoever is editing the writing, and a typo in a key fails silently as a
 * blank where a typo in English fails loudly as untranslated English. Using the sentence as its
 * own key keeps the pages readable and makes a missing translation degrade to the original rather
 * than to nothing.
 *
 * The cost is that editing an English string orphans its translation. `missingTranslations` is
 * there so that is findable rather than discovered by a reader.
 */

export type Lang = "en" | "zh";

const STORAGE_KEY = "arclite-lang";

interface LanguageValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (english: string) => string;
}

const Context = createContext<LanguageValue>({
  lang: "en",
  setLang: () => {},
  t: (english) => english,
});

export function LanguageProvider({ children }: { children: ReactNode }) {
  // Always English on the first render. The stored choice lives in localStorage, which the
  // server cannot see, so reading it during render would produce markup that disagrees with the
  // server's and React would discard the whole tree. The swap happens on mount instead.
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "zh" || stored === "en") setLangState(stored);
    } catch {
      // Private windows and blocked site data. English is a working default, not a failure.
    }
  }, []);

  // `lang` on the document is not decoration: it is what a screen reader picks a voice from and
  // what a browser offers to translate against.
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-Hans" : "en";
  }, [lang]);

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // The choice holds for this page either way; it just will not survive a reload.
    }
  }, []);

  const t = useCallback(
    (english: string) => {
      // A JSX string that wraps across lines carries the newline and the indentation with it,
      // so the text in the source and the text in the dictionary would never match. Collapsing
      // runs of whitespace lets the pages keep their formatting and the dictionary keep one
      // readable line per entry.
      const key = english.replace(/\s+/g, " ").trim();
      return lang === "zh" ? (zh[key] ?? english) : english;
    },
    [lang],
  );

  return <Context.Provider value={{ lang, setLang, t }}>{children}</Context.Provider>;
}

export function useLang(): LanguageValue {
  return useContext(Context);
}

/** Just the translator, for the many components that never need to know the language. */
export function useT(): (english: string) => string {
  return useContext(Context).t;
}
