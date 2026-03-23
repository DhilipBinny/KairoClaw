#!/bin/bash
# ══════════════════════════════════════════════
# Pre-commit hook: detect accidentally staged secrets
#
# Scans staged files for API keys, tokens, and credentials.
# Blocks the commit if any are found.
#
# Setup (run once):
#   cp scripts/pre-commit-secrets-check.sh .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# Or symlink (auto-updates when script changes):
#   ln -sf ../../scripts/pre-commit-secrets-check.sh .git/hooks/pre-commit
#
# To bypass (dangerous):
#   git commit --no-verify
# ══════════════════════════════════════════════

RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# Patterns that indicate leaked secrets
PATTERNS=(
  # Provider API keys
  'sk-ant-api03-'              # Anthropic API key
  'sk-ant-oat[0-9]+-'         # Anthropic OAuth token
  'sk-proj-'                   # OpenAI project key
  'sk-[a-zA-Z0-9]{20,}'       # Generic OpenAI-style key

  # Key assignments (in .env or config)
  'ANTHROPIC_API_KEY=sk'       # Anthropic key assignment
  'ANTHROPIC_AUTH_TOKEN=sk'    # Anthropic OAuth assignment
  'OPENAI_API_KEY=sk'          # OpenAI key assignment

  # Channel tokens
  'TELEGRAM_BOT_TOKEN=[0-9]+:' # Telegram bot token
  'BRAVE_API_KEY=BSA'          # Brave Search API key
  'AGW_TOKEN=.'                # Gateway auth token (non-empty)

  # GitHub / MCP tokens
  'ghp_[a-zA-Z0-9]{30,}'      # GitHub personal access token
  'gho_[a-zA-Z0-9]{30,}'      # GitHub OAuth token
  'xoxb-'                      # Slack bot token

  # Generic secrets
  '"apiKey":\s*"sk-'           # JSON with real API key
  '"authToken":\s*"sk-'        # JSON with real auth token
  '"botToken":\s*"[0-9]+:'     # JSON with real bot token
)

# Files to always skip
SKIP_PATTERNS=(
  '*.env.example'
  '*.png'
  '*.jpg'
  '*.jpeg'
  '*.ico'
  '*.sqlite'
  '*.db'
  'pnpm-lock.yaml'
)

FOUND=0

# Only check staged files (what's about to be committed)
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACMR)

for file in $STAGED_FILES; do
  # Skip binary and excluded files
  skip=false
  for pattern in "${SKIP_PATTERNS[@]}"; do
    if [[ "$file" == $pattern ]]; then
      skip=true
      break
    fi
  done
  if $skip; then continue; fi

  for pattern in "${PATTERNS[@]}"; do
    # Check only added lines in staged content (ignore removed lines)
    if git diff --cached -- "$file" | grep '^+' | grep -qE "$pattern"; then
      if [ $FOUND -eq 0 ]; then
        echo -e "${RED}══════════════════════════════════════════════${NC}"
        echo -e "${RED}  SECRETS DETECTED IN STAGED FILES${NC}"
        echo -e "${RED}══════════════════════════════════════════════${NC}"
      fi
      echo -e "${YELLOW}  File: ${file}${NC}"
      echo -e "${YELLOW}  Pattern: ${pattern}${NC}"
      FOUND=1
      break
    fi
  done
done

if [ $FOUND -eq 1 ]; then
  echo ""
  echo -e "${RED}  Commit blocked. Remove secrets before committing.${NC}"
  echo -e "${RED}  Secrets belong in secrets.json or .env (both gitignored).${NC}"
  echo ""
  echo "  To bypass (dangerous): git commit --no-verify"
  echo ""
  exit 1
fi

exit 0
