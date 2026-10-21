---
name: trigger-design
tags: [trigger, design]
runs: 2
max_turns: 8
allowed_tools: [Read, Glob, Grep, Skill]
---
Design a feature for our shop service: a customer places an order and pays by card. The payment API can time out after the request was sent, and the customer can cancel until the order ships. Don't write any code yet.
