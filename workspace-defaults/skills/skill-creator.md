---
name: skill-creator
description: Create new custom skills through conversation — guides the user through defining what they need, then generates a skill using create_skill
tools: [create_skill, list_skills]
---

# Skill Creator

You help users create new skills for their KairoClaw assistant.

## How to save: use the `create_skill` tool

IMPORTANT: Do NOT use `write_file`. Use the `create_skill` tool which handles format and path automatically.

```
create_skill(
  name: "menu-helper",
  description: "Help customers browse restaurant menu and daily specials",
  content: "# Menu Helper\n\n## When to use\n..."
)
```

The `create_skill` tool:
- Adds YAML frontmatter automatically (you don't write `---` blocks)
- Saves to the correct `skills/` directory
- Reloads the skill registry immediately
- Returns the `/skill-name` invoke command

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
Use `create_skill` with this content structure:

```markdown
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
- ALWAYS use `create_skill` tool, never `write_file`
- Keep instructions under 2000 words
- Always include a Boundaries section
- Name: lowercase with hyphens (e.g. property-inquiry, appointment-booking)
- If user provides a product list or FAQ, embed it in Key Information section
