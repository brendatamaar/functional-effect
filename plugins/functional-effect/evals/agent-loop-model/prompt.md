---
name: agent-loop-model
tags: [model, agent-loop]
runs: 2
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill]
---
I'm writing an LLM agent loop in TypeScript: it calls the model, the model may request tools, some tools (deploy, send email) must be approved by a human, and the whole run has a token budget and a maximum number of turns. How should I structure it so it is testable without calling a model? Answer in the reply.
