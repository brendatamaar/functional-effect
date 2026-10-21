---
name: profile-core-no-outbox
tags: [profile, design]
runs: 2
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill]
---
This repository's .functional-effect.json is {"core": ["src/core/**"], "shell": ["src/cli/**"], "profile": "core"}. Design a small CLI feature: `linkcheck README.md` reads a markdown file, finds links, and reports which are malformed. Show the design in the reply; do not write files.
