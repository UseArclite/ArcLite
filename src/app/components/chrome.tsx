"use client";
import { useEffect, useState } from "react";
import Link from "@/app/components/site-link";
import { usePathname } from "@/lib/navigation";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { ArrowUpRight } from "lucide-react";

/**
 * Where each social icon points.
 *
 * A name absent from here renders as a button that opens "Coming soon" instead of a link, which
 * is how the GitHub icon behaved while there was no public repository to send anyone to. Adding
 * a URL is the whole of turning one on.
 */
const socialLinks: Record<string, string> = {
  X: "https://x.com/UseArclite",
  GitHub: "https://github.com/UseArclite/ArcLite",
  Telegram: "https://t.me/arcliteonrobinhood",
  // Canonical listing URL. The link as issued carried `utm_campaign`/`utm_medium`/`utm_source`
  // from the approval email — those attribute that email's own traffic, so republishing them
  // would file every visitor from this site under a campaign they were never part of.
  CoinGecko: "https://www.coingecko.com/en/coins/arclite",
};
export function Socials({ onSelect }: { onSelect: (name: string) => void }) {
  return (
    <div className="socials">
      {["X", "GitHub", "Telegram", "CoinGecko"].map((name) => {
        const icon =
          name === "GitHub" ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 .7a11.5 11.5 0 0 0-3.64 22.4c.58.11.79-.25.79-.55v-2.15c-3.22.7-3.9-1.37-3.9-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.71 1.25 3.37.95.1-.75.4-1.25.74-1.54-2.57-.3-5.27-1.29-5.27-5.69 0-1.25.45-2.28 1.19-3.08-.12-.29-.52-1.46.11-3.04 0 0 .97-.31 3.16 1.18a11 11 0 0 1 5.76 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.58.23 2.75.12 3.04a4.4 4.4 0 0 1 1.18 3.08c0 4.42-2.7 5.39-5.28 5.68.42.36.79 1.06.79 2.14v3.19c0 .3.21.67.8.55A11.5 11.5 0 0 0 12 .7Z"
              />
            </svg>
          ) : name === "X" ? (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-7.4L5.5 22H2.3l7.5-8.6L.8 2h6.5l4.5 6.8L18.9 2Zm-1.1 18h1.7L6.4 3.9H4.6L17.8 20Z"
                fill="currentColor"
              />
            </svg>
          ) : name === "CoinGecko" ? (
            // A gecko silhouette would be unreadable at 24px and is their trademark besides. A
            // price mark reads instantly at this size and claims nothing that is not ours.
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 1.6a10.4 10.4 0 1 0 0 20.8 10.4 10.4 0 0 0 0-20.8Zm0 1.9a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Z"
                fill="currentColor"
              />
              <path
                d="M7.2 14.6h1.9l1.6-3.1 1.9 4.3 1.8-5.4 1.2 2.6h1.9l-2.6-5.4-2 5.7-1.9-4.4-1.9 3.6H7.2Z"
                fill="currentColor"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="m21.5 3.5-3.4 16c-.3 1.1-.9 1.4-1.8.9l-5.2-3.9-2.5 2.4c-.3.3-.5.5-1 .5l.4-5.3 9.7-8.8c.4-.4-.1-.6-.6-.3l-12 7.6L0 11.1c-1-.3-1.1-1 .2-1.5L20.5 1.8c.9-.3 1.6.2 1 1.7Z"
                fill="currentColor"
                transform="translate(1 1) scale(.95)"
              />
            </svg>
          );
        const href = socialLinks[name];
        return href ? (
          <a key={name} href={href} aria-label={name} target="_blank" rel="noopener noreferrer">
            {icon}
          </a>
        ) : (
          <button key={name} aria-label={name} onClick={() => onSelect(name)}>
            {icon}
          </button>
        );
      })}
    </div>
  );
}
export function ComingSoon({ name, onClose }: { name: string | null; onClose: () => void }) {
  return (
    <Dialog open={!!name} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="coming-soon">
        <img loading="eager" decoding="sync" src="/assets/sun.svg" alt="" />
        <p className="eyebrow">THE NEXT CHAPTER</p>
        <DialogTitle>Coming soon.</DialogTitle>
        <DialogDescription>
          {name === "Access"
            ? "The venue is live on Robinhood Chain. Open the dashboard to connect a wallet."
            : `ArcLite on ${name} is on the horizon. Stay close.`}
        </DialogDescription>
        <button className="outline-button" onClick={onClose}>
          Back to the experience
        </button>
      </DialogContent>
    </Dialog>
  );
}
import { LanguageToggle } from "./language-toggle";
import { useT } from "../lib/i18n";

