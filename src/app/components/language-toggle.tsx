"use client";
import { useLang } from "../lib/i18n";

/**
 * English or Chinese, in the header.
 *
 * Two buttons rather than a dropdown. With exactly two options a select costs a click to open
 * and hides the alternative until you do, and the current language is the thing a visitor most
 * wants to see at a glance — "EN 中文" answers both questions without being opened.
 *
 * Labelled in its own language on each side: a reader who cannot read the page still recognises
 * 中文, which is the one case this control exists for.
 */
export function LanguageToggle() {
  const { lang, setLang } = useLang();

  return (
    <div className="language-toggle" role="group" aria-label="Language">
      <button
        type="button"
        onClick={() => setLang("en")}
        aria-pressed={lang === "en"}
        // The tag is what a screen reader should switch voice on, and it belongs on the control
        // that selects it rather than only on the document.
        lang="en"
      >
        EN
      </button>
      <span aria-hidden="true">/</span>
      <button type="button" onClick={() => setLang("zh")} aria-pressed={lang === "zh"} lang="zh">
        中文
      </button>
    </div>
  );
}
