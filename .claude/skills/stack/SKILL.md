---
name: stack
description: Use when work is split into stacked branches/PRs in flowctl - creating the next branch, updating a lower branch, retargeting and merging bottom-up, or recovering after a squash merge.
---

# Stacked branches and PRs

## Create

1. `git switch -c <next> <current-top>`; work; `git push -u origin <next>`.
2. PR base = the branch below; body says `Stack: n/N` with links; label `status:stacked` (`ship-pr` skill).

## Change a lower branch

Commit on the lower branch, push, then carry it up one level at a time:
`git switch <upper> && git merge <lower> && git push`. Merge, not rebase: these branches are shared.

## Merge (bottom-up)

1. Merge the bottom PR with **"Create a merge commit"**. Squash or rebase rewrites the commits the upper branches contain and turns every upper PR into a conflict.
2. Retarget the next PR: `gh pr edit <n> --base main`. Its diff now shows only its own commits.
3. Repeat. Merging is the user's action unless they allow `gh pr merge`.
4. Afterwards: `git switch main && git pull`, delete merged branches locally and on origin.

## Recover from a squash merge of a lower PR

`git rebase --onto main <old-lower-tip> <upper>` then `git push --force-with-lease`. Tell the user first; it rewrites a pushed branch.
