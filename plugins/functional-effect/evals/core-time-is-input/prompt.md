---
name: core-time-is-input
tags: [model, core]
runs: 2
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill]
---
This Go repo has .functional-effect.json with core ["internal/core/**"]. Write the code for internal/core/trial.go: a free trial that expires 14 days after it starts, can be extended once by 7 days, and can be cancelled. Show the code in the reply; do not write files.
