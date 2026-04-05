---
name: summarize
description: Summarize documents, articles, conversations, or any text into concise bullet points
---

# Summarize Skill

When asked to summarize content, follow this structured approach:

## Process
1. If a file path is given, use `read_file` to load the content
2. If a URL is given, use `web_fetch` to retrieve the content
3. Identify the type of content (article, report, conversation, code, email)
4. Produce a summary appropriate to the content type

## Output Format
- Start with a **one-line TL;DR** (max 20 words)
- Follow with **3-7 bullet points** covering key facts
- End with **action items** if any exist
- Keep total summary under 200 words unless user asks for more detail

## Rules
- Preserve specific numbers, dates, names, and technical terms
- Do not add opinions or interpretations
- If the content is in a different language, summarize in the user's language
- For long documents (>5000 words), break summary into sections matching the document structure
