"use client";
import { useEffect, useRef } from "react";
import Link from "@/app/components/site-link";
import { ArrowUpRight } from "lucide-react";
export function ScrollReveals() {
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) e.target.classList.add("revealed");
        }),
      { threshold: 0.1 },
    );
    document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return null;
}
type StoryProps = {
  chapter: string;
  title: string;
  copy: string;
  figure: string;
  poster: string;
  caption: string;
  theme?: string;
  reverse?: boolean;
  eager?: boolean;
};
export function StoryFrame({
  chapter,
  title,
  copy,
  figure,
  poster,
  caption,
  theme = "pink",
  reverse = false,
  eager = false,
}: StoryProps) {
  const ref = useRef<HTMLElement>(null);
  const artwork = figure.includes("/campaign-");
  useEffect(() => {
    let frame = 0;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const move = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!ref.current) return;
        const b = ref.current.getBoundingClientRect();
        const p = reduced
          ? 0.5
          : Math.min(1, Math.max(0, -b.top / Math.max(1, b.height - innerHeight)));
        ref.current.style.setProperty("--scene-p", String(p));
      });
    };
    move();
    window.addEventListener("scroll", move, { passive: true });
    window.addEventListener("resize", move);
    return () => {
      window.removeEventListener("scroll", move);
      window.removeEventListener("resize", move);
      cancelAnimationFrame(frame);
    };
  }, []);
  return (
    <section
      ref={ref}
      className={`story-frame ${theme} ${reverse ? "reverse" : ""} ${artwork ? "artwork-story" : ""}`}
    >
      <div className="story-frame-inner">
        <div className="scene-heading reveal">
          <span className="eyebrow">{chapter}</span>
          <h2>
            {title.split("<br/>").map((line, i) => (
              <span key={i}>
                {line}
                {i < title.split("<br/>").length - 1 && <br />}
              </span>
            ))}
          </h2>
        </div>
        <div className={`illustrated-scene ${artwork ? "artwork-scene" : ""}`}>
          <div className="scene-clouds" />
          {artwork ? (
            <div className="scene-art-panel">
              <img
                src={figure}
                alt="ArcLite engraved artwork in navy, pink and cyan"
                loading="eager"
                decoding="sync"
                fetchPriority="high"
              />
            </div>
          ) : (
            <>
              <img
                loading="eager"
                decoding="sync"
                className="scene-figure"
                src={figure}
                alt="Classical ArcLite figure from the existing graphics"
              />
              <div className="scene-inset">
                <img loading="eager" decoding="sync" src={poster} alt="ArcLite artwork detail" />
              </div>
            </>
          )}
          <div className="caption scene-caption">
            <span>{chapter}</span>
            {copy}
          </div>
          <div className="caption scene-caption-secondary">{caption}</div>
          <span className="scene-corner" aria-hidden="true">
            ＋
          </span>
        </div>
      </div>
    </section>
  );
}
export function ChapterLinks({ current = "" }: { current?: string }) {
  return (
    <nav className="chapter-links" aria-label="Explore ArcLite">
      {[
        ["Protocol", "/protocol"],
        ["Assets", "/assets"],
        ["Proofs", "/proofs"],
        ["Docs", "/docs"],
        ["Dashboard", "/dashboard"],
      ].map(([label, href]) => (
        <Link href={href} key={href} className={current === href ? "active" : ""}>
          {label}
          <ArrowUpRight size={16} />
        </Link>
      ))}
    </nav>
  );
}
export function NextChapter({
  number,
  title,
  href,
}: {
  number: string;
  title: string;
  href: string;
}) {
  return (
    <Link className="next-chapter" href={href}>
      <span className="eyebrow">CONTINUE THE EXPERIENCE / {number}</span>
      <span>
        {title}
        <ArrowUpRight />
      </span>
    </Link>
  );
}
export function ArticleOpening({
  number,
  title,
  subtitle,
  figure,
  caption,
}: {
  number: string;
  title: string;
  subtitle: string;
  figure: string;
  caption: string;
}) {
  return (
    <section className="article-opening">
      <div className="article-heading">
        <span className="eyebrow">ARCLITE / CHAPTER {number}</span>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      <div className={"article-comic " + (figure.includes("/campaign-") ? "article-artwork" : "")}>
        <div className="scene-clouds" />
        <img
          loading="eager"
          decoding="sync"
          src={figure}
          alt="ArcLite engraved campaign artwork without lettering"
        />
        <div className="caption">
          <span>THE ARCLITE PAPERS / {number}</span>
          {caption}
        </div>
        <span className="article-number">{number}</span>
      </div>
    </section>
  );
}
