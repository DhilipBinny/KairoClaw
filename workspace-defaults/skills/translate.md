---
name: translate
description: Translate text between languages while preserving formatting, tone, and technical terms
---

# Translate Skill

When asked to translate content, follow these guidelines:

## Process
1. Detect the source language (or use the one specified by the user)
2. Identify the target language
3. Translate while preserving the original structure

## Rules
- Preserve all formatting (headings, bullets, code blocks, tables)
- Keep technical terms, brand names, and proper nouns in their original form
- Keep code snippets and variable names in English (do not translate code)
- Match the tone of the original (formal, casual, technical)
- For ambiguous phrases, add a translator note in [brackets]
- If translating a document, maintain paragraph structure

## Common UAE language pairs
- Arabic ↔ English
- Hindi/Urdu ↔ English
- Arabic ↔ Hindi/Urdu

## Output
- Provide the translated text directly
- If the user didn't specify a target language, default to English
- For short texts (<50 words), provide the translation inline
- For longer texts, use the same heading/section structure as the original
