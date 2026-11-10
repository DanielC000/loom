# 7755b0bd — `ssh_exec` screens a program glued to an option value or env assignment

## Why

The risky screen compared whole words, so a program hidden behind `=` (`git -c core.sshCommand=reboot`, `tar --to-command=reboot`, `GIT_SSH_COMMAND=reboot git fetch`) or glued to a short option (`tar -Ireboot`, `rsync -ereboot`) was never seen as a command. In shell mode (b2229239) quoting made the glued payload multi-word (`git -c 'core.pager=rm -rf /srv' log`, `GIT_SSH_COMMAND='bash -i' git fetch`), and the executor hold ran over the same unsplit words. Measured ALLOW with the default risky list before this change.

## What changed

- `wordsForRiskyMatch` (`connections/sshShellParse.ts`), the single producer of the screen's word list, now also emits: each word split on `=`; and, for a single-dash option word longer than 2 chars, the remainder after the option letter plus that remainder split on `=`. The same is applied to every piece of a quoted payload. The risky matcher, the executor hold and shell-mode exact rules all read this list.
- `evaluateSshCommandPolicy` (`connections/sshPolicy.ts`) now routes the flat (shellSyntax OFF) path through `wordsForRiskyMatch` too.

## This CHANGES shellSyntax-OFF behaviour

b2229239 kept the OFF path byte-identical. This card deliberately does not: the glued-program class was already allowed on OFF, and that is the gap. The change is fail-closed only: it can add a hold (`requiresApproval`) and never removes one or widens a refusal. It supersedes b2229239's "OFF is byte-identical" claim for this class only; the grammar, refusals and read-only behaviour of the OFF path are unchanged.

Accepted false holds: any `=` value or short-option remainder that equals a risky word or names a shell/interpreter (`--format=kill`, `LOG=shutdown cmd`, `ls -ash` in shell mode). A hold costs one owner approval.

## Residuals (named, not fixed)

- An env var that names a file or library rather than a command (`LD_PRELOAD=/tmp/x.so`, `BASH_ENV`, `NODE_OPTIONS`): no word screen can see that.
- A program on no list; only the risky list and the server-side user constrain it.
- The OFF path has no executor hold (`bash`/`xargs`/`ssh` are held only in shell mode). Widening that is a separate product decision.
- A risky word inside a `/`-terminated word: card `7eea8cd4`.
- Whether `tee`/`truncate`/`shred`/`sed -i` join the DEFAULT risky list is an owner product call, not changed here.

## Do not

- Do not replace the `=` split and short-option remainder with a list of dangerous option names (b2229239's round-5 lesson: a denylist is found wanting one review at a time).
- Do not stop the OFF path from using `wordsForRiskyMatch`, and do not keep a second splitter.
- Do not touch the human-only grant paths or the default risky list in this change.

## Proof

`test/ssh-risky-equals-split.mjs`: a specimen per command on OFF and shell mode plus clean controls. Two behavioural mutants (`negative-control --mutant`): drop the `=` split; drop the short-option remainder.
