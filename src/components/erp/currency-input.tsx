"use client";

import { useMemo, useState } from "react";

const formatter = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const parseBrl = (value: string) => Number(value.replace(/[^0-9]/g, "")) / 100;

export function CurrencyInput({ name, defaultValue = 0, required = false, onValueChange }: { name: string; defaultValue?: number; required?: boolean; onValueChange?: (value: number) => void }) {
  const initial = useMemo(() => defaultValue ? formatter.format(Number(defaultValue)) : "", [defaultValue]);
  const [display, setDisplay] = useState(initial);
  const [numeric, setNumeric] = useState(Number(defaultValue || 0));
  return <>
    <input
      inputMode="numeric"
      value={display}
      placeholder="R$ 0,00"
      required={required}
      onChange={(event) => {
        const value = parseBrl(event.target.value);
        setNumeric(value);
        setDisplay(event.target.value ? formatter.format(value) : "");
        onValueChange?.(value);
      }}
    />
    <input type="hidden" name={name} value={numeric} />
  </>;
}
