---
name: research
description: Research a topic using web search, compile findings into a structured report
tools: [web_search, web_fetch, write_file]
---

# Research Skill

When asked to research a topic, follow this systematic approach:

## Process
1. **Clarify scope** — If the topic is broad, ask the user what specific angle they want
2. **Search** — Use `web_search` with 2-3 different query variations
3. **Deep dive** — Use `web_fetch` on the most relevant 3-5 results
4. **Synthesize** — Compile findings into a structured report
5. **Save** — Use `write_file` to save the report as a markdown file

## Report Format
```markdown
# Research: [Topic]

## TL;DR
[2-3 sentence summary of key findings]

## Key Findings
- [Finding 1 with source]
- [Finding 2 with source]
- [Finding 3 with source]

## Details
[Organized by subtopic, with citations]

## Sources
- [Source 1 title](URL)
- [Source 2 title](URL)

## Gaps & Limitations
[What couldn't be verified or found]
```

## Rules
- Always cite sources with URLs
- Distinguish between facts and opinions
- Note when information is outdated or conflicting
- If web search is unavailable, clearly state limitations
- Save the report to `documents/research-[topic].md`
