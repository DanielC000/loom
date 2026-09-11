# 4ad6ccfd — the batch sync `!result.ok` return renders its own `retryWarning`, gated and worded exactly like `gate_status`'s

## Narrative

Card 4ad6ccfd: `gate_status(opId)` already renders a `retryWarning` for a batch op, but this sync return —
read FIRST by the manager, before any poll — used to carry only the two raw fields
(`retriedFile`/`retryPassed`) and no prose at all. Presence is gated exactly like `gate_status`'s own
dispatch (see
[[9bdc8ea5-format-retry-also-failed-warning-is-a-separate-function]]'s "Caller side" section): `retriedFile`
non-null AND `retryPassed` a strict boolean — a `null`/`undefined` `retryPassed` is the
retry-cancelled-while-queued exception, where no formatter's wording is honest, so it stays unrendered
here too.

**The `landed.length` correction:** an earlier version of this same fix passed `result.landed.length` to
BOTH non-`gatePassed:true` branches (see
[[7ad12202-dispatch-on-gate-verdict-not-retrypassed]] for why the dispatch checks `result.gatePassed`
before `retryPassed`). That count is right for the genuine-rejection shapes (`gatePassed:false`, whether
the retry or the resume is what finally broke) — the outer `landed: []` on this same return and "NONE of
them landed" are both true together there. It is WRONG for the `gatePassed:true` branch:
`formatWeakerPassWarning`'s batch clause asserts "ALL N land on the strength of this ONE retry" — false
when the gate (and retry) passed but the fast-forward/HEAD-read afterward did NOT, which is exactly what
`gatePassed:true` + `ok:false` means (the outer `landed: []` on this return is the same reality check).
Passing `undefined` in that branch instead omits the batch clause entirely rather than assert a landing
that didn't happen — the solo wording alone ("passed only after retrying") stays true regardless of what
fast-forward did afterward.

## Do not

- Do not pass `result.landed.length` to the `gatePassed:true` branch's `formatWeakerPassWarning` call —
  that branch means the retry-assisted gate DID pass but the fast-forward/HEAD-read afterward did not, so
  asserting "ALL N land" there is false; pass `undefined` to omit the batch clause instead.
- Do not gate this return's `retryWarning` on `retriedFile` truthy alone — require `retryPassed` to be a
  strict boolean too, mirroring `gate_status`'s own dispatch.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`mergeBatchTracked`'s sync `!result.ok`
return), as of this tranche's HEAD.
