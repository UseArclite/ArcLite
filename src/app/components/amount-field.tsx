"use client";
import { formatAmount, parseAmount } from "../lib/units";
import { useT } from "../lib/i18n";

/**
 * An amount, typed the way a person says it.
 *
 * Every form on this venue asked for base units — one share was `1000000000000000000` — which is
 * exact and unusable by anyone who did not build it. This takes a decimal quantity and shows the
 * integer it becomes, live, underneath.
 *
 * The raw value is shown rather than hidden, and that is the point rather than a concession. This
 * is a venue whose entire pitch is that you can check its claims; a form that quietly converted
 * your number into a different one would be the first place that stopped being true. It is also
 * how somebody learns that a note holds units, not a balance — which is the model they will meet
 * again the first time an order is refused for being funded by one note.
 *
 * `onChange` receives the raw string, so the caller keeps submitting exactly what it always did.
 * An invalid amount reports `undefined`, never a zero: a half-typed number is not an order for
 * nothing.
 */
export function AmountField({
  label,
  symbol,
  decimals,
  value,
  onChange,
  max,
  disabled,
  hint,
}: {
  label: string;
  /** What the quantity is denominated in, so the field says NVDA rather than "units". */
  symbol?: string;
  decimals: number;
  /** The decimal text the person is typing. Owned by the caller so it survives re-renders. */
  value: string;
  /** Receives the decimal text and the raw units, or `undefined` while the text is not valid. */
  onChange: (text: string, raw?: bigint) => void;
  /** The whole of what is available, in raw units. Renders a MAX that fills in exactly it. */
  max?: bigint;
  disabled?: boolean;
  hint?: string;
}) {
  const t = useT();
  const parsed = parseAmount(value, decimals);
  const show = value.trim() !== "";

  return (
    <label className="amount-field">
      <span>
        {label}
        {symbol ? ` · ${symbol}` : ""}
      </span>
      <span className="amount-input">
        <input
          value={value}
          // `decimal` rather than `numeric`: numeric offers a keypad with no decimal point on
          // iOS, which makes a fractional quantity untypable on a phone.
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0.0"
          disabled={disabled}
          aria-invalid={show && !parsed.raw ? true : undefined}
          onChange={(e) => {
            const next = e.target.value;
            onChange(next, parseAmount(next, decimals).raw);
          }}
        />
        {max !== undefined && max > 0n && (
          <button
            type="button"
            className="amount-max"
            disabled={disabled}
            // Exact, not rounded. A rounded MAX submits a different amount than is held, and on
            // a sell that is the difference between spending a note whole and stranding dust.
            onClick={() => {
              const exact = formatAmount(max, decimals);
              onChange(exact, max);
            }}
          >
            {t("MAX")}
          </button>
        )}
      </span>
      {/* What will actually be submitted. Shown always, so the conversion is never a black box. */}
      {show && parsed.raw !== undefined && (
        <small className="amount-raw" title={parsed.raw.toString()}>
          → {parsed.raw.toString()} {t("raw units")}
        </small>
      )}
      {show && parsed.error && (
        <small className="amount-error" role="alert">
          {t(parsed.error)}
        </small>
      )}
      {!show && hint && <small className="amount-hint">{hint}</small>}
    </label>
  );
}
