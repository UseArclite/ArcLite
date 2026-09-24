"use client";
import { useEffect, useState } from "react";
import { Play, Pause, ArrowRight, LockKeyhole, Eye, ShieldCheck } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { useSound } from "./immersion";
import { cash } from "../lib/format";
const steps = [
  [
    "Screen",
    "Registry screening",
    "Eligible asset tokens are checked before entering the proposed pool.",
  ],
  [
    "Seal",
    "Private order notes",
    "Individual instructions remain inside the private execution process.",
  ],
  [
    "Cross",
    "Guarded reference",
    "Matched size crosses against a valid reference. Unmatched size remains resting.",
  ],
  ["Settle", "Raw-unit balances", "The matched portion updates private asset and treasury notes."],
  [
    "Prove",
    "Public accountability",
    "An epoch solvency proof and delayed aggregates support pool-level accountability.",
  ],
];
export function ExecutionPlayer() {
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const { cue } = useSound();
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => setStep((s) => (s + 1) % steps.length), 2600);
    return () => clearInterval(timer);
  }, [playing]);
  function choose(i: number) {
    setStep(i);
    setPlaying(false);
    cue("select");
  }
  return (
    <section className="execution-player">
      <div className="interactive-title">
        <span className="eyebrow">CONTROL THE CROSSING</span>
        <h2>
          Follow an order.
          <br />
          <em>At your own pace.</em>
        </h2>
      </div>
      <div className={"execution-track step-" + step} aria-label="Execution stages">
        {steps.map(([name], i) => (
          <button key={name} aria-pressed={step === i} onClick={() => choose(i)}>
            <span>{String(i + 1).padStart(2, "0")}</span>
            <strong>{name}</strong>
            {i < 4 && <ArrowRight size={16} />}
          </button>
        ))}
      </div>
      <div className="execution-scene">
        <div className="execution-notes" aria-hidden="true">
          {["ASSET", "SEALED", "NAV"].map((s, i) => (
            <div
              key={s}
              style={{
                transform: `translateY(${step === 1 ? i * 8 : Math.sin(step + i) * 18}px) rotate(${(i - 1) * (step === 1 ? 0 : 7)}deg)`,
              }}
            >
              <LockKeyhole size={24} />
              <span>{s}</span>
              <small>{step >= 3 ? "RAW UNITS" : "PRIVATE NOTE"}</small>
            </div>
          ))}
        </div>
        <div className="execution-copy" aria-live="polite">
          <span>CHAPTER {step + 1} / 5</span>
          <h3>{steps[step][1]}</h3>
          <p>{steps[step][2]}</p>
          <button onClick={() => setPlaying(!playing)}>
            {playing ? <Pause size={16} /> : <Play size={16} />}{" "}
            {playing ? "Pause journey" : "Play journey"}
          </button>
        </div>
      </div>
      <Slider
        aria-label="Execution chapter"
        value={[step]}
        min={0}
        max={4}
        step={1}
        onValueChange={(v) => choose(v[0])}
      />
      <p className="interactive-footnote">
        An interactive explanation of the proposed architecture. This sequence does not execute
        trades or generate a cryptographic proof.
      </p>
    </section>
  );
}
export function ProofLens() {
  const [view, setView] = useState("public");
  const [key, setKey] = useState(false);
  const { cue } = useSound();
  const reveal = view === "trader" || (view === "auditor" && key);
  return (
    <section className="proof-lens">
      <div className="interactive-title">
        <span className="eyebrow">ONE POOL / THREE PERSPECTIVES</span>
        <h2>
          Change the view.
          <br />
          <em>See what changes.</em>
        </h2>
      </div>
      <Tabs
        value={view}
        onValueChange={(v) => {
          setView(v);
          cue("select");
        }}
      >
        <TabsList className="lens-tabs" aria-label="Disclosure perspective">
          <TabsTrigger value="public">Public</TabsTrigger>
          <TabsTrigger value="trader">Trader</TabsTrigger>
          <TabsTrigger value="auditor">Auditor</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="lens-grid">
        <div className="lens-record">
          <span className="eyebrow">HOW DISCLOSURE WORKS</span>
          <div className="lens-seal">{reveal ? <Eye size={32} /> : <LockKeyhole size={32} />}</div>
          <dl>
            <div>
              <dt>Pool-level evidence</dt>
              <dd>Published per epoch</dd>
            </div>
            <div>
              <dt>Individual instruction</dt>
              <dd className={!reveal ? "concealed" : ""}>
                {reveal ? "Buy 10 NVDA" : "SEALED ORDER"}
              </dd>
            </div>
            <div>
              <dt>Reference value</dt>
              <dd className={!reveal ? "concealed" : ""}>
                {reveal ? "$1,254.00" : "PRIVATE VALUE"}
              </dd>
            </div>
            <div>
              <dt>Private note</dt>
              <dd className={!reveal ? "concealed" : ""}>
                {reveal ? "a note only its owner can open" : "PRIVATE NOTE"}
              </dd>
            </div>
          </dl>
        </div>
        <div className="lens-explanation" aria-live="polite">
          <ShieldCheck size={28} />
          <h3>
            {view === "public"
              ? "Accountability at pool level."
              : view === "trader"
                ? "Your own private receipt."
                : key
                  ? "A permitted, scoped view."
                  : "Access has a purpose."}
          </h3>
          <p>
            {view === "public"
              ? "The public view describes pool solvency and delayed aggregate activity. It does not expose this individual order."
              : view === "trader"
                ? "This sample trader can see their own instruction and receipt. Individual details are not published to the public record."
                : key
                  ? "An auditor holding a scoped view key can open exactly the epochs it names, and nothing else. Scoping is cryptographic rather than a flag this page can set."
                  : "Controlled view keys grant authorized auditors access to the records they are entitled to. Use the switch to see what changes."}
          </p>
          {view === "auditor" && (
            <div className="guard-row">
              <label htmlFor="demo-view-key">Show what a view key opens</label>
              <Switch id="demo-view-key" checked={key} onCheckedChange={setKey} />
            </div>
          )}
        </div>
      </div>
      <p className="interactive-footnote">
        A diagram of the disclosure model, not a view of the venue. The switch is not authentication
        or encryption, and nothing private is stored on this page.
      </p>
    </section>
  );
}
export function NavLab() {
  const [nav, setNav] = useState(1.0842);
  const [units, setUnits] = useState(1000);
  return (
    <div className="nav-example nav-lab">
      <span>EXPLORE AN ILLUSTRATIVE VALUATION</span>
      <div>
        <label htmlFor="treasury-units">Raw treasury units</label>
        <input
          id="treasury-units"
          type="number"
          min={0}
          max={1000000}
          value={units}
          onChange={(e) => setUnits(Math.min(1000000, Math.max(0, Number(e.target.value) || 0)))}
        />
      </div>
      <div>
        <p>
          Example NAV <strong>${nav.toFixed(4)}</strong>
        </p>
        <Slider
          value={[nav]}
          onValueChange={(v) => setNav(v[0])}
          min={0.9}
          max={1.2}
          step={0.0001}
          aria-label="Illustrative treasury NAV"
        />
      </div>
      <div className="nav-total" aria-live="polite">
        <p>Reference value</p>
        <strong>{cash(units * nav)}</strong>
      </div>
      <small>
        Move NAV in either direction. Raw units stay unchanged. These are hypothetical inputs, not a
        yield forecast.
      </small>
    </div>
  );
}