const pages = [
  ["Experience", "/"],
  ["Protocol", "/protocol"],
  ["Assets", "/assets"],
  ["Proofs", "/proofs"],
  ["Docs", "/docs"],
  ["Dashboard", "/dashboard"],
];
export function Header() {
  const t = useT();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [social, setSocial] = useState<string | null>(null);
  const [overDark, setOverDark] = useState(pathname === "/");
  useEffect(() => {
    setOpen(false);
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const header = document.querySelector(".reference-header");
        const y = header ? header.getBoundingClientRect().height / 2 : 40;
        setOverDark(
          // The terminal-skinned dashboard is a dark page, so the header sits over dark for its
          // whole height. Naming it here rather than overriding colours in the skin means the
          // existing light-tone treatment — including the inverted wordmark — just applies.
          [...document.querySelectorAll('.hero,.site-footer,main[data-skin="terminal"]')].some(
            (el) => {
              const r = el.getBoundingClientRect();
              return r.top <= y && r.bottom > y;
            },
          ),
        );
      });
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [pathname]);
  return (
    <>
      <header className="site-header reference-header" data-tone={overDark ? "light" : "dark"}>
        <Link href="/" className="brand">
          <img loading="eager" decoding="sync" src="/assets/sun.svg" alt="ArcLite" />
          <span>ArcLite</span>
        </Link>
        <div className="header-right">
          <nav className="primary-navigation" aria-label="Main navigation">
            {pages.map(([label, href]) => (
              <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined}>
                {t(label)}
              </Link>
            ))}
          </nav>
          <LanguageToggle />
          <button
            className="mobile-menu-toggle"
            aria-expanded={open}
            aria-controls="chapter-menu"
            onClick={() => setOpen(true)}
          >
            Menu <span aria-hidden="true">＋</span>
          </button>
        </div>
      </header>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent id="chapter-menu" className="chapter-menu">
          <DialogTitle className="eyebrow">THE ARCLITE CHAPTERS</DialogTitle>
          <DialogDescription className="sr-only">
            Explore the experience, protocol, assets, proofs and dashboard.
          </DialogDescription>
          <nav aria-label="All pages">
            {pages.map(([label, href], i) => (
              <Link
                key={href}
                href={href}
                aria-current={pathname === href ? "page" : undefined}
                onClick={() => setOpen(false)}
              >
                <span>0{i + 1}</span>
                {label}
                <ArrowUpRight />
              </Link>
            ))}
          </nav>
          <div className="chapter-menu-bottom">
            <p>
              PRIVATE EXECUTION.
              <br />
              REAL-WORLD VALUE.
            </p>
            <Socials onSelect={setSocial} />
          </div>
        </DialogContent>
      </Dialog>
      <ComingSoon name={social} onClose={() => setSocial(null)} />
    </>
  );
}
export function Footer() {
  const [social, setSocial] = useState<string | null>(null);
  return (
    <>
      <footer className="site-footer">
        <div className="footer-top">
          <Link href="/" className="brand">
            <img loading="eager" decoding="sync" src="/assets/sun.svg" alt="" />
            <span>ArcLite</span>
          </Link>
          <nav className="footer-pages" aria-label="Footer navigation">
            <Link href="/protocol">Protocol</Link>
            <Link href="/assets">Assets</Link>
            <Link href="/proofs">Proofs</Link>
            <Link href="/docs">Docs</Link>
            <Link href="/dashboard">Dashboard</Link>
          </nav>
          <Socials onSelect={setSocial} />
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} ArcLite</span>
          <p>
            Protocol in development. Access is subject to asset availability, screening and
            jurisdiction eligibility.
          </p>
          <a href="#top">Back to the heavens ↑</a>
        </div>
      </footer>
      <ComingSoon name={social} onClose={() => setSocial(null)} />
    </>
  );
}
