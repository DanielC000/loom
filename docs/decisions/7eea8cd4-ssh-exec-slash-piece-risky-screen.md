# 7eea8cd4 — `ssh_exec` screens every `/`-separated piece of a word

## Why

`riskyWordMatch` (`connections/sshPolicy.ts`) folds each word to its basename. A word ending in `/` has an EMPTY basename, so a risky word inside it was invisible on both paths: `sed s/a/reboot/ f`, `echo x/reboot/`, `ls /usr/sbin/reboot/`. Measured ALLOW with the default risky list before this change.

## What changed

`wordsForRiskyMatch` (`connections/sshShellParse.ts`, the single producer of the risky matcher's word list, same place as 7755b0bd) now also emits every non-empty `/`-separated piece of every entry it produced (whole words, quoted-payload pieces, `=` splits, short-option remainders). Glued list only; `filterSinkHold` keeps the unglued list, as in 7755b0bd. An empty basename can no longer mean "nothing to match": the empty piece is skipped, the other pieces are matched.

## This CHANGES shellSyntax-OFF behaviour

The OFF path already routes through `wordsForRiskyMatch` (7755b0bd), so it changes too. Fail-closed only: it can add a hold (`requiresApproval`), never remove one or widen a refusal.

Accepted false holds: a path piece that equals a risky word or, in shell mode, names a shell/interpreter/executor (`ls /srv/reboot/`, `cat /usr/lib/python3/x`). A hold costs one owner approval. Clean controls `ls /etc/`, `cat /var/log/syslog`, `df -h /` stay unheld.

## Do not

- Do not go back to basename-only folding, and do not keep a second splitter.
- Do not apply the slash pieces to `filterSinkHold`'s list.

## Proof

`test/ssh-risky-equals-split.mjs` (slash section): specimens on OFF and shell mode plus clean controls; a behavioural mutant (drop the slash pass) via `negative-control --mutant`.
