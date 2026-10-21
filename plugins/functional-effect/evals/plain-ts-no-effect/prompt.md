---
name: plain-ts-no-effect
tags: [model, typescript]
runs: 2
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill]
---
TypeScript project. package.json dependencies are only: zod, fast-check, express. .functional-effect.json has core ["src/core/**"] and profile "service". Show the boundary parser and the interpreter for a `ChargeCard` command whose payment gateway can decline or be unavailable. Reply with code only plus one line of explanation; do not write files.
