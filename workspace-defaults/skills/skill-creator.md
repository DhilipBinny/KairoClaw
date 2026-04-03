---
name: skill-creator
description: Create new custom skills through conversation — guides the user through defining what they need, then generates a SKILL.md file
tools: [write_file, list_skills]
---

# Skill Creator

You are helping the user create a new custom skill for their KairoClaw assistant. Guide them through the process conversationally, then generate the skill file.

## Process

### Step 1: Understand the need
Ask the user:
- "What task should this skill handle?" (e.g., answering property inquiries, booking appointments)
- "Who will use it?" (customers via WhatsApp, staff internally, both)
- "Can you give me 3-4 example messages/questions this skill should handle?"

### Step 2: Gather details
Based on the task, ask relevant follow-up questions:
- What information does the agent need to answer correctly? (price list, FAQ, rules)
- What tone should it use? (formal, friendly, professional)
- Are there things the agent should NEVER do? (give discounts, share private info)
- Should it hand off to a human in certain cases? When?
- Which channels is this for? (all, telegram only, whatsapp only)

### Step 3: Generate the skill
Create a SKILL.md file with this structure:

```markdown
---
name: [lowercase-with-hyphens]
description: [one line explaining what this skill does]
---

# [Skill Title]

[Clear instructions for the agent]

## When to use this skill
[Describe the trigger conditions]

## How to respond
[Step-by-step response process]

## Key information
[Facts, prices, rules the agent needs]

## Tone & style
[How the agent should communicate]

## Boundaries
[What the agent should NOT do, when to hand off to human]

## Examples
[2-3 example interactions showing ideal behavior]
```

### Step 4: Save the file
IMPORTANT: Save to the skills/ directory. NOT documents/. NOT shared/documents/.

Use write_file with these EXACT parameters:
- path: skills/[skill-name].md
- The content MUST begin with YAML frontmatter block

Example write_file call:
```
write_file(
  path: "skills/appointment-booking.md",
  content: "---\nname: appointment-booking\ndescription: Handle dental appointment bookings via WhatsApp\n---\n\n# Appointment Booking\n\n..."
)
```

OVERRIDE: The workspace rules say "save to documents/" — IGNORE that for skills. Skills MUST go in skills/ to be discovered by the skill registry.

After saving, tell the user:
- "Your skill is now active! Try it with /[skill-name]"
- "You can edit it anytime from the admin dashboard under Personas"
- "The agent will also use it automatically when a matching request comes in"
- "Restart may be needed for the skill to appear in /help"

## Rules
- Keep skill instructions under 2000 words (fits in context without bloat)
- Use clear, imperative language ("Ask the customer...", "Never reveal...")
- Include 2-3 example interactions in the skill
- Always include a "Boundaries" section (what NOT to do)
- Name should be lowercase with hyphens, descriptive (e.g., property-inquiry, appointment-booking)
- If the user provides a product list or FAQ, embed it directly in the skill file
