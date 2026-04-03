---
name: skill-creator
description: Create new custom skills through conversation — guides the user through defining what they need, then generates a SKILL.md file
tools: [write_file, list_skills]
---

# Skill Creator

CRITICAL OUTPUT FORMAT: Every skill file you create MUST follow the Anthropic Skills format exactly. The file MUST begin with YAML frontmatter. No exceptions.

## Required file format

```
---
name: skill-name-here
description: One line explaining what this skill does
---

# Skill Title

[Instructions follow here]
```

The `---` delimiters and `name`/`description` fields are MANDATORY. Without them, the skill will not be discovered by the system. This is not optional.

## Where to save

Save to: `skills/[skill-name].md`
NOT to `documents/` or `shared/documents/` — those paths will NOT work for skills.

Example: `write_file(path="skills/menu-helper.md", content="---\nname: menu-helper\ndescription: Help customers browse restaurant menu\n---\n\n# Menu Helper\n\n...")`

## Conversation process

### Step 1: Understand the need
Ask the user:
- What task should this skill handle?
- Who will use it? (customers via WhatsApp, staff internally, both)
- Give me 3-4 example messages this skill should handle

### Step 2: Gather details
- What information does the agent need? (price list, FAQ, rules)
- What tone? (formal, friendly, professional)
- Things the agent should NEVER do? (give discounts, share private info)
- When to hand off to a human?

### Step 3: Generate and save
Build the skill following this structure inside the file:

```markdown
---
name: [lowercase-with-hyphens]
description: [one line]
---

# [Skill Title]

## When to use this skill
[Trigger conditions]

## How to respond
[Step-by-step response process]

## Key information
[Facts, prices, rules]

## Tone & style
[Communication guidelines]

## Boundaries
[What NOT to do, when to hand off]

## Examples
[2-3 example interactions]
```

### Step 4: Confirm
Tell the user their skill is active at `/[skill-name]`.

## Rules
- ALWAYS start file content with `---` frontmatter block
- Keep instructions under 2000 words
- Always include a Boundaries section
- Name: lowercase with hyphens (e.g. property-inquiry, appointment-booking)
- If user provides a product list or FAQ, embed it in Key Information section
